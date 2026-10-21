import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ApiError } from '@corral/client';
import type { DocumentOperation, FileDocument } from '@corral/contracts';
import { Gate } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import type { RecoveryDraft, RecoveryStorage, SaveCommand } from './recovery.ts';
import {
  type DocumentClient,
  type DocumentStore,
  type DocumentStoreOptions,
  documentStore,
} from './store.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function file(text = 'before\n', generation = 1): FileDocument {
  return {
    target: {
      hostId: 'host',
      projectId: 'project',
      bindingId: 'binding',
      sessionId: 'session',
      copyGeneration: generation,
    },
    path: 'example.txt',
    content: { kind: 'text', text },
    writable: true,
    version: {
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
      encoding: 'utf-8',
      bom: text.startsWith('\ufeff'),
      eol: text.includes('\r\n') ? 'crlf' : 'lf',
    },
  };
}
function saved(command: SaveCommand): DocumentOperation {
  return {
    operationId: command.operationId,
    target: command.target,
    kind: 'document.save',
    requestHash: 'request',
    state: 'succeeded',
    createdAt: 'now',
    updatedAt: 'now',
    result: {
      kind: 'saved',
      path: command.path,
      sha256: hash(command.text),
      bytes: Buffer.byteLength(command.text),
      editVersion: command.editVersion,
      intent: {
        path: command.path,
        baseHash: command.baseHash,
        submittedHash: hash(command.text),
        editVersion: command.editVersion,
      },
    },
  };
}

class FakeModel {
  private text: string;
  private listeners = new Set<() => void>();
  disposed = false;
  constructor(text: string) {
    this.text = text.replace(/\r\n|\r/g, '\n');
  }
  getValue() {
    return this.text;
  }
  setValue(text: string) {
    this.text = text;
    for (const listener of this.listeners) listener();
  }
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  pushEOL(eol: number) {
    this.setValue(this.text.replace(/\r\n|\r|\n/g, eol === 1 ? '\r\n' : '\n'));
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
function setup(options: DocumentStoreOptions = {}) {
  let disk = file();
  const rows = new Map<string, RecoveryDraft>();
  const recovery: RecoveryStorage = {
    list: async (key) => [...rows.values()].filter((row) => row.documentKey === key),
    listSession: async (target) =>
      [...rows.values()].filter(
        (row) =>
          row.target.hostId === target.hostId &&
          row.target.projectId === target.projectId &&
          row.target.sessionId === target.sessionId,
      ),
    write: async (draft) => {
      rows.set(draft.id, structuredClone(draft));
    },
    remove: async (draft) => {
      if (rows.get(draft.id)?.updatedAt === draft.updatedAt) rows.delete(draft.id);
    },
  };
  const createModel = vi.fn((text: string) => new FakeModel(text));
  const loadMonaco = vi.fn(async () => ({
    Uri: { from: (value: unknown) => value },
    editor: {
      createModel,
      EndOfLinePreference: { TextDefined: 0 },
      EndOfLineSequence: { LF: 0, CRLF: 1 },
    },
  })) as unknown as NonNullable<DocumentStoreOptions['loadMonaco']>;
  const changeDocument = vi.fn(async (_session: string, command: SaveCommand) => {
    disk = file(command.text);
    return saved(command);
  });
  const client: DocumentClient = {
    readDocument: vi.fn(async () => structuredClone(disk)),
    changeDocument: changeDocument as DocumentClient['changeDocument'],
    documentOperation: vi.fn(async () => {
      throw new ApiError(404, 'TARGET_NOT_FOUND', 'No receipt');
    }),
  };
  let sequence = 0;
  let now = 0;
  const store = documentStore(client, {
    recovery,
    loadMonaco,
    clientId: 'renderer',
    newOperationId: () => `save_${++sequence}`,
    now: () => ++now,
    ...options,
  });
  return {
    client,
    store,
    rows,
    recovery,
    createModel,
    changeDocument,
    setDisk: (next: FileDocument) => {
      disk = next;
    },
  };
}
function modelOf(store: DocumentStore, key: string) {
  const model = store.getState().documents[key]?.model;
  assert(model);
  return model;
}
const tick = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

it('[TC-WBD-003-H] shares one document model across views and keeps it through detachment', async () => {
  const s = setup();
  const key = await s.store.open('session', 'example.txt');
  expect(await s.store.open('session', './example.txt')).toBe(key);
  expect(s.createModel).toHaveBeenCalledTimes(1);
  const detachOne = s.store.retainView(key, 'one');
  s.store.retainView(key, 'two');
  const model = modelOf(s.store, key);
  model.setValue('draft');
  expect(await s.store.closeView(key, 'two')).toBe('closed');
  detachOne();
  expect(s.store.getState().documents[key]?.text).toBe('draft');
  s.store.retainView(key, 'again');
  expect(await s.store.closeView(key, 'again')).toBe('confirm');
  expect(await s.store.closeView(key, 'again', 'cancel')).toBe('cancelled');
  expect(await s.store.closeView(key, 'again', 'discard')).toBe('closed');
  expect(s.store.getState().documents[key]).toBeUndefined();
  s.store.dispose();
});

it('[TC-WBD-003-N] a late save acknowledges only its submitted text and cannot close newer edits', async () => {
  const s = setup();
  const gate = new Gate();
  s.changeDocument.mockImplementationOnce(async (_session, command) => {
    await gate.wait();
    return saved(command);
  });
  const key = await s.store.open('session', 'example.txt');
  s.store.retainView(key, 'view');
  modelOf(s.store, key).setValue('submitted');
  const close = s.store.closeView(key, 'view', 'save');
  modelOf(s.store, key).setValue('newer draft');
  gate.open();
  expect(await close).toBe('confirm');
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'newer draft',
    baseText: 'submitted',
    baseHash: hash('submitted'),
    dirty: true,
    pendingSave: null,
  });
  s.store.dispose();
});

it('[TC-WBD-003-F] response loss uses receipt GET; a missing receipt allows only explicit same-ID retry', async () => {
  const s = setup();
  s.changeDocument.mockRejectedValueOnce(new TypeError('Network lost'));
  const key = await s.store.open('session', 'example.txt');
  modelOf(s.store, key).setValue('draft');
  expect(await s.store.save(key)).toBe(false);
  const submitted = s.changeDocument.mock.calls[0]?.[1];
  assert(submitted);
  expect(await s.store.checkSave(key)).toBe(false);
  expect(s.changeDocument).toHaveBeenCalledTimes(1);
  expect(s.store.getState().documents[key]?.canRetrySave).toBe(true);
  expect(await s.store.save(key)).toBe(true);
  expect(s.changeDocument.mock.calls[1]?.[1]).toEqual(submitted);
  expect(s.store.getState().documents[key]?.dirty).toBe(false);
  s.store.dispose();
});

it('[TC-WBD-003-N] late refresh keeps a newer edit and explicit conflict resolution preserves ours until saved', async () => {
  const s = setup();
  const key = await s.store.open('session', 'example.txt');
  const gate = new Gate();
  vi.mocked(s.client.readDocument).mockImplementationOnce(async () => {
    await gate.wait();
    return file('external');
  });
  const refresh = s.store.refresh(key);
  modelOf(s.store, key).setValue('ours');
  gate.open();
  await refresh;
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'ours',
    baseText: 'before\n',
    dirty: true,
    conflict: { content: { text: 'external' } },
  });
  expect(s.store.resolveConflict(key, 'ours')).toBe(true);
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'ours',
    baseText: 'external',
    baseHash: hash('external'),
    dirty: true,
    conflict: null,
  });
  s.setDisk(file('other generation', 2));
  await s.store.refresh(key);
  expect(s.store.resolveConflict(key, 'ours')).toBe(false);
  s.store.dispose();
});

it('[TC-WBD-003-N] reopening from the refreshed file list updates a clean document and preserves a dirty draft', async () => {
  const s = setup();
  const key = await s.store.open('session', 'example.txt');
  const model = modelOf(s.store, key);
  s.setDisk(file('external'));
  expect(await s.store.open('session', 'example.txt')).toBe(key);
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'external',
    baseHash: hash('external'),
    dirty: false,
    model,
  });
  model.setValue('ours');
  s.setDisk(file('another edit'));
  await s.store.open('session', 'example.txt');
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'ours',
    baseText: 'external',
    dirty: true,
    conflict: { content: { text: 'another edit' } },
  });
  s.store.dispose();
});

it('[TC-WBD-003-F] recovery keeps memory on quota failure and offers exact-identity stale drafts explicitly', async () => {
  const s = setup();
  const key = await s.store.open('session', 'example.txt');
  s.recovery.write = async () => {
    throw new Error('quota exceeded');
  };
  modelOf(s.store, key).setValue('ours');
  await tick();
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'ours',
    dirty: true,
    recoveryError: expect.any(String),
  });
  const draft: RecoveryDraft = {
    version: 1,
    id: 'candidate',
    clientId: 'other',
    documentKey: key,
    target: file().target,
    path: 'example.txt',
    text: 'recovered',
    baseText: 'older',
    baseHash: hash('older'),
    editVersion: 4,
    pendingSave: null,
    formatBlocked: false,
    updatedAt: 1,
  };
  s.rows.set(draft.id, draft);
  await s.store.refresh(key);
  expect(s.store.getState().documents[key]?.text).toBe('ours');
  await s.store.restoreRecovery(key, 'candidate');
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'ours',
    error: expect.any(String),
  });
  s.store.retainView(key, 'view');
  expect(await s.store.closeView(key, 'view', 'discard')).toBe('closed');
  await s.store.open('session', 'example.txt');
  await s.store.restoreRecovery(key, 'candidate');
  expect(s.store.getState().documents[key]).toMatchObject({
    text: 'recovered',
    baseText: 'older',
    dirty: true,
    conflict: { content: { text: 'before\n' } },
  });
  expect(s.rows.has('candidate')).toBe(true);
  s.store.dispose();
});

it('[TC-WBD-003-N] mixed EOL stays raw until explicit conversion and model failure preserves readable content', async () => {
  const s = setup();
  const raw = '\ufeffone\r\ntwo\nthree\r';
  const mixed = file(raw);
  assert(mixed.version);
  s.setDisk({ ...mixed, version: { ...mixed.version, eol: 'mixed' } });
  const key = await s.store.open('session', 'example.txt');
  expect(s.store.getState().documents[key]).toMatchObject({
    text: raw,
    baseText: raw,
    dirty: false,
    formatBlocked: true,
  });
  s.store.convertEol(key, 'crlf');
  expect(s.store.getState().documents[key]).toMatchObject({
    text: '\ufeffone\r\ntwo\r\nthree\r\n',
    dirty: true,
    formatBlocked: false,
  });
  expect(await s.store.save(key)).toBe(true);
  expect(s.changeDocument.mock.calls[0]?.[1].text).toBe('\ufeffone\r\ntwo\r\nthree\r\n');
  const failed = setup({
    loadMonaco: async () => {
      throw new Error('worker unavailable');
    },
  });
  const failedKey = await failed.store.open('session', 'example.txt');
  expect(failed.store.getState().documents[failedKey]).toMatchObject({
    text: 'before\n',
    model: null,
    modelError: expect.any(String),
  });
  s.store.dispose();
  failed.store.dispose();
});

it('[TC-WBD-003-N] lists an old generation draft read-only after a renderer restart', async () => {
  const s = setup();
  const oldKey = await s.store.open('session', 'example.txt');
  modelOf(s.store, oldKey).setValue('old copy draft');
  await tick();
  s.store.dispose();
  s.setDisk(file('new copy', 2));
  const restarted = documentStore(s.client, {
    recovery: s.recovery,
    clientId: 'new_renderer',
    loadMonaco: async () => {
      throw new Error('fallback');
    },
  });
  expect(await restarted.sessionRecoveries(file().target)).toEqual([
    expect.objectContaining({ documentKey: oldKey, text: 'old copy draft' }),
  ]);
  expect(restarted.getState().documents).toEqual({});
  const key = await restarted.open('session', 'example.txt');
  expect(restarted.getState().documents[key]?.recoveries).toHaveLength(0);
  expect(restarted.getState().documents[key]?.otherRecoveries).toEqual([
    expect.objectContaining({ documentKey: oldKey, text: 'old copy draft' }),
  ]);
  const candidate = restarted.getState().documents[key]?.otherRecoveries[0];
  assert(candidate);
  await restarted.restoreRecovery(key, candidate.id);
  expect(restarted.getState().documents[key]?.text).toBe('new copy');
  await restarted.discardRecovery(key, candidate.id);
  expect(restarted.getState().documents[key]?.otherRecoveries).toHaveLength(0);
  restarted.dispose();
});

it('[TC-WBD-003-H] invalidates workspace views exactly once per confirmed save, including receipt recovery and save-on-close', async () => {
  const notifySaved = vi.fn();
  const s = setup({ notifySaved });
  const key = await s.store.open('session', 'example.txt');
  s.store.retainView(key, 'view');
  modelOf(s.store, key).setValue('first');
  s.changeDocument.mockRejectedValueOnce(new TypeError('Network lost'));
  expect(await s.store.save(key)).toBe(false);
  expect(notifySaved).not.toHaveBeenCalled();
  const command = s.changeDocument.mock.calls[0]?.[1];
  assert(command);
  vi.mocked(s.client.documentOperation).mockResolvedValue(saved(command));
  expect(await s.store.checkSave(key)).toBe(true);
  expect(notifySaved).toHaveBeenCalledTimes(1);
  expect(await s.store.checkSave(key)).toBe(false);
  expect(notifySaved).toHaveBeenCalledTimes(1);
  modelOf(s.store, key).setValue('second');
  expect(await s.store.closeView(key, 'view', 'save')).toBe('closed');
  expect(notifySaved).toHaveBeenCalledTimes(2);
  s.store.dispose();
});

it('[TC-WBD-003-N] a missing receipt retries the same command despite a later disk conflict, while uncertain receipts never replay', async () => {
  const s = setup();
  const key = await s.store.open('session', 'example.txt');
  modelOf(s.store, key).setValue('draft');
  s.changeDocument.mockRejectedValueOnce(new TypeError('response lost'));
  await s.store.save(key);
  const command = s.changeDocument.mock.calls[0]?.[1];
  assert(command);
  s.setDisk(file('external'));
  await s.store.refresh(key);
  await s.store.checkSave(key);
  s.changeDocument.mockResolvedValueOnce({
    ...saved(command),
    state: 'failed',
    result: {
      kind: 'error',
      code: 'REVISION_CONFLICT',
      message: 'changed',
      intent: { path: command.path, baseHash: command.baseHash },
    },
  });
  expect(await s.store.save(key)).toBe(false);
  expect(s.changeDocument.mock.calls[1]?.[1]).toEqual(command);
  expect(s.store.getState().documents[key]?.pendingSave).toBeNull();

  s.store.resolveConflict(key, 'ours');
  s.changeDocument.mockImplementationOnce(async (_session, request) => ({
    ...saved(request),
    state: 'uncertain',
  }));
  expect(await s.store.save(key)).toBe(false);
  const calls = s.changeDocument.mock.calls.length;
  expect(await s.store.save(key)).toBe(false);
  expect(s.changeDocument).toHaveBeenCalledTimes(calls);
  s.store.retainView(key, 'view');
  expect(await s.store.closeView(key, 'view', 'discard')).toBe('failed');
  expect(s.store.getState().documents[key]?.pendingSave).not.toBeNull();
  s.store.dispose();
});

it('[TC-WBD-003-F] recovery writes one in-flight snapshot and only the latest pending edit', async () => {
  const s = setup();
  const key = await s.store.open('session', 'example.txt');
  const release = new Gate();
  const acknowledged = new Gate();
  const writes: string[] = [];
  s.recovery.write = async (draft) => {
    writes.push(draft.text);
    if (writes.length === 1) await release.wait();
  };
  const unsubscribe = s.store.subscribe((state) => {
    if (state.documents[key]?.recoverySavedVersion === 3) acknowledged.open();
  });
  modelOf(s.store, key).setValue('one');
  modelOf(s.store, key).setValue('two');
  modelOf(s.store, key).setValue('three');
  expect(writes).toEqual(['one']);
  release.open();
  await acknowledged.wait();
  expect(writes).toEqual(['one', 'three']);
  expect(s.store.getState().documents[key]?.recoverySavedVersion).toBe(3);
  unsubscribe();
  s.store.dispose();
});
