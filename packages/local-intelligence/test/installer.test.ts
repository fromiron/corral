import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLocalIntelligence } from '../src/factory.ts';
import { bundleDir } from '../src/install.ts';
import { fakeLauncher, markInstalled } from './fake-helper.ts';
import { fakeFetch, MODEL, servedBodies, tempDir, testBundle, WHEEL } from './helpers.ts';

/** Holds every request until released or aborted; afterwards serves the test bundle. */
function heldFetch(bundle = testBundle()) {
  const served = fakeFetch(servedBodies(bundle));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked: string[] = [];
  const aborted: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input));
    const signal = init?.signal;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => {
        aborted.push(String(input));
        reject(signal.reason);
      });
      void gate.then(resolve);
    });
    return served.fetchFn(input, init);
  }) as typeof fetch;
  return { fetchFn, release, asked, aborted, requested: served.requested };
}

function localAi(root: string, fetchFn: typeof fetch, platform = 'linux') {
  return createLocalIntelligence({
    root,
    bundle: testBundle(),
    fetchFn,
    launch: fakeLauncher().launch,
    env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
    platform,
    arch: 'x64',
    logicalCores: 4,
  });
}

function leftovers(root: string) {
  const dir = bundleDir(root, testBundle());
  return existsSync(dir) ? readdirSync(dir) : [];
}

const notInstalling = async (li: ReturnType<typeof localAi>) =>
  vi.waitFor(() => expect(li.status().state).not.toBe('installing'));

describe('local AI install from the settings panel', () => {
  it('shows the size first, one install with progress while it runs, and a usable engine after', async () => {
    const root = tempDir();
    const held = heldFetch();
    const li = localAi(root, held.fetchFn);
    const total = MODEL.length + WHEEL.length;
    expect(li.status()).toEqual({
      release: 'test-release-1',
      models: { meeting: 'Test model' },
      state: 'missing',
      downloadBytes: total,
      progress: null,
      error: null,
    });

    expect(li.install()).toMatchObject({ state: 'installing', progress: { received: 0, total } });
    expect(li.install()).toMatchObject({ state: 'installing' });
    held.release();
    await notInstalling(li);

    expect(held.requested).toEqual(Object.keys(servedBodies(testBundle())));
    expect(li.status()).toMatchObject({ state: 'idle', progress: null, error: null });
    expect(li.engine.available()).toBe(true);
    expect(li.install()).toMatchObject({ state: 'idle' });
    expect(held.requested).toHaveLength(2);
    await li.close();
  });

  it('cancels: the download stops, partial files go, and it stays not installed', async () => {
    const root = tempDir();
    const held = heldFetch();
    const li = localAi(root, held.fetchFn);
    li.install();
    await vi.waitFor(() => expect(held.asked).toHaveLength(1));
    expect(await li.cancelInstall()).toMatchObject({
      state: 'missing',
      progress: null,
      error: null,
    });
    expect(held.aborted).toEqual([testBundle().models.meeting.url]);
    expect(leftovers(root)).toEqual([]);
    expect(li.engine.available()).toMatch(/not installed/);
    await li.close();
  });

  it('reports a failed install without local paths and installs on the next try', async () => {
    const root = tempDir();
    let calls = 0;
    const served = fakeFetch(servedBodies(testBundle()));
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
      ++calls === 1
        ? new Response('gone', { status: 404 })
        : served.fetchFn(input, init)) as typeof fetch;
    const li = localAi(root, fetchFn);
    li.install();
    await notInstalling(li);
    expect(li.status()).toMatchObject({ state: 'missing', error: expect.stringMatching(/404/) });

    li.install();
    expect(li.status().error).toBeNull();
    await notInstalling(li);
    expect(li.status()).toMatchObject({ state: 'idle', error: null });
    await li.close();

    const file = join(tempDir(), 'not-a-folder');
    writeFileSync(file, '');
    const broken = localAi(file, fetchFn);
    broken.install();
    await notInstalling(broken);
    expect(broken.status().error).toMatch(/ENOTDIR/);
    expect(broken.status().error).not.toContain(file);
    await broken.close();
  });

  it('starts nothing when installed or when this machine has no runtime', async () => {
    const root = tempDir();
    markInstalled(root, testBundle());
    const held = heldFetch();
    const installed = localAi(root, held.fetchFn);
    expect(installed.install()).toMatchObject({ state: 'idle' });
    const unsupported = localAi(tempDir(), held.fetchFn, 'darwin');
    expect(unsupported.status()).toMatchObject({ state: 'unsupported', downloadBytes: null });
    expect(unsupported.install()).toMatchObject({ state: 'unsupported', progress: null });
    expect(held.requested).toEqual([]);
    await installed.close();
    await unsupported.close();
  });

  it('keeps local paths out of an engine failure it shows', async () => {
    const root = tempDir();
    markInstalled(root, testBundle());
    const launcher = fakeLauncher();
    const li = createLocalIntelligence({
      root,
      bundle: testBundle(),
      launch: launcher.launch,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
      platform: 'linux',
      arch: 'x64',
    });
    const judged = li.engine.embed({
      texts: ['hi'],
      task: 'classification',
      overflow: 'truncate',
    });
    await vi.waitFor(() => expect(launcher.helpers).toHaveLength(1));
    const cache = join(bundleDir(root, testBundle()), 'cache');
    launcher.last().fatal(`Cache directory does not exist or is not writable: ${cache}`);
    await expect(judged).rejects.toThrow();
    expect(li.status().state).toBe('error');
    expect(li.status().error).toContain('Cache directory does not exist');
    expect(li.status().error).not.toContain(root);
    await li.close();
  });

  it('removes only the meeting release and leaves the judge model', async () => {
    const root = tempDir();
    const bundle = testBundle();
    markInstalled(root, bundle);
    const judge = join(root, 'd1', 'd1-test');
    mkdirSync(judge, { recursive: true });
    writeFileSync(join(judge, 'keep'), 'judge');
    const older = join(root, 'corral-local-ai-1');
    mkdirSync(older, { recursive: true });
    writeFileSync(
      join(older, 'install.json'),
      JSON.stringify({ release: 'corral-local-ai-1', target: 'linux-x64' }),
    );
    const notes = join(root, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'keep'), 'notes');
    const launcher = fakeLauncher();
    const li = createLocalIntelligence({
      root,
      bundle,
      launch: launcher.launch,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
      platform: 'linux',
      arch: 'x64',
    });
    const judged = li.engine.embed({
      texts: ['hi'],
      task: 'classification',
      overflow: 'truncate',
    });
    await vi.waitFor(() => expect(launcher.helpers).toHaveLength(1));
    launcher.last().ready();
    await vi.waitFor(() => expect(launcher.last().sent).toHaveLength(1));

    await expect(li.remove()).rejects.toThrow('a computation is in progress');
    expect(existsSync(join(bundleDir(root, bundle), 'install.json'))).toBe(true);
    expect(launcher.last().killed).toBe(false);

    launcher.last().answer();
    await judged;
    await li.remove();
    expect(li.status()).toMatchObject({ state: 'missing', error: null });
    expect(launcher.last().killed).toBe(true);
    expect(existsSync(bundleDir(root, bundle))).toBe(false);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(join(judge, 'keep'))).toBe(true);
    expect(existsSync(join(notes, 'keep'))).toBe(true);

    await li.remove();
    expect(li.status().state).toBe('missing');
    expect(existsSync(join(judge, 'keep'))).toBe(true);
    expect(existsSync(join(notes, 'keep'))).toBe(true);
    await li.close();
  });

  it('starts no helper for an embedding that arrives while removal stops the helper', async () => {
    const root = tempDir();
    const bundle = testBundle();
    markInstalled(root, bundle);
    const launcher = fakeLauncher();
    let exit!: () => void;
    const li = createLocalIntelligence({
      root,
      bundle,
      launch: (command) => {
        const helper = launcher.launch(command);
        const kill = helper.kill.bind(helper);
        helper.kill = async () => {
          await new Promise<void>((resolve) => {
            exit = resolve;
          });
          await kill();
        };
        return helper;
      },
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
      platform: 'linux',
      arch: 'x64',
    });
    const warm = li.engine.warmUp();
    await vi.waitFor(() => expect(launcher.helpers).toHaveLength(1));
    launcher.last().ready();
    await warm;

    const removing = li.remove();
    await vi.waitFor(() => expect(exit).toBeDefined());
    const late = li.engine.embed({ texts: ['hi'], task: 'classification', overflow: 'truncate' });
    exit();
    await removing;

    await expect(late).rejects.toThrow('not installed');
    expect(launcher.helpers).toHaveLength(1);
    expect(existsSync(bundleDir(root, bundle))).toBe(false);
    expect(li.status().state).toBe('missing');
    await li.close();
  });

  it.skipIf(process.getuid?.() === 0)(
    'keeps the local path out of a failed removal and still reads as installed',
    async () => {
      const root = tempDir();
      const bundle = testBundle();
      markInstalled(root, bundle);
      const li = createLocalIntelligence({
        root,
        bundle,
        launch: fakeLauncher().launch,
        env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
        platform: 'linux',
        arch: 'x64',
      });
      chmodSync(bundleDir(root, bundle), 0o500);
      try {
        const failure = await li.remove().then(
          () => null,
          (error: Error) => error,
        );
        expect(failure?.message).toBe('cannot remove the local AI files (EACCES)');
        expect(li.status().state).toBe('idle');
      } finally {
        chmodSync(bundleDir(root, bundle), 0o700);
      }
      expect(existsSync(join(bundleDir(root, bundle), 'install.json'))).toBe(true);
      await li.close();
    },
  );

  it('refuses to remove a meeting bundle while it is installing', async () => {
    const root = tempDir();
    const judge = join(root, 'd1', 'd1-test');
    mkdirSync(judge, { recursive: true });
    writeFileSync(join(judge, 'keep'), 'judge');
    const held = heldFetch();
    const li = localAi(root, held.fetchFn);
    li.install();
    await vi.waitFor(() => expect(held.asked).toHaveLength(1));

    await expect(li.remove()).rejects.toThrow('an install is in progress');

    expect(li.status().state).toBe('installing');
    expect(held.aborted).toEqual([]);
    expect(existsSync(join(judge, 'keep'))).toBe(true);
    await li.close();
  });

  it('drops a late install completion after the meeting bundle is removed', async () => {
    const root = tempDir();
    const bundle = testBundle();
    const judge = join(root, 'd1', 'd1-test');
    mkdirSync(judge, { recursive: true });
    writeFileSync(join(judge, 'keep'), 'judge');
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rewrite = false;
    const li = createLocalIntelligence({
      root,
      bundle,
      fetchFn: fakeFetch(servedBodies(bundle)).fetchFn,
      launch: fakeLauncher().launch,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
      platform: 'linux',
      arch: 'x64',
      beforeAccept: async () => {
        entered = true;
        await gate;
        if (rewrite) markInstalled(root, bundle);
      },
    });
    li.install();
    const pending = li.installing();
    expect(pending).not.toBeNull();
    await vi.waitFor(() => expect(entered).toBe(true));
    rewrite = true;

    await li.remove();
    expect(li.status().state).toBe('missing');
    release();
    await pending;

    expect(li.status().state).toBe('missing');
    expect(existsSync(bundleDir(root, bundle))).toBe(false);
    expect(existsSync(join(judge, 'keep'))).toBe(true);
    await li.close();
  });

  it('closing cancels a running install', async () => {
    const root = tempDir();
    const held = heldFetch();
    const li = localAi(root, held.fetchFn);
    li.install();
    await vi.waitFor(() => expect(held.asked).toHaveLength(1));
    await li.close();
    expect(held.aborted).toEqual([testBundle().models.meeting.url]);
    expect(leftovers(root)).toEqual([]);
  });
});
