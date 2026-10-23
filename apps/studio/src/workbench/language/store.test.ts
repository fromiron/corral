// @vitest-environment jsdom
import type {
  LanguageDocumentChange,
  LanguageQueryResult,
  LanguageSession,
  LanguageStart,
  LanguageState,
  WorkspaceTarget,
} from '@corral/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { DocumentBuffer, DocumentStore } from '../documents/store.ts';
import { documentKey } from '../documents/store.ts';
import { languageCopyKey, languageStore } from './store.ts';

const target: WorkspaceTarget = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const server = {
  id: 'typescript',
  name: 'TypeScript',
  languageIds: ['typescript'],
  fileExtensions: ['.ts'],
};
const session: LanguageSession = {
  generation: 'language_one',
  clientId: 'client_test',
  serverId: server.id,
  configRevision: 1,
  fingerprint: 'a'.repeat(64),
  state: 'running',
  capabilities: {
    completion: true,
    definition: true,
    references: true,
    diagnostics: true,
    diagnosticPull: false,
    rename: false,
    codeActions: false,
    triggerCharacters: ['.'],
  },
  diagnostics: [],
  error: null,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup() {
  const key = documentKey(target, 'main.ts');
  const model = { getLanguageId: () => 'typescript', uri: { toString: () => key } };
  const entry = {
    key,
    target,
    path: 'main.ts',
    text: 'const value = 1;',
    editVersion: 0,
    model,
  } as unknown as DocumentBuffer;
  const documents = createStore(() => ({ documents: { [key]: entry } })) as DocumentStore;
  let state: LanguageState = {
    target,
    available: true,
    unavailableReason: null,
    servers: [server],
    session: null,
  };
  const api = {
    languageState: vi.fn(async () => state),
    inspectLanguage: vi.fn(async () => ({
      target,
      server: { ...server, argv: ['language-server'], timeoutMs: 1000 },
      configRevision: 1,
      fingerprint: 'a'.repeat(64),
      trusted: false,
    })),
    startLanguage: vi.fn(async (_session: string, _input: LanguageStart) => {
      state = { ...state, session };
      return session;
    }),
    syncLanguage: vi.fn(async (_session: string, _input: LanguageDocumentChange) => state.session!),
    stopLanguage: vi.fn(async () => {
      state = { ...state, session: null };
      return { stopped: true as const };
    }),
    queryLanguage: vi.fn(
      async (): Promise<LanguageQueryResult> => ({
        generation: session.generation,
        documentVersion: 1,
        result: { kind: 'completion', items: [] },
      }),
    ),
  };
  const disposable = (_selector: unknown, _provider: unknown) => ({ dispose: vi.fn() });
  const monaco = {
    Uri: { from: (parts: object) => ({ toString: () => JSON.stringify(parts) }) },
    languages: {
      registerCompletionItemProvider: vi.fn(disposable),
      registerDefinitionProvider: vi.fn(disposable),
      registerReferenceProvider: vi.fn(disposable),
    },
    editor: { setModelMarkers: vi.fn() },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  };
  const owner = languageStore(api, documents, {
    clientId: 'client_test',
    newRequestId: () => 'start_one',
    loadMonaco: async () => monaco as never,
  });
  cleanups.push(() => owner.dispose());
  const edit = (text: string) =>
    documents.setState({
      documents: {
        [key]: {
          ...documents.getState().documents[key]!,
          text,
          editVersion: documents.getState().documents[key]!.editVersion + 1,
        },
      },
    });
  return { api, owner, documents, key, model, monaco, edit };
}
it('[TC-WBD-018-H] shares one session across views and syncs dirty text without saving', async () => {
  const f = setup();
  const first = f.owner.retain(target),
    second = f.owner.retain(target);
  await settle();
  expect(f.api.languageState).toHaveBeenCalledTimes(1);
  await f.owner.inspect(target, server.id);
  await f.owner.start(target, true);
  await settle();
  expect(f.api.startLanguage).toHaveBeenCalledTimes(1);
  expect(f.api.syncLanguage).toHaveBeenCalledWith(
    target.sessionId,
    expect.objectContaining({ kind: 'sync', text: 'const value = 1;', version: 1 }),
  );
  f.edit('const 한글 = "😀";');
  await settle();
  expect(f.api.syncLanguage).toHaveBeenLastCalledWith(
    target.sessionId,
    expect.objectContaining({ kind: 'sync', text: 'const 한글 = "😀";', version: 2 }),
  );
  first();
  second();
  expect(f.api.stopLanguage).not.toHaveBeenCalled();
});
it('[TC-WBD-018-F] drops a late query and old diagnostics after the draft changes', async () => {
  const f = setup();
  f.owner.retain(target);
  await settle();
  await f.owner.inspect(target, server.id);
  await f.owner.start(target, true);
  await settle();
  let finish!: (result: LanguageQueryResult) => void;
  f.api.queryLanguage.mockImplementationOnce(
    () =>
      new Promise<LanguageQueryResult>((resolve) => {
        finish = resolve;
      }),
  );
  const query = f.owner.query(f.key, 'completion', { line: 0, character: 4 });
  await settle();
  f.edit('const changed = true;');
  finish({
    generation: session.generation,
    documentVersion: 1,
    result: { kind: 'completion', items: [{ label: 'old', insertText: 'old' }] },
  });
  expect(await query).toBeNull();
  f.api.languageState.mockResolvedValue({
    target,
    available: true,
    unavailableReason: null,
    servers: [server],
    session: {
      ...session,
      diagnostics: [
        {
          path: 'main.ts',
          documentVersion: 1,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
              message: 'old result',
              severity: 1,
            },
          ],
        },
      ],
    },
  });
  await f.owner.refresh(target);
  expect(f.monaco.editor.setModelMarkers).toHaveBeenLastCalledWith(f.model, expect.any(String), []);
  expect(f.owner.getState().copies[languageCopyKey(target)]?.state?.target).toEqual(target);
});
it('[TC-WBD-018-N] keeps a failed start id for retry and does not sync another client or copy', async () => {
  const f = setup();
  f.owner.retain(target);
  await settle();
  await f.owner.inspect(target, server.id);
  f.api.startLanguage.mockRejectedValueOnce(new Error('response lost'));
  await f.owner.start(target, true);
  await f.owner.start(target, true);
  expect(f.api.startLanguage.mock.calls.map((call) => call[1].requestId)).toEqual([
    'start_one',
    'start_one',
  ]);
  await settle();
  f.api.syncLanguage.mockClear();
  const original = f.documents.getState().documents[f.key]!;
  const other = { ...original, target: { ...target, copyGeneration: 2 }, text: 'other copy' };
  f.documents.setState({ documents: { other } });
  await settle();
  expect(
    f.api.syncLanguage.mock.calls.some(
      ([, change]) => change.kind === 'sync' && change.text === 'other copy',
    ),
  ).toBe(false);
});

it('[TC-WBD-018-F] reopening a file advances its wire version and a late location never navigates after stop', async () => {
  const f = setup();
  f.owner.retain(target);
  await settle();
  await f.owner.inspect(target, server.id);
  await f.owner.start(target, true);
  await settle();
  const entry = f.documents.getState().documents[f.key]!;
  f.documents.setState({ documents: {} });
  await settle();
  f.documents.setState({ documents: { [f.key]: { ...entry, model: { ...f.model } as never } } });
  await settle();
  expect(f.api.syncLanguage).toHaveBeenLastCalledWith(
    target.sessionId,
    expect.objectContaining({ kind: 'sync', version: 2 }),
  );
  f.api.queryLanguage.mockResolvedValueOnce({
    generation: session.generation,
    documentVersion: 2,
    result: {
      kind: 'locations',
      locations: [
        {
          path: 'other.ts',
          sha256: 'b'.repeat(64),
          documentVersion: null,
          range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
        },
      ],
    },
  });
  const provider = f.monaco.languages.registerDefinitionProvider.mock.calls.at(-1)![1] as {
    provideDefinition(
      model: unknown,
      position: unknown,
      token: unknown,
    ): Promise<{ uri: { toString(): string } }[]>;
  };
  const result = await provider.provideDefinition(
    f.documents.getState().documents[f.key]!.model,
    { lineNumber: 1, column: 4 },
    { isCancellationRequested: false },
  );
  let finish!: (key: string) => void;
  f.documents.open = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const open = vi.fn(() => true);
  const moving = f.owner.openLocation(
    f.key,
    result[0]!.uri.toString(),
    { startLine: 1, startColumn: 4, endLine: 1, endColumn: 6 },
    open,
  );
  await settle();
  await f.owner.stop(target);
  const otherKey = documentKey(target, 'other.ts');
  f.documents.setState({
    documents: {
      ...f.documents.getState().documents,
      [otherKey]: {
        ...entry,
        key: otherKey,
        path: 'other.ts',
        dirty: false,
        baseHash: 'b'.repeat(64),
      },
    },
  });
  finish(otherKey);
  expect(await moving).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it('[TC-WBD-021-N] prepares only saved language versions and never refreshes a dirty draft', async () => {
  const f = setup();
  f.owner.retain(target);
  await settle();
  await f.owner.inspect(target, server.id);
  await f.owner.start(target, true);
  await settle();
  f.documents.refresh = vi.fn(async () => {});
  const scope = await f.owner.editScope(f.key);
  expect(scope).toEqual({
    target,
    generation: session.generation,
    clientId: session.clientId,
    path: 'main.ts',
    version: 1,
  });
  f.documents.setState({
    documents: {
      [f.key]: { ...f.documents.getState().documents[f.key]!, dirty: true, text: 'unsaved change' },
    },
  });
  f.documents.refresh = vi.fn(async () => {});
  expect(await f.owner.editScope(f.key)).toBeNull();
  expect(f.documents.refresh).not.toHaveBeenCalled();
  expect(f.documents.getState().documents[f.key]?.text).toBe('unsaved change');
});
