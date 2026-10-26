import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, SqliteProjectToolStore } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageSessions, type LanguageTransport } from '../src/files/language-sessions.ts';
import { safeRelative } from '../src/files/service.ts';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'corral-language-refactor-'));
  const db = openDatabase(':memory:');
  const clock = new FakeClock();
  const tools = new SqliteProjectToolStore(db, clock);
  const target = {
    hostId: 'host',
    projectId: 'default',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 1,
  };
  await writeFile(join(root, 'server.cjs'), '// fixture\n');
  await writeFile(join(root, 'a.ts'), 'const old = 1;\n');
  await writeFile(join(root, 'b.ts'), 'old();\n');
  tools.save('default', 0, {
    checks: [],
    lspServers: [
      {
        id: 'ts',
        name: 'Fixture',
        argv: [process.execPath, 'server.cjs'],
        timeoutMs: 1000,
        languageIds: ['typescript'],
        fileExtensions: ['.ts'],
      },
    ],
  });
  const connection = {
    capabilities: {
      completion: true,
      definition: true,
      references: true,
      diagnostics: true,
      diagnosticPull: false,
      rename: true,
      codeActions: true,
      triggerCharacters: [],
    },
    sync: vi.fn(async () => {}),
    closeDocument: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    query: vi.fn(async () => []),
    propose: vi.fn(
      async () =>
        [] as {
          title: string;
          edit?: unknown;
          unsupported?: 'command' | 'disabled' | 'no_edit' | 'resource_operation';
        }[],
    ),
  };
  let publish!: Parameters<LanguageTransport['start']>[0]['onDiagnostics'];
  const broker = new LanguageSessions({
    clock,
    timers: clock,
    tools,
    operations: new WorkbenchOperations(db, clock),
    context: (_sessionId, expected) => {
      if (expected) expect(expected).toEqual(target);
      return { target, path: root, trusted: true, closing: false };
    },
    safePath: safeRelative,
    plainPath: async (root, path) => ((await stat(join(root, path))).isFile() ? 'file' : 'other'),
    read: (root, path) => readFile(join(root, path), 'utf8'),
    transport: {
      start: async (input) => {
        publish = input.onDiagnostics;
        return connection;
      },
    },
  });
  cleanups.push(async () => {
    await broker.stopCopy('session');
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const inspect = await broker.inspect('session', { target, serverId: 'ts' });
  await broker.start('session', {
    target,
    requestId: 'language_1',
    clientId: 'client',
    serverId: 'ts',
    configRevision: inspect.configRevision,
    fingerprint: inspect.fingerprint,
    trust: true,
  });
  const scope = { target, generation: 'language_1', clientId: 'client', path: 'a.ts', version: 1 };
  await broker.sync('session', {
    ...scope,
    kind: 'sync',
    languageId: 'typescript',
    text: await readFile(join(root, 'a.ts'), 'utf8'),
  });
  await broker.sync('session', {
    ...scope,
    path: 'b.ts',
    version: 3,
    kind: 'sync',
    languageId: 'typescript',
    text: await readFile(join(root, 'b.ts'), 'utf8'),
  });
  const uri = (path: string) => pathToFileURL(join(root, path)).href;
  const range = (start: number, end: number) => ({
    start: { line: 0, character: start },
    end: { line: 0, character: end },
  });
  const edits = {
    documentChanges: [
      {
        textDocument: { uri: uri('a.ts'), version: 1 },
        edits: [{ range: range(6, 9), newText: 'next' }],
      },
      {
        textDocument: { uri: uri('b.ts'), version: 3 },
        edits: [{ range: range(0, 3), newText: 'next' }],
      },
    ],
  };
  return { broker, connection, scope, root, edits, publish, uri };
}

it('stages saved multi-document refactors with captured versions and leaves commands unavailable', async () => {
  const s = await fixture();
  s.connection.propose.mockResolvedValueOnce([
    { title: 'Rename', edit: s.edits },
    { title: 'Run command', unsupported: 'command' },
  ]);
  const result = await s.broker.propose('session', {
    ...s.scope,
    kind: 'rename',
    position: { line: 0, character: 6 },
    newName: 'next',
  });
  expect(result.source).toMatchObject({
    generation: 'language_1',
    clientId: 'client',
    serverId: 'ts',
    configRevision: 1,
    path: 'a.ts',
    version: 1,
  });
  expect(result.actions[0]?.files).toMatchObject([
    { path: 'a.ts', after: 'const next = 1;\n' },
    { path: 'b.ts', after: 'next();\n' },
  ]);
  expect(result.unavailable).toEqual([{ title: 'Run command', reason: 'command' }]);
  expect(await readFile(join(s.root, 'a.ts'), 'utf8')).toBe('const old = 1;\n');
  const hint = {
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
    message: 'Missing name',
    code: 2304,
  };
  s.publish(s.uri('a.ts'), undefined, [hint]);
  await vi.waitFor(async () =>
    expect((await s.broker.state('session')).session?.diagnostics).toContainEqual({
      path: 'a.ts',
      documentVersion: null,
      diagnostics: [hint],
    }),
  );
  s.publish(s.uri('a.ts'), 99, [{ ...hint, code: 9999 }]);
  s.publish(s.uri('b.ts'), 3, [
    {
      ...hint,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      code: 7777,
    },
  ]);
  await s.broker.propose('session', { ...s.scope, kind: 'code_actions', range: hint.range });
  expect(s.connection.propose).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'code_actions', diagnostics: [hint] }),
    undefined,
  );
  expect(
    (await s.broker.state('session')).session?.diagnostics.find((item) => item.path === 'a.ts'),
  ).toMatchObject({ documentVersion: null, diagnostics: [hint] });

  const guard = await s.broker.assertRefactorSource('session', result.source, s.scope.target, [
    'a.ts',
    'b.ts',
  ]);
  await writeFile(join(s.root, 'a.ts'), 'const next = 1;\n');
  expect(guard).not.toThrow();
  await writeFile(join(s.root, 'a.ts'), 'const old = 1;\n');
  await s.broker.sync('session', {
    ...s.scope,
    path: 'b.ts',
    version: 4,
    kind: 'sync',
    languageId: 'typescript',
    text: 'unsaved();\n',
  });
  expect(guard).toThrow(/changed/);
  await expect(
    s.broker.assertRefactorSource('session', result.source, s.scope.target, ['a.ts', 'b.ts']),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('rejects dirty source or affected buffers and discards a response after another document changes', async () => {
  const s = await fixture();
  const input = {
    ...s.scope,
    kind: 'rename' as const,
    position: { line: 0, character: 6 },
    newName: 'next',
  };
  await expect(
    s.broker.propose('session', input, { aborted: true, onCancel: () => () => {} }),
  ).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
  await writeFile(join(s.root, 'a.ts'), 'external();\n');
  await expect(s.broker.propose('session', input)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  expect(s.connection.propose).not.toHaveBeenCalled();
  await writeFile(join(s.root, 'a.ts'), 'const old = 1;\n');
  await writeFile(join(s.root, 'b.ts'), 'external();\n');
  s.connection.propose.mockResolvedValueOnce([{ title: 'Rename', edit: s.edits }]);
  await expect(s.broker.propose('session', input)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  await writeFile(join(s.root, 'b.ts'), 'old();\n');
  let resolve!: (actions: { title: string; edit: unknown }[]) => void;
  s.connection.propose.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = s.broker.propose('session', input);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await s.broker.sync('session', {
    ...s.scope,
    path: 'b.ts',
    version: 4,
    kind: 'sync',
    languageId: 'typescript',
    text: 'dirty();\n',
  });
  resolve([{ title: 'Rename', edit: s.edits }]);
  await expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
