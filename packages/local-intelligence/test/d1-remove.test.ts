import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoutingBackend, RoutingLease } from '@corral/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { D1Engine, type D1EngineOptions } from '../src/d1/engine.ts';
import { d1Installed } from '../src/d1/install.ts';
import { type D1Manifest, LINUX_X64_CPU } from '../src/d1/manifest.ts';
import type { D1Child } from '../src/d1/runtime.ts';
import {
  type FakeBehavior,
  fakeLauncher,
  goodVersion,
  installFake,
  LIB_BYTES,
  MODEL_BYTES,
  releaseArchive,
  removeTempRoots,
  SERVER_BYTES,
  servingFetch,
  sha,
  tempRoot,
  testManifest,
  until,
} from './d1-helpers.ts';

// features/effort-routing.md#local-엔진-제거

const engines: D1Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  removeTempRoots();
});

const LIMITS = { startupMs: 5000, idleMs: 60_000, watchdogMs: 5000, graceMs: 300, pollMs: 20 };

function setup(behavior: FakeBehavior = {}, options: Partial<D1EngineOptions> = {}) {
  const root = tempRoot();
  const manifest = testManifest();
  const dir = installFake(root, manifest);
  const fake = fakeLauncher(behavior);
  const engine = new D1Engine({
    root,
    manifest,
    launch: fake.launch,
    limits: LIMITS,
    host: 'test-host',
    ...options,
  });
  engines.push(engine);
  const backend = (threads = 2): RoutingBackend =>
    engine.backend({ kind: 'local', device: { kind: 'cpu', threads }, callerTimeoutMs: 5000 });
  return { engine, fake, backend, dir, manifest, root };
}

async function ready(s: ReturnType<typeof setup>, threads = 2) {
  s.engine.prepare(threads);
  await until(() => ['ready', 'error'].includes(s.engine.status().runtime));
  expect(s.engine.status()).toMatchObject({ runtime: 'ready', error: null });
}

function admitted(backend: RoutingBackend): RoutingLease {
  const admission = backend.admit();
  if (!admission.ok) throw new Error(`not admitted: ${admission.reason}`);
  return admission.lease;
}

function keepMeeting(root: string) {
  const meeting = join(root, '..', 'corral-local-ai-2');
  const older = join(root, 'older-d1');
  mkdirSync(meeting, { recursive: true });
  mkdirSync(older, { recursive: true });
  writeFileSync(join(meeting, 'keep'), 'meeting');
  writeFileSync(join(older, 'keep'), 'older');
  return { meeting, older };
}

const withArchive = (archive: Buffer, manifest = testManifest()): D1Manifest => ({
  ...manifest,
  runtime: { ...manifest.runtime, size: archive.length, sha256: sha(archive) },
});

describe('removing the Local judge model', () => {
  it('stops only the child it started and leaves the meeting bundle and other manifests', async () => {
    const kept = setup();
    await ready(kept);
    const s = setup();
    await ready(s);
    const { meeting, older } = keepMeeting(s.root);
    expect(s.engine.status().install).toBe('installed');

    await s.engine.remove();

    expect(s.engine.status()).toMatchObject({ install: 'absent', runtime: 'stopped', error: null });
    expect(s.fake.children[0]!.alive).toBe(false);
    expect(kept.fake.children[0]!.alive).toBe(true);
    expect(existsSync(join(kept.dir, 'install.json'))).toBe(true);
    expect(existsSync(join(meeting, 'keep'))).toBe(true);
    expect(existsSync(join(older, 'keep'))).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
    expect(s.backend().admit()).toEqual({ ok: false, reason: 'unavailable' });

    await s.engine.remove();
    expect(s.engine.status().install).toBe('absent');
    expect(kept.fake.children[0]!.alive).toBe(true);
    expect(existsSync(join(meeting, 'keep'))).toBe(true);
  });

  it('refuses while a judgment holds the slot and leaves the process running', async () => {
    const s = setup();
    await ready(s);
    const lease = admitted(s.backend());
    expect(s.engine.status().runtime).toBe('packing');

    await expect(s.engine.remove()).rejects.toThrow('a judgment is running');

    expect(s.engine.status().install).toBe('installed');
    expect(s.fake.children[0]!.alive).toBe(true);
    expect(existsSync(join(s.dir, 'install.json'))).toBe(true);
    lease.release();
  });

  it('starts no child for a request that arrives while removal waits for the exit', async () => {
    const s = setup({ ignoreTerm: true });
    await ready(s);

    const removing = s.engine.remove();
    await until(() => s.engine.status().runtime === 'stopped');
    expect(s.backend().admit()).toEqual({ ok: false, reason: 'unavailable' });
    s.engine.prepare(2);
    await removing;

    expect(s.fake.children).toHaveLength(1);
    expect(s.fake.children[0]!.alive).toBe(false);
    expect(existsSync(s.dir)).toBe(false);
    expect(s.engine.status()).toMatchObject({ install: 'absent', runtime: 'stopped' });
  });

  it('refuses while an install is in progress and does not delete the other bundle', async () => {
    const root = tempRoot();
    const manifest = testManifest();
    const { meeting } = keepMeeting(root);
    const { fetchFn } = servingFetch(
      { [manifest.model.url]: MODEL_BYTES },
      { hold: manifest.model.url },
    );
    const engine = new D1Engine({
      root,
      manifest,
      fetchFn,
      freeBytes: async () => null,
    });
    engines.push(engine);
    engine.install();
    expect(engine.status().install).toBe('downloading');

    await expect(engine.remove()).rejects.toThrow('an install is in progress');

    expect(engine.status().install).toBe('downloading');
    expect(existsSync(join(meeting, 'keep'))).toBe(true);
    expect(existsSync(join(root, 'older-d1', 'keep'))).toBe(true);
  });

  it('drops a late install completion after removal and does not start the model', async () => {
    const root = tempRoot();
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    const dir = join(root, manifest.id);
    const { meeting } = keepMeeting(root);
    const { fetchFn } = servingFetch({
      [manifest.model.url]: MODEL_BYTES,
      [manifest.runtime.url]: archive,
    });
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rewrite = false;
    let accepted = false;
    const launched: D1Child[] = [];
    const engine = new D1Engine({
      root,
      manifest,
      fetchFn,
      probe: goodVersion,
      freeBytes: async () => null,
      beforeAccept: async () => {
        entered = true;
        await gate;
        if (!rewrite) return;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, manifest.model.file), MODEL_BYTES);
        writeFileSync(join(dir, 'llama-server'), SERVER_BYTES);
        writeFileSync(join(dir, 'libggml.so'), LIB_BYTES);
        writeFileSync(
          join(dir, 'install.json'),
          JSON.stringify({ id: manifest.id, devices: ['cpu'] }),
        );
      },
      onInstalled: () => {
        accepted = true;
        engine.prepare(2);
      },
      launch: () => {
        let alive = true;
        let exit!: () => void;
        const exited = new Promise<void>((resolve) => {
          exit = resolve;
        });
        const child: D1Child = {
          get alive() {
            return alive;
          },
          exited,
          signal: () => {
            alive = false;
            exit();
          },
        };
        launched.push(child);
        return child;
      },
    });
    engines.push(engine);
    engine.install();
    const pending = engine.installing();
    await until(() => entered);
    expect(d1Installed(root, manifest)).toBe(true);
    rewrite = true;

    await engine.remove();
    expect(engine.status().install).toBe('absent');
    release();
    await pending;

    expect(accepted).toBe(false);
    expect(launched).toHaveLength(0);
    expect(d1Installed(root, manifest)).toBe(false);
    expect(existsSync(join(dir, 'install.json'))).toBe(false);
    expect(existsSync(join(meeting, 'keep'))).toBe(true);
    if (engine.installed()) engine.prepare(2);
    expect(launched).toHaveLength(0);
    expect(engine.status().install).toBe('absent');
  });

  it('rounds the pinned download to about 1.1 GB', () => {
    const bytes = LINUX_X64_CPU.model.size + LINUX_X64_CPU.runtime.size;
    expect(bytes).toBe(1_122_688_508);
    const mb = Math.round(bytes / 1_000_000);
    expect(mb).toBe(1123);
    expect((mb / 1000).toFixed(1)).toBe('1.1');
  });
});
