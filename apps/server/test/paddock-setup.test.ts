import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function setup(options: { trusted?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'corral-setup-'));
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
  for (const id of ['s1', 's2'])
    db.prepare(
      "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES(?,'default',NULL,'t','',0,1,'x','x','[]')",
    ).run(id);
  const make = () =>
    new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host-test',
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
    original,
  };
}

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
