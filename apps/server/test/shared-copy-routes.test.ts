import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeServer, RestCorralRepository, WorkspacesApi } from '@corral/client';
import { SCHEMA_VERSION } from '@corral/contracts';
import { Gate, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// Checkpoint restore on a local host works whenever no agent run writes (workbench.md 공유 개발
// 모드), through the same gate the route uses; its expected-tree check stays. A server without
// sharing refuses it while a task holds the copy, with the refusal's own code (api-contract.md 오류).
vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** A trusted session copy with a checkpoint before an edit, and a task running in it. */
async function setup(shares: boolean, agents = new ScriptedAgentAdapter({ turns: 1 })) {
  const root = mkdtempSync(join(tmpdir(), 'corral-shared-restore-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  writeFileSync(join(original, 'a.txt'), 'one\n');
  writeFileSync(
    join(original, 'package.json'),
    JSON.stringify({ scripts: { serve: 'node server.cjs' } }),
  );
  writeFileSync(
    join(original, 'server.cjs'),
    "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('READY '+s.address().port));\n",
  );
  execFileSync('git', ['add', '.'], { cwd: original });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'first'], {
    cwd: original,
  });
  const token = 'shared-copy-restore-fixture-0123456789ab';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents,
    port: 0,
    allowSharedDevelopment: shares,
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    return fetch(url, { ...init, headers });
  };
  const options = { baseUrl: server.url, fetch: call };
  const repository = new RestCorralRepository(options);
  const workspaces = new WorkspacesApi(options);
  await workspaces.bind('default', original);
  await workspaces.configure('default', { trusted: true });
  const created = await repository.createSession({ projectId: 'default', title: 'Restore' });
  assert(created.ok);
  const sessionId = created.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const checkpoint = await workspaces.captureCheckpoint(sessionId, {
    checkpointId: 'before_edit',
    label: 'Before the edit',
  });
  const document = await workspaces.readDocument(sessionId, 'a.txt');
  expect(
    await workspaces.changeDocument(sessionId, {
      operationId: 'edit',
      kind: 'save',
      target: document.target,
      path: 'a.txt',
      baseHash: hash('one\n'),
      text: 'two\n',
      editVersion: 1,
    }),
  ).toMatchObject({ state: 'succeeded' });
  await workspaces.startTask(sessionId, {
    operationId: 'dev',
    target: document.target,
    script: 'serve',
  });
  const plan = await workspaces.planCheckpointRestore(
    sessionId,
    checkpoint.checkpointId,
    checkpoint.manifestHash ?? '',
  );
  return {
    workspaces,
    sessionId,
    plan,
    health: await probeServer({ baseUrl: server.url }),
    call,
    url: server.url,
  };
}

it('restores a checkpoint over HTTP while a task runs, and still refuses a stale expected tree', async () => {
  const { workspaces, sessionId, plan, health } = await setup(true);
  // The host says it shares the copy, as the screen reads it (api-contract.md /health).
  expect(health).toMatchObject({ sharedDevelopment: true });
  expect(
    await workspaces.restoreCheckpoint(sessionId, {
      operationId: 'restore',
      checkpointId: plan.checkpointId,
      manifestHash: plan.manifestHash,
      expectedTree: plan.expectedTree,
    }),
  ).toMatchObject({ state: 'applied' });
  expect((await workspaces.readDocument(sessionId, 'a.txt')).content).toEqual({
    kind: 'text',
    text: 'one\n',
  });
  // The plan's tree is now stale: the copy moved under the restore.
  await expect(
    workspaces.restoreCheckpoint(sessionId, {
      operationId: 'restore_stale',
      checkpointId: plan.checkpointId,
      manifestHash: plan.manifestHash,
      expectedTree: plan.expectedTree,
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await workspaces.stopTask(sessionId, 'dev');
});

it('a server without sharing refuses the restore while a task holds the copy, keeping the refusal code', async () => {
  const { workspaces, sessionId, plan, health } = await setup(false);
  expect(health).toMatchObject({ sharedDevelopment: false });
  await expect(
    workspaces.restoreCheckpoint(sessionId, {
      operationId: 'restore',
      checkpointId: plan.checkpointId,
      manifestHash: plan.manifestHash,
      expectedTree: plan.expectedTree,
    }),
  ).rejects.toMatchObject({
    code: 'RUN_ALREADY_ACTIVE',
    // The refusal names what holds the copy (api-contract.md 오류).
    owner: { kind: 'task', id: 'dev', sessionId, state: 'active' },
  });
  await workspaces.stopTask(sessionId, 'dev');
});

it('a sharing host refuses the restore while an agent run writes the copy, naming the run', async () => {
  const hold = new Gate();
  cleanups.push(async () => hold.open());
  const { workspaces, sessionId, plan, call, url } = await setup(
    true,
    new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      beforeReply: () => hold.wait(),
      reply: () => 'Done.',
    }),
  );
  const started = await call(`${url}/api/v1/runs/auto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      choice: { modelProfile: 'model-a' },
      mode: 'mock',
      team: 'none',
      commandId: 'cmd_writer',
      sessionId,
      brief: 'Edit a.txt',
    }),
  });
  const { runId } = (await started.json()) as { runId: string };
  expect(runId).toEqual(expect.any(String));
  const restore = () =>
    workspaces.restoreCheckpoint(sessionId, {
      operationId: 'restore_held',
      checkpointId: plan.checkpointId,
      manifestHash: plan.manifestHash,
      expectedTree: plan.expectedTree,
    });
  // The run holds the copy as a writer once it has started; the task beside it does not.
  await expect
    .poll(() =>
      restore().then(
        () => 'restored',
        (error: { code?: string; owner?: unknown }) => ({ code: error.code, owner: error.owner }),
      ),
    )
    .toEqual({
      code: 'RUN_ALREADY_ACTIVE',
      owner: { kind: 'run', id: runId, sessionId, state: 'active' },
    });
  hold.open();
  await workspaces.stopTask(sessionId, 'dev');
});
