import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceTarget } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

// Real child processes share CI workers; this is a runaway limit, not a latency assertion.
vi.setConfig({ testTimeout: 40_000 });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  options: {
    trusted?: boolean;
    timeoutMs?: number;
    /** A host that cannot identify a process after a restart (anything but Linux). */
    noIdentity?: boolean;
    shared?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'corral-setup-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', '-b', 'main', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  writeFileSync(join(original, '.gitignore'), '.env\nnode_modules\n');
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  writeFileSync(join(original, '.env'), 'TOKEN=only-in-the-original\n');
  const db = openDatabase(':memory:');
  for (const id of ['s1', 's2', 'parent', 'sub'])
    db.prepare(
      "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES(?,'default',NULL,'t','',0,1,'x','x','[]')",
    ).run(id);
  const ended: string[] = [];
  const make = () =>
    new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host-test',
      allowSharedDevelopment: options.shared === true,
      setup: {
        environment: () => ({
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          XDG_CACHE_HOME: join(home, '.cache'),
          SSH_AUTH_SOCK: join(root, 'agent.sock'),
          // The server's own secrets are in its environment and never reach setup.
          OPENAI_API_KEY: 'sk-never-passed',
          CORRAL_BOOTSTRAP_TOKEN: 'never-passed',
          CODEX_HOME: join(root, 'codex'),
          GIT_CONFIG_NOSYSTEM: '1',
        }),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.noIdentity
          ? {
              identity: () => {
                throw new Error('no process identity on this host');
              },
            }
          : {}),
        ended: (sessionId: string) => ended.push(sessionId),
      },
    });
  let service = make();
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  if (options.trusted !== false) await service.configure('default', { trusted: true });
  return {
    get service() {
      return service;
    },
    restart: () => {
      // The old service is abandoned with its child running, as after a host crash.
      service = make();
    },
    db,
    root,
    home,
    original,
    ended,
    /** A new copy for the session, as the copy routes make one, with its setup started. */
    async copy(sessionId = 's1') {
      await service.createWorktree(sessionId, 'default');
      await service.setupNewCopy(sessionId);
      const view = service.worktreeView(sessionId);
      if (!view) throw new Error('fixture copy missing');
      const path = service.copyOf(sessionId)?.worktree;
      if (!path) throw new Error('fixture copy path missing');
      const target: WorkspaceTarget = {
        hostId: 'host-test',
        projectId: 'default',
        bindingId: view.bindingId,
        sessionId,
        copyGeneration: view.copyGeneration,
      };
      return { view, path, target };
    },
    async command(text: string) {
      const binding = await service.view('default');
      return service.configure('default', {
        setupCommand: text,
        setupRevision: binding?.setupRevision ?? 0,
      });
    },
    settled: (sessionId = 's1') =>
      vi.waitFor(
        () => {
          const setup = service.worktreeView(sessionId)?.setup;
          expect(setup?.state).not.toBe('running');
          return setup;
        },
        { timeout: 20_000 },
      ),
  };
}

const read = (path: string) => readFileSync(path, 'utf8');

it('saves the setup command on the folder link with its own revision, apart from the tool config', async () => {
  const s = await setup();
  const before = await s.service.view('default');
  expect(before).toMatchObject({ setupCommand: null, setupRevision: 0 });
  const toolRevisions = () =>
    (
      s.db
        .prepare("SELECT COUNT(*) AS n FROM project_tool_revisions WHERE project_id='default'")
        .get() as { n: number }
    ).n;
  const tools = toolRevisions();

  const saved = await s.service.configure('default', {
    setupCommand: 'pnpm install\ncp "$CORRAL_SOURCE_DIR/.env" .env\n',
    setupRevision: 0,
  });
  expect(saved).toMatchObject({
    setupCommand: 'pnpm install\ncp "$CORRAL_SOURCE_DIR/.env" .env\n',
    setupRevision: 1,
  });
  expect(toolRevisions()).toBe(tools);

  // A second screen that read revision 0 does not overwrite the first save.
  await expect(
    s.service.configure('default', { setupCommand: 'npm ci', setupRevision: 0 }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await s.service.view('default')).toMatchObject({ setupRevision: 1 });

  await expect(s.service.configure('default', { setupCommand: 'npm ci' })).rejects.toMatchObject({
    code: 'SCHEMA_INVALID',
  });
  await expect(
    s.service.configure('default', { setupCommand: ' \n\t', setupRevision: 1 }),
  ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });

  const cleared = await s.service.configure('default', { setupCommand: null, setupRevision: 1 });
  expect(cleared).toMatchObject({ setupCommand: null, setupRevision: 2 });

  // Turning trust off keeps the saved command.
  await s.service.configure('default', { setupCommand: 'npm ci', setupRevision: 2 });
  const untrusted = await s.service.configure('default', { trusted: false });
  expect(untrusted).toMatchObject({ trusted: false, setupCommand: 'npm ci', setupRevision: 3 });
});

it('refuses a setup command for a folder that is not trusted', async () => {
  const s = await setup({ trusted: false });
  await expect(
    s.service.configure('default', { setupCommand: 'npm ci', setupRevision: 0 }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  expect(await s.service.view('default')).toMatchObject({ setupCommand: null, setupRevision: 0 });
});

it('runs the setup command once in a new Paddock with the person’s home and the original folder', async () => {
  const s = await setup();
  await s.command(
    [
      'cp "$CORRAL_SOURCE_DIR/.env" .env',
      'printf "%s|%s|%s|%s" "$HOME" "$XDG_CACHE_HOME" "$SSH_AUTH_SOCK" "$CI" > seen.txt',
      'printf "%s|%s|%s|%s" "${OPENAI_API_KEY-none}" "${CORRAL_BOOTSTRAP_TOKEN-none}" "${CODEX_HOME-none}" "${GIT_CONFIG_NOSYSTEM-none}" > hidden.txt',
      'printf "%s" "${NPM_CONFIG_USERCONFIG-none}" > npmrc.txt',
      'echo "set up in $CORRAL_SOURCE_DIR"',
    ].join('\n'),
  );
  const { path } = await s.copy();
  const done = await s.settled();
  expect(done).toMatchObject({ state: 'succeeded', reason: null, exitCode: 0 });
  expect(read(join(path, '.env'))).toBe('TOKEN=only-in-the-original\n');
  expect(read(join(path, 'seen.txt'))).toBe(
    `${s.home}|${join(s.home, '.cache')}|${join(s.root, 'agent.sock')}|1`,
  );
  expect(read(join(path, 'hidden.txt'))).toBe('none|none|none|none');
  expect(read(join(path, 'npmrc.txt'))).toBe('none');
  expect(s.ended).toEqual(['s1']);

  // The kept output hides the original folder and the home.
  const detail = s.service.setupDetail('s1', done?.operationId ?? '');
  expect(detail.output.text).toContain('set up in');
  expect(detail.output.text).not.toContain(s.original);

  // The same automatic setup is never started twice for one copy generation.
  await s.service.setupNewCopy('s1');
  expect(s.service.worktreeView('s1')?.setup?.operationId).toBe(done?.operationId);
});

it('does nothing without a setup command', async () => {
  const s = await setup();
  await s.copy();
  expect(s.service.worktreeView('s1')?.setup).toBeNull();
  expect(s.ended).toEqual([]);
});

it('a failed setup leaves the copy; it runs again on request, once at a time and once per id', async () => {
  const s = await setup();
  await s.command('echo broken >&2\nexit 3');
  const { path, target } = await s.copy();
  expect(await s.settled()).toMatchObject({
    state: 'failed',
    reason: 'command_failed',
    exitCode: 3,
  });
  expect(existsSync(join(path, 'a.txt'))).toBe(true);

  await s.command('sleep 30');
  const again = await s.service.startSetup('s1', { operationId: 'setup_again', target });
  expect(again).toMatchObject({ operationId: 'setup_again', state: 'running' });
  await expect(
    s.service.startSetup('s1', { operationId: 'setup_third', target }),
  ).rejects.toMatchObject({
    code: 'RUN_ALREADY_ACTIVE',
    owner: { kind: 'operation', operationKind: 'setup', id: 'setup_again' },
  });
  // The same id and body return the first receipt; one setup runs.
  expect(await s.service.startSetup('s1', { operationId: 'setup_again', target })).toMatchObject({
    operationId: 'setup_again',
  });
  await expect(
    s.service.startSetup('s1', {
      operationId: 'setup_again',
      target: { ...target, copyGeneration: target.copyGeneration + 1 },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

  const stopped = await s.service.stopSetup('s1', 'setup_again', target);
  expect(stopped).toMatchObject({ state: 'cancelled', reason: 'stopped' });
  expect(await s.service.stopSetup('s1', 'setup_again', target)).toEqual(stopped);
});

it('a running setup keeps the text it started with; the next one uses the new text', async () => {
  const s = await setup();
  await s.command('sleep 1\necho first > which.txt');
  const { path, target } = await s.copy();
  await s.command('echo second > which.txt');
  await s.settled();
  expect(read(join(path, 'which.txt'))).toBe('first\n');
  await s.service.startSetup('s1', { operationId: 'setup_next', target });
  await s.settled();
  expect(read(join(path, 'which.txt'))).toBe('second\n');
});

it('a setup that runs past its time limit is stopped and fails', async () => {
  const s = await setup({ timeoutMs: 500 });
  await s.command('sleep 30');
  await s.copy();
  expect(await s.settled()).toMatchObject({ state: 'failed', reason: 'command_timeout' });
});

it('turning trust off stops a running setup and refuses another; the command stays', async () => {
  const s = await setup();
  await s.command('sleep 30');
  const { target } = await s.copy();
  expect(s.service.worktreeView('s1')?.setup?.state).toBe('running');
  await s.service.configure('default', { trusted: false });
  expect(await s.settled()).toMatchObject({ state: 'cancelled', reason: 'trust_revoked' });
  await expect(
    s.service.startSetup('s1', { operationId: 'setup_untrusted', target }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  expect(await s.service.view('default')).toMatchObject({ setupCommand: 'sleep 30' });
});

it('a running setup holds the copy: it cannot be removed until the setup is stopped', async () => {
  const s = await setup();
  await s.command('sleep 30');
  const { target } = await s.copy();
  const plan = await s.service.removalPlan('s1');
  expect(plan.owners).toEqual([expect.objectContaining({ kind: 'user', operation: 'setup' })]);
  await expect(s.service.removeWorktree('s1')).rejects.toBeTruthy();
  const running = s.service.worktreeView('s1')?.setup;
  await s.service.stopSetup('s1', running?.operationId ?? '', target);
  await s.service.removeWorktree('s1');
  expect(s.service.worktreeView('s1')).toBeNull();
});

it('a sub-session copy is set up after the parent’s files are in it, from the original folder', async () => {
  const s = await setup();
  await s.command('cat notes.txt > seen.txt\nprintf "%s" "$CORRAL_SOURCE_DIR" > source.txt');
  const parent = await s.copy('parent');
  await s.settled('parent');
  writeFileSync(join(parent.path, 'notes.txt'), 'uncommitted in the parent\n');
  await s.service.branchFromCopy('parent', 'sub', 'Parent');
  const sub = s.service.copyOf('sub')?.worktree ?? '';
  expect(await s.settled('sub')).toMatchObject({ state: 'succeeded' });
  expect(read(join(sub, 'seen.txt'))).toBe('uncommitted in the parent\n');
  expect(read(join(sub, 'source.txt'))).toBe(s.original);
});

it('after a restart a setup whose process can be identified stays protected until it is stopped', async () => {
  const s = await setup();
  await s.command('sleep 30');
  const { target } = await s.copy();
  const operationId = s.service.worktreeView('s1')?.setup?.operationId ?? '';
  s.restart();
  expect(s.service.worktreeView('s1')?.setup).toMatchObject({ operationId, state: 'uncertain' });
  await expect(s.service.removeWorktree('s1')).rejects.toBeTruthy();
  expect(await s.service.stopSetup('s1', operationId, target)).toMatchObject({
    state: 'cancelled',
    reason: 'stopped',
  });
});

it('after a restart a setup whose process cannot be identified ends as failed and frees the copy', async () => {
  const s = await setup({ noIdentity: true });
  await s.command('sleep 2');
  await s.copy();
  const operationId = s.service.worktreeView('s1')?.setup?.operationId ?? '';
  s.restart();
  expect(s.service.worktreeView('s1')?.setup).toMatchObject({
    operationId,
    state: 'failed',
    reason: 'interrupted_unconfirmed',
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await s.service.removeWorktree('s1');
  expect(s.service.worktreeView('s1')).toBeNull();
});
