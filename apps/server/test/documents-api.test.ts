import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import type { DocumentCommand } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { type CorralServer, startCorralServer } from '../src/index.ts';

// Match the existing real-Git file suite; this is a runaway limit, not a latency assertion.
vi.setConfig({ testTimeout: 30_000 });

const servers: CorralServer[] = [];
const directories: string[] = [];
const initial = '\ufefffirst line\r\nsecond line\r\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'corral-documents-api-'));
  directories.push(root);
  const original = join(root, 'original');
  mkdirSync(original);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { cwd: original },
    );
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(original, 'source.txt'), initial);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const token = 'documents-bootstrap-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  servers.push(server);
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  expect(login.status).toBe(204);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const browserFetch: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    headers.set('origin', server.url);
    return fetch(input, { ...init, headers });
  };
  const options = { baseUrl: server.url, fetch: browserFetch };
  const api = new WorkspacesApi(options);
  const repository = new RestCorralRepository(options);
  await api.bind('default', original);
  await api.configure('default', { trusted: true });
  const created = await repository.createSession({
    projectId: 'default',
    title: 'Document fixture',
  });
  if (!created.ok) throw new Error(created.message);
  const sessionId = created.session.sessionId;
  await api.createWorktree(sessionId);
  const hostId = readFileSync(join(root, 'workspace', '.corral', 'workspace-id'), 'utf8').trim();
  return { api, server, sessionId, original, hostId };
}

it('[TC-WBD-002-H] reads and saves through the actual client and recovers the same receipt after a duplicate request', async () => {
  const { api, sessionId, original, hostId } = await fixture();
  const before = await api.readDocument(sessionId, 'source.txt');
  expect(before).toMatchObject({
    path: 'source.txt',
    writable: true,
    content: { kind: 'text', text: initial },
    version: {
      sha256: hash(initial),
      bytes: Buffer.byteLength(initial),
      encoding: 'utf-8',
      bom: true,
      eol: 'crlf',
    },
    target: { hostId, projectId: 'default', sessionId, copyGeneration: 1 },
  });
  const text = '\ufeffchanged line\r\n';
  const command: DocumentCommand = {
    operationId: 'document_save',
    kind: 'save',
    target: before.target,
    path: before.path,
    baseHash: before.version?.sha256 ?? null,
    text,
    editVersion: 3,
  };
  const saved = await api.changeDocument(sessionId, command);
  expect(saved).toMatchObject({
    operationId: command.operationId,
    target: before.target,
    state: 'succeeded',
    result: { kind: 'saved', sha256: hash(text), bytes: Buffer.byteLength(text), editVersion: 3 },
  });
  expect(await api.changeDocument(sessionId, command)).toEqual(saved);
  expect(await api.documentOperation(sessionId, command.operationId)).toEqual(saved);
  expect(await api.readDocument(sessionId, before.path)).toMatchObject({
    content: { kind: 'text', text },
    version: { sha256: hash(text), bom: true, eol: 'crlf' },
  });
  expect(readFileSync(join(original, 'source.txt'), 'utf8')).toBe(initial);
  await expect(
    api.changeDocument(sessionId, { ...command, text: 'different request' }),
  ).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
});

it('[TC-WBD-002-N] rejects wrong targets and stale hashes without hiding typed refusal codes', async () => {
  const { api, sessionId } = await fixture();
  const before = await api.readDocument(sessionId, 'source.txt');
  const command: DocumentCommand = {
    operationId: 'document_wrong_host',
    kind: 'save',
    target: { ...before.target, hostId: 'other-host' },
    path: before.path,
    baseHash: before.version?.sha256 ?? null,
    text: 'should not write',
    editVersion: 1,
  };
  await expect(api.changeDocument(sessionId, command)).rejects.toMatchObject({
    status: 409,
    code: 'REVISION_CONFLICT',
  });
  await expect(
    api.changeDocument(sessionId, {
      ...command,
      operationId: 'document_wrong_generation',
      target: { ...before.target, copyGeneration: before.target.copyGeneration + 1 },
    }),
  ).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
  await expect(
    api.changeDocument(sessionId, {
      ...command,
      operationId: 'document_wrong_session',
      target: { ...before.target, sessionId: 'session_elsewhere' },
    }),
  ).rejects.toMatchObject({ status: 400, code: 'SCHEMA_INVALID' });
  await expect(api.documentOperation(sessionId, 'missing_operation')).rejects.toMatchObject({
    status: 404,
    code: 'TARGET_NOT_FOUND',
  });
  const stale = await api.changeDocument(sessionId, {
    ...command,
    operationId: 'document_stale_hash',
    target: before.target,
    baseHash: '0'.repeat(64),
  });
  expect(stale).toMatchObject({
    state: 'failed',
    result: { kind: 'error', code: 'REVISION_CONFLICT' },
  });
  expect(await api.documentOperation(sessionId, stale.operationId)).toEqual(stale);
  expect(await api.readDocument(sessionId, before.path)).toMatchObject({
    content: { kind: 'text', text: initial },
  });
  await api.configure('default', { trusted: false });
  await expect(
    api.changeDocument(sessionId, {
      ...command,
      operationId: 'document_untrusted',
      target: before.target,
    }),
  ).rejects.toMatchObject({ status: 403, code: 'CAPABILITY_DENIED' });
});

it('[TC-WBD-002-H] allows JSON escaping overhead at the one MiB document boundary', async () => {
  const { api, sessionId } = await fixture();
  const empty = await api.readDocument(sessionId, 'new file.txt');
  expect(empty.content).toEqual({ kind: 'absent' });
  const text = '\n'.repeat(1024 * 1024);
  const saved = await api.changeDocument(sessionId, {
    operationId: 'document_escaped_body',
    kind: 'save',
    target: empty.target,
    path: empty.path,
    baseHash: null,
    text,
    editVersion: 1,
  });
  expect(saved).toMatchObject({
    state: 'succeeded',
    result: { kind: 'saved', bytes: 1024 * 1024, sha256: hash(text) },
  });
  expect(await api.readDocument(sessionId, empty.path)).toMatchObject({
    content: { kind: 'text', text },
  });
});

it('[TC-WBD-002-F] returns a bounded generic error without an internal filesystem path', async () => {
  const { api, sessionId } = await fixture();
  vi.spyOn(WorkspaceService.prototype, 'readDocument').mockRejectedValue(
    new Error('EACCES /private/workspace/secret/file.txt'),
  );
  await expect(api.readDocument(sessionId, 'source.txt')).rejects.toMatchObject({
    status: 503,
    code: 'STORAGE_UNAVAILABLE',
    message: 'the document operation failed',
  });
});
