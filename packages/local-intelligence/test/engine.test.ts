import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionCancellation } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { type EngineOptions, LocalEmbeddingEngine } from '../src/engine/engine.ts';
import { bundleDir } from '../src/install.ts';
import { fakeLauncher, flush, ManualClock, markInstalled } from './fake-helper.ts';
import { tempDir, testBundle } from './helpers.ts';

function setup(overrides: Partial<EngineOptions> = {}) {
  const root = tempDir();
  const bundle = testBundle();
  markInstalled(root, bundle);
  const clock = new ManualClock();
  const launcher = fakeLauncher();
  const engine = new LocalEmbeddingEngine({
    root,
    bundle,
    target: 'linux-x64',
    helperPath: '/opt/helper',
    launch: launcher.launch,
    threads: 6,
    now: clock.now,
    timers: clock,
    ...overrides,
  });
  return { root, bundle, clock, launcher, engine };
}

function cancellable() {
  const handlers = new Set<() => void>();
  let aborted = false;
  const signal: DecisionCancellation = {
    get aborted() {
      return aborted;
    },
    onCancel(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
  };
  return {
    signal,
    cancel() {
      aborted = true;
      for (const fn of handlers) fn();
    },
  };
}

const single = (text: string) =>
  ({ texts: [text], task: 'classification', overflow: 'truncate' }) as const;
const meeting = (...texts: string[]) =>
  ({ texts, task: 'clustering', overflow: 'chunk_average' }) as const;

describe('local embedding engine', () => {
  it('starts the helper on first use with the bundle paths and returns vectors', async () => {
    const { engine, launcher, root, bundle } = setup();
    expect(engine.status().state).toBe('idle');
    const result = engine.embed(single('  rename a variable  '));
    await flush();
    const helper = launcher.last();
    const dir = bundleDir(root, bundle);
    expect(helper.command.executable).toBe('/opt/helper');
    expect(helper.command.cwd).toBe(dir);
    expect(helper.command.args).toEqual([
      '--lib',
      join(dir, 'libfake.so'),
      '--model',
      join(dir, 'model.litertlm'),
      '--max-input',
      '256',
      '--backend',
      'cpu',
      '--threads',
      '6',
      '--cache-dir',
      join(dir, 'cache'),
      '--api-major',
      '1',
      '--api-minor',
      '0',
    ]);
    // LiteRT-LM refuses a cache folder that does not exist; a fresh install has none.
    expect(existsSync(join(dir, 'cache'))).toBe(true);
    expect(engine.status().state).toBe('starting');
    helper.ready();
    await flush();
    expect(helper.sent[0]).toEqual({
      id: 1,
      texts: ['task: classification | query: rename a variable'],
      overflow: 'truncate',
      dim: 4,
    });
    helper.answer();
    const vectors = await result;
    expect(vectors).toHaveLength(1);
    expect(Array.from(vectors[0]!)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(engine.status()).toMatchObject({
      state: 'ready',
      requestedDevice: 'cpu',
      actualDevice: 'cpu',
    });
  });

  it('serves a repeated text from the cache but computes another overflow separately', async () => {
    const { engine, launcher } = setup();
    const first = engine.embed(single('same text'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    helper.answer(0, 0.25);
    await first;
    const chunked = engine.embed({ ...meeting('same text'), task: 'classification' });
    await flush();
    expect(helper.sent).toHaveLength(2);
    helper.answer(1, 0.75);
    expect(Array.from((await chunked)[0]!)).toEqual([0.75, 0.75, 0.75, 0.75]);
    expect(Array.from((await engine.embed(single('same text')))[0]!)).toEqual([
      0.25, 0.25, 0.25, 0.25,
    ]);
    expect(helper.sent).toHaveLength(2);
  });

  it("rejects a vector whose size is not the model's", async () => {
    const root = tempDir();
    const base = testBundle();
    const bundle = {
      ...base,
      models: { meeting: { ...base.models.meeting, dims: 8 } },
    };
    markInstalled(root, bundle);
    const launcher = fakeLauncher();
    const engine = new LocalEmbeddingEngine({
      root,
      bundle,
      target: 'linux-x64',
      helperPath: '/opt/helper',
      launch: launcher.launch,
      threads: 6,
    });
    const right = engine.embed(single('x'));
    await flush();
    launcher.last().ready();
    await flush();
    expect(launcher.last().sent[0]).toMatchObject({ dim: 8 });
    launcher.last().answer(0);
    await expect(right).resolves.toHaveLength(1);
    const wrong = engine.embed(meeting('y'));
    await flush();
    launcher.last().emitResult(1, 4);
    await expect(wrong).rejects.toThrow(/unexpected embedding shape/);
  });

  it('serves waiting requests in arrival order', async () => {
    const { engine, launcher } = setup();
    const first = engine.embed(meeting('a'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    const second = engine.embed(meeting('b'));
    const third = engine.embed(single('c'));
    await flush();
    expect(helper.sent).toHaveLength(1);
    helper.answer(0);
    await first;
    await flush();
    expect(helper.sent[1]!.texts).toEqual(['task: clustering | query: b']);
    helper.answer(1);
    await second;
    await flush();
    expect(helper.sent[2]!.texts).toEqual(['task: classification | query: c']);
    helper.answer(2);
    await third;
  });

  it('drops a cancelled caller but keeps the slot until the helper answers', async () => {
    const { engine, launcher } = setup();
    const warm = engine.embed(single('warm'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    helper.answer();
    await warm;

    const caller = cancellable();
    const slow = engine.embed(single('slow'), caller.signal);
    await flush();
    const next = engine.embed(single('next'));
    caller.cancel();
    await expect(slow).rejects.toThrow(/cancelled/);
    await flush();
    // The helper is still computing `slow`: nothing else is sent until it answers.
    expect(helper.sent.map((r) => r.texts[0])).toEqual([
      'task: classification | query: warm',
      'task: classification | query: slow',
    ]);
    helper.answer(1);
    await flush();
    expect(helper.sent).toHaveLength(3);
    helper.answer(2);
    await next;
  });

  it('removes a cancelled waiting request without sending it, and refuses when the queue is full', async () => {
    const { engine, launcher } = setup();
    const active = engine.embed(single('active'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    const caller = cancellable();
    const waiting = engine.embed(single('waiting'), caller.signal);
    caller.cancel();
    await expect(waiting).rejects.toThrow(/cancelled/);
    const queued = Array.from({ length: 16 }, (_, i) => engine.embed(single(`${i + 1}`)));
    await expect(engine.embed(single('17'))).rejects.toThrow(/queue is full/);
    helper.answer(0);
    await active;
    for (let i = 1; i <= 16; i++) {
      await flush();
      helper.answer(i);
      await queued[i - 1];
    }
    expect(helper.sent.map((r) => r.texts[0])).not.toContain(
      'task: classification | query: waiting',
    );
  });

  it('fails waiting work when the helper dies, then cools down before restarting', async () => {
    const { engine, launcher, clock } = setup();
    const first = engine.embed(single('a'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    const second = engine.embed(single('b'));
    helper.exit('segfault');
    await expect(first).rejects.toThrow(/stopped/);
    await expect(second).rejects.toThrow(/stopped/);
    expect(engine.status()).toMatchObject({ state: 'error', actualDevice: null });
    await expect(engine.embed(single('c'))).rejects.toThrow(/unavailable/);
    expect(launcher.helpers).toHaveLength(1);
    clock.advance(60_000);
    const third = engine.embed(single('d'));
    await flush();
    expect(launcher.helpers).toHaveLength(2);
    launcher.last().ready();
    await flush();
    launcher.last().answer();
    await third;
  });

  it('keeps a failed request from stopping the helper', async () => {
    const { engine, launcher } = setup();
    const bad = engine.embed(single('bad'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    helper.error();
    await expect(bad).rejects.toThrow(/bad input/);
    expect(engine.status().state).toBe('ready');
  });

  it('falls back to the CPU on auto when the GPU does not start, but not on explicit GPU', async () => {
    const auto = setup({ device: 'auto' });
    const result = auto.engine.embed(single('x'));
    await flush();
    expect(auto.launcher.last().backend).toBe('gpu');
    auto.launcher.last().fatal('no adapter');
    await flush();
    const cpu = auto.launcher.last();
    expect(auto.launcher.helpers).toHaveLength(2);
    expect(cpu.backend).toBe('cpu');
    cpu.ready();
    await flush();
    cpu.answer();
    await result;
    expect(auto.engine.status()).toMatchObject({
      state: 'ready',
      requestedDevice: 'auto',
      actualDevice: 'cpu',
      error: null,
    });

    const gpu = setup({ device: 'gpu' });
    const failed = gpu.engine.embed(single('x'));
    await flush();
    gpu.launcher.last().fatal('no adapter');
    await expect(failed).rejects.toThrow(/no adapter/);
    expect(gpu.launcher.helpers).toHaveLength(1);
    expect(gpu.engine.status()).toMatchObject({
      state: 'error',
      requestedDevice: 'gpu',
      actualDevice: null,
    });
  });

  it('stops a helper that never becomes ready', async () => {
    const { engine, launcher, clock } = setup();
    const result = engine.embed(single('x'));
    await flush();
    clock.advance(60_000);
    await expect(result).rejects.toThrow(/did not start/);
    expect(launcher.last().killed).toBe(true);
    expect(engine.status().state).toBe('error');
  });

  it('changes device by refusing waiting work and restarting the helper', async () => {
    const { engine, launcher } = setup();
    const active = engine.embed(single('a'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    const waiting = engine.embed(single('b'));
    await engine.setDevice('gpu');
    await expect(active).rejects.toThrow(/device/);
    await expect(waiting).rejects.toThrow(/device/);
    expect(helper.killed).toBe(true);
    expect(engine.status()).toMatchObject({
      state: 'idle',
      requestedDevice: 'gpu',
      actualDevice: null,
    });
    const next = engine.embed(single('c'));
    await flush();
    expect(launcher.last().backend).toBe('gpu');
    expect(launcher.last().command.args).toContain('0');
    launcher.last().ready();
    await flush();
    launcher.last().answer();
    await next;
    expect(engine.status().actualDevice).toBe('gpu');
  });

  it('closes once: refuses all work and stops the helper', async () => {
    const { engine, launcher } = setup();
    const active = engine.embed(single('a'));
    await flush();
    launcher.last().ready();
    await flush();
    await Promise.all([engine.close(), engine.close()]);
    await expect(active).rejects.toThrow(/closed/);
    expect(launcher.last().killed).toBe(true);
    await expect(engine.embed(single('b'))).rejects.toThrow(/closed/);
  });

  it('reuses vectors for the same task and text, but not across tasks', async () => {
    const { engine, launcher } = setup();
    const first = engine.embed(single('same'));
    await flush();
    const helper = launcher.last();
    helper.ready();
    await flush();
    helper.answer();
    await first;
    await engine.embed(single('same'));
    expect(helper.sent).toHaveLength(1);
    const other = engine.embed({ ...meeting('same'), overflow: 'truncate' });
    await flush();
    expect(helper.sent).toHaveLength(2);
    helper.answer();
    await other;
  });

  it('starts nothing when the bundle is not installed or the target is unsupported', async () => {
    const root = tempDir();
    const launcher = fakeLauncher();
    const engine = new LocalEmbeddingEngine({
      root,
      bundle: testBundle(),
      target: 'linux-x64',
      helperPath: '/opt/helper',
      launch: launcher.launch,
      threads: 6,
    });
    expect(engine.status().state).toBe('missing');
    await expect(engine.embed(single('x'))).rejects.toThrow(/not installed/);
    const unsupported = new LocalEmbeddingEngine({
      root,
      bundle: testBundle(),
      target: null,
      helperPath: '/opt/helper',
      launch: launcher.launch,
      threads: 6,
    });
    expect(unsupported.status().state).toBe('unsupported');
    const noHelper = new LocalEmbeddingEngine({
      root,
      bundle: testBundle(),
      target: 'linux-x64',
      helperPath: null,
      launch: launcher.launch,
      threads: 6,
    });
    expect(noHelper.status()).toMatchObject({ state: 'unsupported' });
    expect(noHelper.available()).toMatch(/helper/);
    expect(launcher.helpers).toHaveLength(0);
  });
});
