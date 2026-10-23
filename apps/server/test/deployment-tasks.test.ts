import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectToolConfigRevision, WorkspaceTarget } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckOutput } from '../src/files/check-output.ts';
import { DeploymentTasks } from '../src/files/deployment-tasks.ts';
import { gitText } from '../src/files/git.ts';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';
import { CommandRuntime, type UserTaskOwner } from '../src/processes/runtime.ts';

vi.setConfig({ testTimeout: 30_000 });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-deployment-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'deployment-result.json\ncount\n');
  writeFileSync(
    join(root, 'deploy.cjs'),
    `const fs=require('fs');fs.appendFileSync('count','x');fs.writeFileSync('deployment-result.json',JSON.stringify({operationId:process.env.CORRAL_DEPLOYMENT_OPERATION,environment:process.env.CORRAL_DEPLOYMENT_ENVIRONMENT,sourceCommit:process.env.CORRAL_DEPLOYMENT_COMMIT||null,sourceTree:process.env.CORRAL_DEPLOYMENT_TREE,deploymentId:'fixture-1',status:'succeeded',url:'https://fixture.example/deployment'}));console.log(process.env.FIXTURE_DEPLOY_KEY);`,
  );
  writeFileSync(
    join(root, 'readback.cjs'),
    `process.stdout.write(require('fs').readFileSync('deployment-result.json'));`,
  );
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const db = openDatabase(':memory:');
  const clock = new FakeClock();
  const operations = new WorkbenchOperations(db, clock);
  const runtime = new CommandRuntime<UserTaskOwner>();
  const target: WorkspaceTarget = {
    hostId: 'local',
    projectId: 'default',
    bindingId: 'binding',
    sessionId: 's1',
    copyGeneration: 1,
  };
  let config: ProjectToolConfigRevision = {
    projectId: 'default',
    revision: 1,
    hash: 'a'.repeat(64),
    createdAt: clock.nowIso(),
    checks: [],
    lspServers: [],
    deployments: [
      {
        id: 'deploy',
        name: 'Fixture',
        environment: 'preview',
        argv: [process.execPath, 'deploy.cjs'],
        readbackArgv: [process.execPath, 'readback.cjs'],
        timeoutMs: 5000,
        envRefs: ['FIXTURE_DEPLOY_KEY'],
      },
    ],
  };
  const snapshot = async () => {
    const index = join(tmpdir(), `corral-deploy-index-${Math.random()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env });
      execFileSync('git', ['add', '-A'], { cwd: root, env });
      return execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
    } finally {
      rmSync(index, { force: true });
    }
  };
  const make = (commandRuntime = runtime) =>
    new DeploymentTasks({
      db,
      operations,
      runtime: commandRuntime,
      resolveTarget: (_session, asked) => {
        if (JSON.stringify(asked) !== JSON.stringify(target)) throw new Error('target changed');
        return root;
      },
      config: () => config,
      snapshot,
      lease: (_root, fn) => fn(),
      environment: () => ({ FIXTURE_DEPLOY_KEY: 'private-fixture-value' }),
    });
  const tasks = make();
  cleanups.push(async () => {
    await runtime.close();
    tasks.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    target,
    tasks,
    operations,
    runtime,
    make,
    git,
    config: () => config,
    changeConfig: () => {
      config = { ...config, revision: config.revision + 1 };
    },
  };
}

it('[TC-WBD-024-H] reviews pinned source, deduplicates deployment and requires matching readback before success', async () => {
  const s = setup();
  const plan = await s.tasks.inspect('s1', { target: s.target, profileId: 'deploy' });
  expect(plan.source).toMatchObject({
    dirty: false,
    commit: await gitText(s.root, ['rev-parse', 'HEAD']),
  });
  const input = {
    operationId: 'deploy_one',
    target: s.target,
    profileId: 'deploy',
    fingerprint: plan.fingerprint,
    allowDirty: false,
  };
  await Promise.all([s.tasks.start('s1', input), s.tasks.start('s1', input)]);
  await vi.waitFor(() =>
    expect(s.tasks.get('s1', 'deploy_one')).toMatchObject({
      state: 'uncertain',
      exitCode: 0,
      cleanupConfirmed: true,
      readback: null,
    }),
  );
  expect(readFileSync(join(s.root, 'count'), 'utf8')).toBe('x');
  expect(JSON.stringify(s.tasks.get('s1', 'deploy_one'))).not.toContain('private-fixture-value');
  expect(s.runtime.read('deploy_one')?.text).not.toContain('private-fixture-value');
  expect(await s.tasks.check('s1', 'deploy_one', { target: s.target })).toMatchObject({
    state: 'succeeded',
    readback: { deploymentId: 'fixture-1', url: 'https://fixture.example/deployment' },
  });
  await s.tasks.start('s1', input);
  expect(readFileSync(join(s.root, 'count'), 'utf8')).toBe('x');
});

it('[TC-WBD-024-N] refuses stale source/config and dirty source without consent, and rejects mismatched or unsafe results', async () => {
  const s = setup();
  let plan = await s.tasks.inspect('s1', { target: s.target, profileId: 'deploy' });
  writeFileSync(join(s.root, 'source.txt'), 'dirty');
  const input = {
    operationId: 'deploy_dirty',
    target: s.target,
    profileId: 'deploy',
    fingerprint: plan.fingerprint,
    allowDirty: false,
  };
  await expect(s.tasks.start('s1', input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  plan = await s.tasks.inspect('s1', { target: s.target, profileId: 'deploy' });
  await expect(
    s.tasks.start('s1', { ...input, fingerprint: plan.fingerprint }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  s.changeConfig();
  await expect(
    s.tasks.start('s1', { ...input, fingerprint: plan.fingerprint, allowDirty: true }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  plan = await s.tasks.inspect('s1', { target: s.target, profileId: 'deploy' });
  await s.tasks.start('s1', { ...input, fingerprint: plan.fingerprint, allowDirty: true });
  await vi.waitFor(() => expect(s.tasks.get('s1', 'deploy_dirty').state).toBe('uncertain'));
  const result = JSON.parse(readFileSync(join(s.root, 'deployment-result.json'), 'utf8'));
  writeFileSync(
    join(s.root, 'deployment-result.json'),
    JSON.stringify({ ...result, operationId: 'other' }),
  );
  expect(await s.tasks.check('s1', 'deploy_dirty', { target: s.target })).toMatchObject({
    state: 'uncertain',
    readback: null,
  });
  writeFileSync(
    join(s.root, 'deployment-result.json'),
    JSON.stringify({ ...result, status: 'pending' }),
  );
  expect(await s.tasks.check('s1', 'deploy_dirty', { target: s.target })).toMatchObject({
    state: 'uncertain',
    readback: { deploymentId: 'fixture-1', status: 'pending' },
  });
  writeFileSync(
    join(s.root, 'deployment-result.json'),
    JSON.stringify({ ...result, url: 'javascript:alert(1)' }),
  );
  expect(await s.tasks.check('s1', 'deploy_dirty', { target: s.target })).toMatchObject({
    state: 'uncertain',
    readback: { deploymentId: 'fixture-1', status: 'pending' },
  });
  writeFileSync(
    join(s.root, 'deployment-result.json'),
    JSON.stringify({ ...result, deploymentId: 'other-deployment' }),
  );
  expect(await s.tasks.check('s1', 'deploy_dirty', { target: s.target })).toMatchObject({
    state: 'uncertain',
    readback: { deploymentId: 'fixture-1', status: 'pending' },
  });
  const stopped = await s.tasks.stop('s1', 'deploy_dirty', { target: s.target });
  expect(stopped).toMatchObject({
    state: 'cancelled',
    cleanupConfirmed: true,
    reason: 'stopped_remote_unknown',
  });
});

it('[TC-WBD-024-F] cancellation and restart keep remote outcome unknown without redeploying or accepting late results', async () => {
  const s = setup();
  writeFileSync(
    join(s.root, 'deploy.cjs'),
    `require('fs').appendFileSync('count','x');setInterval(()=>{},1000);`,
  );
  const plan = await s.tasks.inspect('s1', { target: s.target, profileId: 'deploy' });
  const input = {
    operationId: 'deploy_cancel',
    target: s.target,
    profileId: 'deploy',
    fingerprint: plan.fingerprint,
    allowDirty: true,
  };
  await s.tasks.start('s1', input);
  await vi.waitFor(() => expect(readFileSync(join(s.root, 'count'), 'utf8')).toBe('x'));
  s.operations.recover();
  const nextRuntime = new CommandRuntime<UserTaskOwner>();
  const restarted = s.make(nextRuntime);
  cleanups.push(async () => {
    await nextRuntime.close();
    restarted.dispose();
  });
  expect(restarted.get('s1', 'deploy_cancel')).toMatchObject({
    state: 'uncertain',
    cleanupConfirmed: false,
  });
  await expect(restarted.check('s1', 'deploy_cancel', { target: s.target })).rejects.toMatchObject({
    code: 'CAPABILITY_DENIED',
  });
  expect(await restarted.stop('s1', 'deploy_cancel', { target: s.target })).toMatchObject({
    state: 'cancelled',
    cleanupConfirmed: true,
    readback: null,
    reason: 'stopped_remote_unknown',
  });
  expect(await restarted.start('s1', input)).toMatchObject({ state: 'cancelled' });
  expect(readFileSync(join(s.root, 'count'), 'utf8')).toBe('x');
});

it('[TC-WBD-024-N] credential references stay redacted across chunks and multiline output', () => {
  const output = new CheckOutput([], ['first-private-line\nsecond-private-line']);
  output.add('stdout', Buffer.from('first-private-'));
  output.add('stdout', Buffer.from('line\nsecond-private-line\n'));
  expect(output.finish().text).not.toContain('private-line');
});
