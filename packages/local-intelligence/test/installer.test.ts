import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLocalIntelligence } from '../src/factory.ts';
import { bundleDir } from '../src/install.ts';
import { fakeLauncher, markInstalled } from './fake-helper.ts';
import {
  fakeFetch,
  MODEL,
  servedBodies,
  tempDir,
  testBundle,
  testWeights,
  WHEEL,
} from './helpers.ts';

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
    effortWeights: testWeights(),
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
  it('shows the size first, one install with progress while it runs, and a usable judge after', async () => {
    const root = tempDir();
    const held = heldFetch();
    const li = localAi(root, held.fetchFn);
    const total = MODEL.length + WHEEL.length;
    expect(li.status()).toEqual({
      release: 'test-release-1',
      modelName: 'Test model',
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
    expect(li.effort.available()).toBe(true);
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
    expect(held.aborted).toEqual([testBundle().model.url]);
    expect(leftovers(root)).toEqual([]);
    expect(li.effort.available()).toMatch(/not installed/);
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
      effortWeights: testWeights(),
      launch: launcher.launch,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/helper' },
      platform: 'linux',
      arch: 'x64',
    });
    const judged = li.engine.embed({
      texts: ['hi'],
      task: 'classification',
      overflow: 'truncate',
      priority: 'effort',
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

  it('closing cancels a running install', async () => {
    const root = tempDir();
    const held = heldFetch();
    const li = localAi(root, held.fetchFn);
    li.install();
    await vi.waitFor(() => expect(held.asked).toHaveLength(1));
    await li.close();
    expect(held.aborted).toEqual([testBundle().model.url]);
    expect(leftovers(root)).toEqual([]);
  });
});
