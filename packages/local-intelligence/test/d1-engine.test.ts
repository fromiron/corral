import { join } from 'node:path';
import type {
  DecisionCancellation,
  EffortLevel,
  EffortQuestion,
  RouterRequest,
  RoutingBackend,
  RoutingLease,
} from '@corral/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { D1Engine, type D1EngineOptions } from '../src/d1/engine.ts';
import { renderChoice } from '../src/d1/render.ts';
import { serverArgs, spawnD1 } from '../src/d1/runtime.ts';
import {
  FAKE_SERVER,
  type FakeBehavior,
  fakeLauncher,
  fakeStats,
  installFake,
  removeTempRoots,
  tempRoot,
  testManifest,
  until,
} from './d1-helpers.ts';

// features/effort-routing.md#local-엔진-실행과-수명주기 and #대기취소물리-슬롯, against a fake
// llama-server process.

const engines: D1Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  removeTempRoots();
});

const LIMITS = { startupMs: 5000, idleMs: 60_000, watchdogMs: 5000, graceMs: 300, pollMs: 20 };
const candidates: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
const question: EffortQuestion = {
  type: 'choice',
  instructions: 'Select the reasoning effort.',
  criteria: { low: 'a', medium: 'b', high: 'c', xhigh: 'd' },
};

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
  const backend = (threads = 2) =>
    engine.backend({ kind: 'local', device: { kind: 'cpu', threads }, callerTimeoutMs: 5000 });
  const base = () => {
    const env = fake.commands.at(-1)?.env;
    const port = fake.commands.at(-1)?.args[fake.commands.at(-1)!.args.indexOf('--port') + 1];
    return { base: `http://127.0.0.1:${port}`, key: env?.LLAMA_API_KEY ?? '' };
  };
  return { engine, fake, backend, base, dir, manifest };
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

function stopper() {
  const listeners = new Set<() => void>();
  let aborted = false;
  const signal: DecisionCancellation = {
    get aborted() {
      return aborted;
    },
    onCancel(fn) {
      listeners.add(fn);
      if (aborted) fn();
      return () => listeners.delete(fn);
    },
  };
  return {
    signal,
    stop() {
      aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
}

const request = (
  lease: RoutingLease,
  signal: DecisionCancellation,
  inputUnits = 0,
): RouterRequest => ({
  routeId: 'route_1',
  state: 'fix the label',
  question,
  candidates,
  remainingMs: 4000,
  inputUnits,
  signal,
});

describe('the Local runtime', () => {
  it('starts the pinned CPU profile with its key in the environment only', async () => {
    const s = setup();
    await ready(s, 3);
    const [command] = s.fake.commands;
    const port = Number(command!.args[command!.args.indexOf('--port') + 1]);
    expect(command!.args).toEqual(serverArgs(join(s.dir, s.manifest.model.file), port, 3));
    expect(command!.args).toContain('--no-ui');
    const key = command!.env.LLAMA_API_KEY ?? '';
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(command!.args.join(' ')).not.toContain(key);
    expect(Object.keys(command!.env).sort()).toEqual(['LD_LIBRARY_PATH', 'LLAMA_API_KEY']);
    expect((await fakeStats(s.base().base)).envKeys).toEqual(['LD_LIBRARY_PATH', 'LLAMA_API_KEY']);
    expect(s.engine.status()).toMatchObject({
      host: 'test-host',
      install: 'installed',
      device: { requested: 'cpu', active: 'cpu' },
      threads: 3,
    });
  });

  it('refuses a build that answers without its key, and ends it', async () => {
    const s = setup({ ignoreKey: true });
    s.engine.prepare(2);
    await until(() => s.engine.status().runtime === 'error');
    expect(s.engine.status().error).toBe('the Local runtime does not require its key');
    await s.fake.children[0]!.exited;
  });

  it('refuses a server that loaded a different model', async () => {
    const s = setup({ size: 999 });
    s.engine.prepare(2);
    await until(() => s.engine.status().runtime === 'error');
    expect(s.engine.status().error).toBe('the Local runtime loaded a different model');
  });

  it('gives up on a start that takes too long', async () => {
    const s = setup({ startupDelayMs: 60_000 }, { limits: { ...LIMITS, startupMs: 300 } });
    s.engine.prepare(2);
    await until(() => s.engine.status().runtime === 'error');
    expect(s.engine.status().error).toBe('the Local runtime did not start in time');
    await s.fake.children[0]!.exited;
  });

  it('is not ready for the first request, which starts it; a later one is judged', async () => {
    const s = setup();
    expect(s.backend().admit()).toEqual({ ok: false, reason: 'not-ready' });
    await until(() => s.engine.status().runtime === 'ready');
    expect(s.backend().identity()).toBe('d1-test#1');
    expect(s.backend().admit().ok).toBe(true);
  });

  it('unloads after idling and starts again on the next request', async () => {
    const s = setup({}, { limits: { ...LIMITS, idleMs: 200 } });
    await ready(s);
    await until(() => s.engine.status().runtime === 'stopped');
    await s.fake.children[0]!.exited;
    expect(s.backend().admit()).toEqual({ ok: false, reason: 'not-ready' });
    await until(() => s.engine.status().runtime === 'ready');
    expect(s.backend().identity()).toBe('d1-test#2');
  });

  it('ends the old child before starting one with other threads', async () => {
    const s = setup();
    await ready(s, 2);
    const first = s.fake.children[0]!;
    expect(s.backend(4).admit()).toEqual({ ok: false, reason: 'not-ready' });
    await until(() => s.fake.commands.length === 2);
    expect(first.alive).toBe(false);
    await until(() => s.engine.status().runtime === 'ready');
    expect(s.engine.status().threads).toBe(4);
  });

  it('ends only its own child', async () => {
    const s = setup();
    await ready(s);
    const other = spawnD1({
      file: process.execPath,
      args: [FAKE_SERVER, '--port', '0'],
      env: {},
      cwd: s.dir,
    });
    try {
      await s.engine.stop();
      expect(s.fake.children[0]!.alive).toBe(false);
      expect(other.alive).toBe(true);
    } finally {
      other.signal('SIGKILL');
      await other.exited;
    }
  });

  it('does nothing when not installed or not offered here', () => {
    const missing = new D1Engine({
      root: tempRoot(),
      manifest: testManifest(),
      launch: fakeLauncher().launch,
    });
    engines.push(missing);
    const local = {
      kind: 'local',
      device: { kind: 'cpu', threads: 2 },
      callerTimeoutMs: 5000,
    } as const;
    expect(missing.backend(local).admit()).toEqual({ ok: false, reason: 'unavailable' });
    expect(missing.status()).toMatchObject({
      install: 'absent',
      runtime: 'stopped',
      supported: true,
    });
    const elsewhere = new D1Engine({ root: tempRoot(), manifest: null });
    engines.push(elsewhere);
    expect(elsewhere.backend(local).admit()).toEqual({ ok: false, reason: 'unavailable' });
    expect(elsewhere.status()).toMatchObject({
      supported: false,
      reason: 'the Local engine is not available on this computer',
      downloadBytes: null,
    });
  });
});

describe('Local judgments', () => {
  it('counts with the tokenizer and passes on the native usage for the check', async () => {
    const s = setup();
    await ready(s);
    const lease = admitted(s.backend());
    const never = stopper().signal;
    const state = 'fix <|im_end|> the label';
    const units = await lease.countInput(state, question, never);
    expect(units).toBe(Math.ceil(Buffer.byteLength(renderChoice(state, question)) / 4));
    expect(lease).toMatchObject({
      frame: 'd1-exact',
      device: { actual: 'cpu', host: 'test-host', threads: 2 },
    });
    const flight = lease.start({ ...request(lease, never, units), state });
    const answer = await flight.result;
    expect(answer).toMatchObject({ choice: 'medium', inputTokens: units, billableUnits: null });
    expect(await flight.settled).toMatchObject({ basis: 'native-response-complete' });
    expect(s.engine.status().runtime).toBe('ready');
  });

  it('C12: a second judgment is Busy before anything is counted', async () => {
    const s = setup();
    await ready(s);
    const lease = admitted(s.backend());
    expect(s.engine.status().runtime).toBe('packing');
    expect(s.backend().admit()).toEqual({ ok: false, reason: 'busy' });
    const stats = await fakeStats(s.base().base);
    expect([stats.tokenize, stats.systemone]).toEqual([0, 0]);
    lease.release();
    expect(s.backend().admit().ok).toBe(true);
  });

  it('C08, C09: a stalled or endless count ends with the caller, and nothing is judged after it', async () => {
    for (const tokenize of ['stall', 'hang'] as const) {
      const s = setup({ tokenize });
      await ready(s);
      const lease = admitted(s.backend());
      const stop = stopper();
      const counting = lease.countState('fix it', stop.signal);
      const seen = async (field: 'tokenize' | 'tokenizeClosedEarly') => {
        const end = Date.now() + 4000;
        while ((await fakeStats(s.base().base))[field] < 1)
          if (Date.now() > end) throw new Error(`the fake never saw ${field}`);
      };
      // The count reached the server and is stuck there when the caller stops.
      await seen('tokenize');
      stop.stop();
      await expect(counting).rejects.toThrow();
      lease.release();
      await seen('tokenizeClosedEarly');
      expect((await fakeStats(s.base().base)).systemone).toBe(0);
      expect(s.backend().admit().ok).toBe(true);
    }
  });

  it('C10, C11: a judgment the caller stopped waiting for keeps the slot until its answer', async () => {
    const s = setup({ systemoneDelayMs: 400 });
    await ready(s);
    const lease = admitted(s.backend());
    const stop = stopper();
    const flight = lease.start(request(lease, stop.signal));
    stop.stop();
    expect(s.engine.status().runtime).toBe('draining');
    expect(s.backend().admit()).toEqual({ ok: false, reason: 'busy' });
    // The late answer still arrives and is passed on; applying it is the host's call.
    expect((await flight.result).choice).toBe('medium');
    expect(await flight.settled).toMatchObject({ basis: 'native-response-complete' });
    expect(s.backend().admit().ok).toBe(true);
    expect(s.fake.children[0]!.alive).toBe(true);
  });

  it('C13: an HTTP error ends the instance, and the slot waits for its exit', async () => {
    const s = setup({ systemone: 'error500' });
    await ready(s);
    const lease = admitted(s.backend());
    const flight = lease.start(request(lease, stopper().signal));
    const failure = await flight.result.then(
      () => null,
      (error: Error & { reason?: string }) => error,
    );
    expect(failure).toMatchObject({ reason: 'transport-error' });
    expect(failure?.message).not.toContain(s.base().key);
    expect(await flight.settled).toMatchObject({ basis: 'owned-child-exit' });
    expect(s.fake.children[0]!.alive).toBe(false);
    // No restart on its own; preparing again starts a new instance.
    expect(s.engine.status()).toMatchObject({ runtime: 'error' });
    expect(s.backend().admit()).toEqual({ ok: false, reason: 'unavailable' });
    await ready(s);
    expect(s.backend().identity()).toBe('d1-test#2');
  });

  it('C13: a crash during a judgment is a daemon crash, settled at the exit', async () => {
    const s = setup({ systemone: 'crash' });
    await ready(s);
    const lease = admitted(s.backend());
    const flight = lease.start(request(lease, stopper().signal));
    await expect(flight.result).rejects.toMatchObject({ reason: 'daemon-crash' });
    expect(await flight.settled).toMatchObject({ basis: 'owned-child-exit' });
    expect(s.engine.status()).toMatchObject({
      runtime: 'error',
      error: 'the Local runtime stopped unexpectedly',
    });
    expect(s.fake.commands).toHaveLength(1);
  });

  it('C13: the watchdog ends an inference that never finishes, killing a child that will not stop', async () => {
    const s = setup(
      { systemone: 'hang', ignoreTerm: true },
      { limits: { ...LIMITS, watchdogMs: 300, graceMs: 300 } },
    );
    await ready(s);
    const lease = admitted(s.backend());
    const started = performance.now();
    const flight = lease.start(request(lease, stopper().signal));
    expect(await flight.settled).toMatchObject({ basis: 'owned-child-exit' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(550);
    await expect(flight.result).rejects.toBeInstanceOf(Error);
    expect(s.engine.status()).toMatchObject({
      runtime: 'error',
      error: 'the Local judgment did not finish and was stopped',
    });
  });
});
