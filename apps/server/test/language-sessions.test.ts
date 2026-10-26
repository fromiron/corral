import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import type { LanguageConnection } from '../src/files/language-connection.ts';
import { WorkspaceService } from '../src/files/service.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-language-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', '-b', 'main', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', ...args], {
      cwd: original,
    });
  writeFileSync(join(original, 'a.ts'), 'const value = 1;\n');
  writeFileSync(join(original, 'b.ts'), 'export const other = 2;\n');
  writeFileSync(join(original, 'server.cjs'), '// explicit fixture\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const connection = {
    capabilities: {
      completion: true,
      definition: true,
      references: true,
      rename: true,
      codeActions: true,
      diagnostics: true,
      diagnosticPull: true,
      triggerCharacters: ['.'],
    },
    sync: vi.fn(async () => {}),
    closeDocument: vi.fn(async () => {}),
    query: vi.fn(async () => [{ label: 'value', insertText: 'value' }]),
    propose: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
  let callbacks: Parameters<typeof LanguageConnection.start>[0];
  const launch = vi.fn(async (input: typeof callbacks) => {
    callbacks = input;
    input.onSpawn({
      pid: 123,
      sessionId: 123,
      bootId: 'previous-boot',
      startTicks: '1',
      owner: input.owner,
    });
    return connection;
  });
  const make = () =>
    new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host',
      allowSharedDevelopment: true,
      language: { start: launch },
    });
  let service = make();
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const config = service.configureProjectTools('default', 0, {
    checks: [],
    lspServers: [
      {
        id: 'ts',
        name: 'Fixture TS',
        argv: [process.execPath, 'server.cjs'],
        timeoutMs: 5000,
        languageIds: ['typescript'],
        fileExtensions: ['.ts'],
      },
    ],
  });
  const copy = await service.createWorktree('s1', 'default');
  const target = {
    hostId: 'host',
    projectId: 'default',
    bindingId: copy.bindingId,
    sessionId: 's1',
    copyGeneration: copy.copyGeneration,
  };
  const path = join(root, 'copies', copy.bindingId, 's1');
  const inspected = await service.inspectLanguage('s1', { target, serverId: 'ts' });
  const start = {
    target,
    serverId: 'ts',
    clientId: 'client',
    requestId: 'lang_1',
    configRevision: config.revision,
    fingerprint: inspected.fingerprint,
    trust: true,
  };
  const scope = { target, generation: 'lang_1', clientId: 'client', path: 'a.ts', version: 1 };
  return {
    get service() {
      return service;
    },
    restart: () => {
      service = make();
    },
    connection,
    launch,
    get callbacks() {
      return callbacks;
    },
    target,
    start,
    scope,
    path,
    original,
    config,
  };
}

it('explicitly starts once, synchronizes a dirty buffer and keeps save/shared mode available', async () => {
  const s = await setup();
  expect((await s.service.languageState('s1')).session).toBeNull();
  expect(s.launch).not.toHaveBeenCalled();
  const started = await s.service.startLanguage('s1', s.start);
  expect(started).toMatchObject({ generation: 'lang_1', state: 'running' });
  expect(await s.service.startLanguage('s1', s.start)).toEqual(started);
  expect(s.launch).toHaveBeenCalledTimes(1);
  const change = {
    ...s.scope,
    kind: 'sync' as const,
    languageId: 'typescript',
    text: 'const value = 42;\n',
  };
  await s.service.syncLanguage('s1', change);
  await s.service.syncLanguage('s1', change);
  expect(s.connection.sync).toHaveBeenCalledTimes(1);
  expect(
    (
      await s.service.queryLanguage('s1', {
        ...s.scope,
        operation: 'completion',
        position: { line: 0, character: 6 },
      })
    ).result,
  ).toEqual({ kind: 'completion', items: [{ label: 'value', insertText: 'value' }] });
  await s.service.startDevelopment('s1', { target: s.target, operationId: 'dev' });
  expect(
    await s.service.changeDocument('s1', {
      target: s.target,
      operationId: 'save',
      kind: 'save',
      path: 'a.ts',
      baseHash: hash('const value = 1;\n'),
      text: change.text,
      editVersion: 1,
    }),
  ).toMatchObject({ state: 'succeeded' });
  expect(await s.service.finishDevelopment('s1', 'dev', s.target)).toMatchObject({
    operation: null,
  });
  expect(readFileSync(join(s.original, 'a.ts'), 'utf8')).toBe('const value = 1;\n');
  await s.service.stopLanguage('s1', { target: s.target, generation: s.scope.generation });
  expect(s.connection.close).toHaveBeenCalledTimes(1);
  await expect(s.service.startLanguage('s1', s.start)).rejects.toMatchObject({
    code: 'TARGET_TERMINAL',
  });
});

it('rejects stale scopes, unsafe documents and unsupported completion effects; late queries never apply', async () => {
  const s = await setup();
  await s.service.startLanguage('s1', s.start);
  const change = {
    ...s.scope,
    kind: 'sync' as const,
    languageId: 'typescript',
    text: 'const value = 42;\n',
  };
  await s.service.syncLanguage('s1', change);
  await expect(
    s.service.syncLanguage('s1', { ...change, text: 'different' }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    s.service.syncLanguage('s1', { ...change, clientId: 'other' }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    s.service.syncLanguage('s1', { ...change, path: '../outside.ts' }),
  ).rejects.toBeDefined();
  symlinkSync(join(s.original, 'a.ts'), join(s.path, 'link.ts'));
  await expect(s.service.syncLanguage('s1', { ...change, path: 'link.ts' })).rejects.toMatchObject({
    code: 'CAPABILITY_DENIED',
  });
  await expect(
    s.service.startLanguage('s1', { ...s.start, requestId: 'another', clientId: 'other' }),
  ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
  s.connection.query.mockResolvedValueOnce([
    { label: 'unsafe', insertText: 'unsafe', command: { command: 'run' } },
    { label: 'safe', insertText: 'safe' },
  ] as never);
  expect(
    (
      await s.service.queryLanguage('s1', {
        ...s.scope,
        operation: 'completion',
        position: { line: 0, character: 6 },
      })
    ).result,
  ).toEqual({ kind: 'completion', items: [{ label: 'safe', insertText: 'safe' }] });
  let resolve!: (value: unknown) => void;
  s.connection.query.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const pending = s.service.queryLanguage('s1', {
    ...s.scope,
    operation: 'definition',
    position: { line: 0, character: 6 },
  });
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await s.service.syncLanguage('s1', {
    ...change,
    path: 'b.ts',
    text: 'export const changed = 3;\n',
  });
  resolve([]);
  await expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  s.callbacks.onDiagnostics(pathToFileURL(join(s.path, 'a.ts')).href, 0, []);
  s.callbacks.onDiagnostics(pathToFileURL(join(s.path, 'a.ts')).href, undefined, []);
  await vi.waitFor(async () =>
    expect((await s.service.languageState('s1')).session?.diagnostics).toEqual([
      { path: 'a.ts', documentVersion: null, diagnostics: [] },
    ]),
  );
});

it('invalidates config/trust, stops before removal and retains failed state without automatic restart', async () => {
  const s = await setup();
  await s.service.startLanguage('s1', s.start);
  s.callbacks.onFailure(new Error('server crashed'));
  await vi.waitFor(async () =>
    expect((await s.service.languageState('s1')).session).toMatchObject({ state: 'failed' }),
  );
  expect(s.launch).toHaveBeenCalledTimes(1);
  await s.service.stopLanguage('s1', { target: s.target, generation: s.scope.generation });
  await s.service.startLanguage('s1', { ...s.start, requestId: 'lang_2' });
  s.service.configureProjectTools('default', s.config.revision, {
    checks: [],
    lspServers: s.config.lspServers,
  });
  await vi.waitFor(() => expect(s.connection.close).toHaveBeenCalledTimes(2));
  await expect(
    s.service.syncLanguage('s1', {
      ...s.scope,
      generation: 'lang_2',
      kind: 'sync',
      languageId: 'typescript',
      text: 'dirty',
    }),
  ).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
  await s.service.stopLanguage('s1', { target: s.target, generation: 'lang_2' });
  const inspect = await s.service.inspectLanguage('s1', { target: s.target, serverId: 'ts' });
  await s.service.startLanguage('s1', {
    ...s.start,
    requestId: 'lang_3',
    configRevision: inspect.configRevision,
    fingerprint: inspect.fingerprint,
    trust: true,
  });
  await s.service.configure('default', { trusted: false });
  expect(await s.service.languageState('s1')).toMatchObject({
    available: false,
    unavailableReason: 'untrusted',
    session: { state: 'failed' },
  });
  await s.service.removeWorktree('s1', s.target.copyGeneration);
  expect(s.connection.close).toHaveBeenCalledTimes(3);
});

// Recovery uses the existing attested-session cleanup; a different boot proves the fixture process is gone.
it('restores an uncertain passive owner after a host restart and requires explicit recovery', async () => {
  const s = await setup();
  await s.service.startLanguage('s1', s.start);
  s.restart();
  expect((await s.service.languageState('s1')).session).toMatchObject({
    generation: 'lang_1',
    state: 'uncertain',
  });
  expect(s.service.hasPendingProcesses()).toBe(true);
  await expect(
    s.service.startLanguage('s1', { ...s.start, requestId: 'lang_2' }),
  ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
  await s.service.stopLanguage('s1', { target: s.target, generation: 'lang_1' });
  expect(await s.service.startLanguage('s1', { ...s.start, requestId: 'lang_2' })).toMatchObject({
    state: 'running',
  });
  expect(s.launch).toHaveBeenCalledTimes(2);
  await s.service.removeWorktree('s1', s.target.copyGeneration);
  expect(s.connection.close).toHaveBeenCalledTimes(1);
});
