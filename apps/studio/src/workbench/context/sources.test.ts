import { webcrypto } from 'node:crypto';
import type { FileDocument, TextAttachmentProvenance } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { afterEach, expect, it, vi } from 'vitest';
import { captureDocumentAttachment } from './documents.ts';
import { readAttachmentSource, recaptureAttachmentSource } from './sources.ts';

const fixture = vi.hoisted(() => ({ entry: undefined as unknown }));
vi.mock('../documents/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../documents/store.ts')>();
  return {
    ...actual,
    documentStore: () => ({
      getState: () => ({
        documents: fixture.entry
          ? {
              [actual.documentKey(
                {
                  hostId: 'host',
                  projectId: 'project',
                  sessionId: 'session',
                  bindingId: 'binding',
                  copyGeneration: 1,
                },
                'file.ts',
              )]: fixture.entry,
            }
          : {},
      }),
    }),
  };
});
afterEach(() => {
  fixture.entry = undefined;
  vi.unstubAllGlobals();
});
const target = {
  hostId: 'host',
  projectId: 'project',
  sessionId: 'session',
  bindingId: 'binding',
  copyGeneration: 1,
};

it('preview captures retain frozen bytes while checking only the live lease and exact copy', async () => {
  const source: TextAttachmentProvenance = {
    kind: 'preview',
    target,
    leaseId: 'preview',
    operationId: 'task',
    url: 'http://127.0.0.2:4318/nested/page',
    capturedAt: '2026-10-23T00:00:00.000Z',
    pageRevision: 2,
    sourceRevision: null,
  };
  const item = createTextAttachment('preview.txt', 'text/plain', 'frozen page observation', source);
  const copy = { ...target, missing: false, removedAt: null };
  const lease = {
    leaseId: 'preview',
    sessionId: target.sessionId,
    operationId: 'task',
    url: 'http://127.0.0.2:4318/',
    origin: 'http://127.0.0.2:4318',
    state: 'ready',
  };
  const workspaces = {
    worktree: vi.fn(async () => copy),
    binding: vi.fn(async () => ({
      bindingId: target.bindingId,
      projectId: target.projectId,
      missing: false,
    })),
    previews: vi.fn(async () => [lease]),
  };
  const services = { workspaceId: 'host', mode: 'server', workspaces } as never;
  expect(await readAttachmentSource(services, item)).toEqual({
    state: 'current',
    applies: 'unknown',
    current: item,
  });
  copy.copyGeneration = 2;
  expect((await readAttachmentSource(services, item)).state).toBe('unavailable');
  copy.copyGeneration = 1;
  workspaces.previews.mockResolvedValueOnce([]);
  expect((await readAttachmentSource(services, item)).state).toBe('unavailable');
  lease.origin = 'http://127.0.0.2:4319';
  expect((await readAttachmentSource(services, item)).state).toBe('unavailable');
  vi.clearAllMocks();
  expect(await recaptureAttachmentSource(services, item)).toBeNull();
  expect(workspaces.worktree).not.toHaveBeenCalled();
  expect(workspaces.binding).not.toHaveBeenCalled();
  expect(workspaces.previews).not.toHaveBeenCalled();
  expect(item.text).toBe('frozen page observation');
});

it('inspection uses an exact target and dirty buffer bytes, never an old generation as a substitute', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const entry = {
    target,
    path: 'file.ts',
    text: 'draft text',
    baseHash: 'a'.repeat(64),
    editVersion: 3,
    dirty: true,
    saving: false,
    pendingSave: null,
  };
  const item = await captureDocumentAttachment(entry, {
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 6,
  });
  const file: FileDocument = {
    target,
    path: 'file.ts',
    content: { kind: 'text', text: 'saved text' },
    version: { sha256: 'a'.repeat(64), bytes: 10, encoding: 'utf-8', bom: false, eol: 'none' },
    writable: true,
  };
  const readDocument = vi.fn(async () => file);
  const services = { workspaceId: 'host', mode: 'server', workspaces: { readDocument } } as never;
  fixture.entry = entry;
  expect((await readAttachmentSource(services, item)).state).toBe('current');
  fixture.entry = { ...entry, text: 'other draft' };
  expect((await readAttachmentSource(services, item)).state).toBe('stale');
  file.target = { ...target, copyGeneration: 2 };
  expect((await readAttachmentSource(services, item)).state).toBe('unavailable');
  expect(item.text).toBe('draft');
});

it('immutable hunk and check reads retain exact source identity and displayed output', async () => {
  const from = 'a'.repeat(40),
    to = 'b'.repeat(40),
    patchHash = 'c'.repeat(64),
    hunkId = 'd'.repeat(64);
  const hunk = createTextAttachment('changes.patch', 'text/plain', 'selected patch', {
    kind: 'hunk',
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    from,
    to,
    path: 'file.ts',
    patchHash,
    hunkIds: [hunkId],
  });
  const check = createTextAttachment('check.txt', 'text/plain', 'displayed output', {
    kind: 'check',
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    verificationId: 'verification',
    commandId: 'test',
    tree: to,
    outputHash: 'f'.repeat(64),
  });
  const hunks = vi.fn(async () => ({
    from,
    to,
    path: 'file.ts',
    patchHash,
    hunks: [
      { id: hunkId, patch: 'selected patch' },
      { id: 'e'.repeat(64), patch: 'unselected patch' },
    ],
  }));
  const verifications = vi.fn(async () => [
    {
      verificationId: 'verification',
      commandId: 'test',
      tree: to,
      state: 'failed',
      output: 'displayed output',
      report: {
        sessionId: 'session',
        verificationId: 'verification',
        state: 'completed',
        configRevision: 1,
        fingerprint: '1'.repeat(64),
        output: { text: 'RAW_PRIVATE', hash: 'f'.repeat(64), truncated: false },
      },
    },
  ]);
  const services = {
    workspaceId: 'host',
    mode: 'server',
    workspaces: { hunks, verifications },
  } as never;
  const hunkRead = await readAttachmentSource(services, hunk);
  expect(hunkRead.state).toBe('current');
  expect(hunkRead.current?.text).toBe('selected patch');
  expect(hunks).toHaveBeenCalledWith('session', { from, to, path: 'file.ts' });
  const checkRead = await readAttachmentSource(services, check);
  expect(checkRead.state).toBe('current');
  expect(checkRead.current?.text).toBe('displayed output');
  expect(JSON.stringify(checkRead)).not.toContain('RAW_PRIVATE');
  expect((await recaptureAttachmentSource(services, check))?.provenance).toMatchObject({
    outputHash: 'f'.repeat(64),
  });
  expect(
    (
      await readAttachmentSource(
        { ...(services as object), workspaceId: 'elsewhere' } as never,
        hunk,
      )
    ).state,
  ).toBe('unavailable');
});

it('a frozen hunk or check can still be read while it no longer applies to the copy', async () => {
  const from = 'a'.repeat(40),
    to = 'b'.repeat(40),
    later = 'c'.repeat(40),
    patchHash = 'c'.repeat(64),
    hunkId = 'd'.repeat(64);
  const hunk = createTextAttachment('changes.patch', 'text/plain', 'selected patch', {
    kind: 'hunk',
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    from,
    to,
    path: 'file.ts',
    patchHash,
    hunkIds: [hunkId],
  });
  const check = createTextAttachment('check.txt', 'text/plain', 'output', {
    kind: 'check',
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    verificationId: 'verification',
    commandId: 'test',
    tree: to,
  });
  const now = { to, after: 'same' };
  const result = { stale: false, configChanged: false };
  const workspaces = {
    hunks: vi.fn(async () => ({
      from,
      to,
      path: 'file.ts',
      patchHash,
      hunks: [{ id: hunkId, patch: 'selected patch' }],
    })),
    changes: vi.fn(async () => ({ from, to: now.to, unavailable: null, files: [] })),
    fileVersions: vi.fn(async () => ({
      path: 'file.ts',
      before: { kind: 'text', text: 'same' },
      after: { kind: 'text', text: now.after },
    })),
    verifications: vi.fn(async () => [
      {
        verificationId: 'verification',
        commandId: 'test',
        tree: to,
        state: 'passed',
        output: 'output',
        report: null,
        ...result,
      },
    ]),
  };
  const services = { workspaceId: 'host', mode: 'server', workspaces } as never;
  expect(await readAttachmentSource(services, hunk)).toMatchObject({
    state: 'current',
    applies: 'yes',
  });
  // The copy moved on, but not in this file.
  now.to = later;
  expect(await readAttachmentSource(services, hunk)).toMatchObject({
    state: 'current',
    applies: 'yes',
  });
  expect(workspaces.fileVersions).toHaveBeenLastCalledWith('session', to, later, 'file.ts');
  now.after = 'edited since';
  expect(await readAttachmentSource(services, hunk)).toMatchObject({
    state: 'current',
    applies: 'files_changed',
  });
  workspaces.changes.mockRejectedValueOnce(new Error('offline'));
  expect(await readAttachmentSource(services, hunk)).toMatchObject({
    state: 'current',
    applies: 'unknown',
  });
  expect(await readAttachmentSource(services, check)).toMatchObject({
    state: 'current',
    applies: 'yes',
  });
  result.stale = true;
  expect(await readAttachmentSource(services, check)).toMatchObject({
    state: 'current',
    applies: 'files_changed',
  });
  result.stale = false;
  result.configChanged = true;
  expect(await readAttachmentSource(services, check)).toMatchObject({
    state: 'current',
    applies: 'config_changed',
  });
});
