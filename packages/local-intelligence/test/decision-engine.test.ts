import { describe, expect, it } from 'vitest';
import { LocalDecisionEngine } from '../src/decision/engine.ts';
import type { DecisionEngineOptions, DecisionInput } from '../src/decision/types.ts';
import type { HelperCommand, HelperProcess } from '../src/engine/helper.ts';
import { flush, ManualClock } from './fake-helper.ts';

type Sent = DecisionInput & { id: number };
const effort = (prompt = 'fixed non-sensitive effort input'): DecisionInput => ({
  op: 'effort',
  prompt,
});
const meeting = (prompt = 'fixed non-sensitive meeting input'): DecisionInput => ({
  op: 'meeting',
  prompt,
  participantIds: ['p1', 'p2'],
});

class FakeDecisionHelper implements HelperProcess {
  readonly sent: Sent[] = [];
  killed = false;
  holdKill = false;
  rejectKill = false;
  private lines: ((line: string) => void)[] = [];
  private exits: ((detail: string) => void)[] = [];
  private releaseKill: (() => void) | null = null;
  write(line: string) {
    this.sent.push(JSON.parse(line) as Sent);
  }
  onLine(fn: (line: string) => void) {
    this.lines.push(fn);
  }
  onExit(fn: (detail: string) => void) {
    this.exits.push(fn);
  }
  async kill() {
    this.killed = true;
    if (this.rejectKill) throw new Error('/private/helper could not be terminated');
    if (this.holdKill)
      await new Promise<void>((resolve) => {
        this.releaseKill = resolve;
      });
    this.exit('private native path and prompt must not be exposed');
  }
  finishKill() {
    this.releaseKill?.();
  }
  emit(message: unknown) {
    for (const fn of this.lines) fn(JSON.stringify(message));
  }
  ready(backend = 'cpu', protocol = 1) {
    this.emit({ type: 'ready', backend, protocol });
  }
  exit(detail = '/private/model.gguf private prompt') {
    for (const fn of this.exits) fn(detail);
  }
  answer(index = this.sent.length - 1, overrides: Record<string, unknown> = {}) {
    const request = this.sent[index];
    if (!request) throw new Error('test request was not sent');
    this.emit({
      type: 'result',
      id: request.id,
      originalPromptTokens: 60,
      usedPromptTokens: 60,
      promptTokens: 60,
      inputBudget: request.inputBudget ?? null,
      inputTruncated: false,
      inputTokenFingerprint: '0123456789abcdef',
      inputTokenFingerprintAlgorithm: 'fnv1a64-le-u32',
      ...(request.op === 'effort'
        ? { logits: [0, 0, 0, 0], probabilities: [0.25, 0.25, 0.25, 0.25], level: 'low' }
        : { participantIds: ['p1'] }),
      ...overrides,
    });
  }
}

function setup(overrides: Partial<DecisionEngineOptions> = {}) {
  const clock = new ManualClock();
  const helpers: FakeDecisionHelper[] = [];
  const commands: HelperCommand[] = [];
  const engine = new LocalDecisionEngine({
    command: {
      executable: '/private/helper',
      args: ['/private/model.gguf', '6', '1024'],
      cwd: '/private',
      env: {},
    },
    backend: 'cpu',
    release: 'test-release',
    calibrationVersion: 'test-calibration',
    contextTokens: 1024,
    warmup: [effort(), meeting()],
    now: clock.now,
    timers: clock,
    launch: (command) => {
      commands.push(command);
      const helper = new FakeDecisionHelper();
      helpers.push(helper);
      return helper;
    },
    ...overrides,
  });
  const last = () => {
    const helper = helpers.at(-1);
    if (!helper) throw new Error('test helper was not launched');
    return helper;
  };
  const request = (input = effort(), options: { signal?: AbortSignal; deadlineMs?: number } = {}) =>
    engine.decide(input, { deadlineMs: clock.now() + 3_000, ...options });
  const ready = async () => {
    const warming = engine.warmUp();
    await flush();
    last().ready();
    await flush();
    last().answer();
    await flush();
    last().answer();
    await warming;
  };
  return { clock, helpers, commands, engine, last, request, ready };
}

describe('native decision engine process boundary', () => {
  it('does not report ready or send user input until every fixed warmup succeeds', async () => {
    const { engine, request, last, commands } = setup();
    const result = request(effort('private user request'));
    await flush();
    expect(engine.status().state).toBe('starting');
    last().ready();
    expect(engine.status().state).toBe('loaded');
    await flush();
    expect(engine.status()).toMatchObject({ state: 'warming', actualBackend: 'cpu' });
    expect(engine.isReady()).toBe(false);
    expect(last().sent.map((r) => r.prompt)).toEqual(['fixed non-sensitive effort input']);
    last().answer();
    await flush();
    expect(last().sent.map((r) => r.op)).toEqual(['effort', 'meeting']);
    last().answer();
    await flush();
    expect(engine.status()).toMatchObject({
      state: 'ready',
      release: 'test-release',
      calibrationVersion: 'test-calibration',
    });
    expect(last().sent[2]?.prompt).toBe('private user request');
    last().answer();
    expect(await result).toMatchObject({
      op: 'effort',
      release: 'test-release',
      backend: 'cpu',
      logits: [0, 0, 0, 0],
    });
    expect(commands[0]?.env).toEqual({});
    expect(JSON.stringify(engine.status())).not.toContain('/private');
    await engine.close();
  });

  it('owns an initializing helper and waits for its exit during close', async () => {
    const { engine, last, helpers, request } = setup();
    const warming = engine.warmUp().catch((error: Error) => error.message);
    await flush();
    last().holdKill = true;
    let closed = false;
    const closing = engine.close().then(() => {
      closed = true;
    });
    expect(last().killed).toBe(true);
    last().ready();
    await flush();
    expect(closed).toBe(false);
    expect(engine.isReady()).toBe(false);
    expect(last().sent).toHaveLength(0);
    last().finishKill();
    await closing;
    expect(await warming).toContain('closed');
    await expect(request()).rejects.toMatchObject({ code: 'closed' });
    expect(helpers).toHaveLength(1);
  });

  it('kills active cancellation and waits before replacement; old replies cannot resolve new work', async () => {
    const { engine, ready, request, last, helpers } = setup();
    await ready();
    const old = last();
    old.holdKill = true;
    const abort = new AbortController();
    const active = request(effort('cancelled attempt'), { signal: abort.signal }).catch(
      (error) => error.code,
    );
    const next = request(effort('new attempt'));
    abort.abort();
    expect(await active).toBe('cancelled');
    expect(old.killed).toBe(true);
    await flush();
    expect(helpers).toHaveLength(1);
    old.answer(2);
    await flush();
    expect(helpers).toHaveLength(1);
    old.finishKill();
    await flush();
    expect(helpers).toHaveLength(2);
    last().ready();
    await flush();
    last().answer();
    await flush();
    last().answer();
    await flush();
    expect(last().sent[2]?.prompt).toBe('new attempt');
    const cancelledId = old.sent[2]?.id;
    if (cancelledId === undefined) throw new Error('cancelled request was not sent');
    expect(last().sent[2]?.id).toBeGreaterThan(cancelledId);
    let settled = false;
    void next.then(() => {
      settled = true;
    });
    old.answer(2);
    await flush();
    expect(settled).toBe(false);
    last().answer();
    await next;
    await engine.close();
  });

  it('removes queued aborts and expired queued deadlines without killing the active process', async () => {
    const { engine, ready, request, last, clock } = setup();
    await ready();
    const active = request();
    const abort = new AbortController();
    const cancelled = request(meeting(), { signal: abort.signal }).catch((error) => error.code);
    const expired = request(meeting(), { deadlineMs: clock.now() + 10 }).catch(
      (error) => error.code,
    );
    abort.abort();
    clock.advance(10);
    expect(await cancelled).toBe('cancelled');
    expect(await expired).toBe('timeout');
    expect(last().killed).toBe(false);
    expect(last().sent).toHaveLength(3);
    last().answer();
    await active;
    await engine.close();
  });

  it('kills a timed-out active request and never retries its lost response', async () => {
    const { engine, ready, request, clock, last, helpers } = setup();
    await ready();
    const timed = request(effort('lost response'), { deadlineMs: clock.now() + 10 }).catch(
      (error) => error.code,
    );
    clock.advance(10);
    expect(await timed).toBe('timeout');
    expect(last().killed).toBe(true);
    await flush();
    expect(helpers).toHaveLength(1);
    await engine.close();
  });

  it('does not dispatch an expired queued request when its timer has not run yet', async () => {
    const { engine, ready, request, clock, last } = setup();
    await ready();
    const active = request();
    const expired = request(effort('already expired'), { deadlineMs: clock.now() + 10 }).catch(
      (error) => error.code,
    );
    clock.time += 20; // A response callback runs before the due timer callback.
    last().answer();
    await active;
    await flush();
    expect(last().sent).toHaveLength(3);
    expect(await expired).toBe('timeout');
    await engine.close();
  });

  it('does not replace a process whose termination could not be confirmed', async () => {
    const { engine, ready, request, last, helpers } = setup();
    await ready();
    last().rejectKill = true;
    const abort = new AbortController();
    const active = request(effort(), { signal: abort.signal }).catch((error) => error.code);
    abort.abort();
    expect(await active).toBe('cancelled');
    await flush();
    await expect(request()).rejects.toMatchObject({ code: 'unavailable' });
    expect(helpers).toHaveLength(1);
    expect(engine.status().error).toBe('helper_failed');
    expect(JSON.stringify(engine.status())).not.toContain('/private');
    await expect(engine.close()).rejects.toMatchObject({ code: 'helper_failed' });
  });

  it('counts initialization against the caller deadline while keeping warmup independent', async () => {
    const { engine, request, clock, last } = setup();
    const waiting = request(effort('deadline'), { deadlineMs: clock.now() + 10 }).catch(
      (error) => error.code,
    );
    clock.advance(10);
    expect(await waiting).toBe('timeout');
    expect(last().sent).toHaveLength(0);
    expect(last().killed).toBe(false);
    await engine.close();
  });

  it('requires warmup again after startup timeout and the retry cooldown', async () => {
    const { engine, clock, last, helpers } = setup({ startupTimeoutMs: 100 });
    const warm = engine.warmUp().catch((error) => error.code);
    await flush();
    clock.advance(100);
    expect(await warm).toBe('startup_timeout');
    expect(last().killed).toBe(true);
    await expect(engine.warmUp()).rejects.toMatchObject({ code: 'unavailable' });
    clock.advance(60_000);
    const retry = engine.warmUp();
    await flush();
    expect(helpers).toHaveLength(2);
    last().ready();
    await flush();
    expect(engine.isReady()).toBe(false);
    last().answer();
    await flush();
    last().answer();
    await retry;
    expect(engine.isReady()).toBe(true);
    await engine.close();
  });

  it('redacts helper failures, rejects existing work, and only retries a new request', async () => {
    const { engine, ready, request, clock, last, helpers } = setup();
    await ready();
    const active = request(effort('private prompt')).catch((error: Error) => error.message);
    const queued = request().catch((error: Error) => error.message);
    last().exit('/private/model.gguf private prompt');
    expect(await active).toBe('local decision engine: helper_failed');
    expect(await queued).toBe('local decision engine: helper_failed');
    expect(JSON.stringify(engine.status())).not.toMatch(/private|prompt/);
    await flush();
    expect(helpers).toHaveLength(1);
    clock.advance(60_000);
    const next = request(effort('new request'));
    await flush();
    last().ready();
    await flush();
    last().answer();
    await flush();
    last().answer();
    await flush();
    expect(last().sent.map((r) => r.prompt)).not.toContain('private prompt');
    last().answer();
    await next;
    await engine.close();
  });

  it.each([
    ['gpu', 1],
    ['cpu', 2],
  ])('rejects a mismatched ready backend/protocol (%s, %s)', async (backend, protocol) => {
    const { engine, last } = setup();
    const warm = engine.warmUp().catch((error) => error.code);
    await flush();
    last().ready(backend as string, protocol as number);
    expect(await warm).toBe('invalid_response');
    expect(engine.status().actualBackend).toBeNull();
    expect(last().killed).toBe(true);
    await engine.close();
  });

  it('does not accept warmup failure as readiness', async () => {
    const { engine, request, last } = setup();
    const pending = request().catch((error) => error.code);
    await flush();
    last().ready();
    await flush();
    last().emit({ type: 'error', id: last().sent[0]?.id, error: '/private/secret raw prompt' });
    expect(await pending).toBe('invalid_response');
    expect(engine.isReady()).toBe(false);
    await engine.close();
  });

  it('retires the process on a native inference failure', async () => {
    const { engine, ready, request, last } = setup();
    await ready();
    const pending = request().catch((error) => error.code);
    last().emit({ type: 'error', id: last().sent.at(-1)?.id, error: 'inference_failed' });
    expect(await pending).toBe('helper_failed');
    expect(last().killed).toBe(true);
    expect(engine.isReady()).toBe(false);
    await engine.close();
  });

  it('accepts the existing DecisionCancellation contract and removes its subscription', async () => {
    const { engine, ready, clock, last } = setup();
    await ready();
    let cancel = () => {};
    let removed = false;
    const pending = engine
      .decide(effort(), {
        deadlineMs: clock.now() + 1_000,
        cancellation: {
          aborted: false,
          onCancel: (fn) => {
            cancel = fn;
            return () => {
              removed = true;
            };
          },
        },
      })
      .catch((error) => error.code);
    cancel();
    expect(await pending).toBe('cancelled');
    expect(removed).toBe(true);
    expect(last().killed).toBe(true);
    await engine.close();
  });

  it('validates scores, recipient IDs, and input-budget metadata instead of trusting JSON', async () => {
    const { engine, ready, request, last } = setup();
    await ready();
    for (const [input, answer] of [
      [effort(), { probabilities: [0.1, 0.1, 0.1, 0.1] }],
      [effort(), { probabilities: [0.1, 0.2, 0.3, 0.4] }],
      [meeting(), { participantIds: ['unregistered'] }],
      [meeting(), { participantIds: ['p1', 'p1'] }],
      [{ ...effort(), inputBudget: 256 }, { inputBudget: 512 }],
    ] as const) {
      const result = request(input).catch((error) => error.code);
      last().answer(undefined, answer);
      expect(await result).toBe('invalid_response');
      await flush();
    }
    const valid = request(meeting());
    last().answer();
    expect(await valid).toMatchObject({ participantIds: ['p1'] });
    await engine.close();
  });

  it('serializes requests, prioritizes waiting effort, ignores duplicate replies, and bounds the queue', async () => {
    const { engine, ready, request, last } = setup({ queueLimit: 2 });
    await ready();
    const active = request(meeting('first'));
    const waiting = request(meeting('second'));
    const urgent = request(effort('third'));
    await expect(request()).rejects.toMatchObject({ code: 'queue_full' });
    expect(last().sent).toHaveLength(3);
    last().answer(2);
    await active;
    await flush();
    expect(last().sent[3]?.prompt).toBe('third');
    last().answer(2);
    await flush();
    expect(last().sent).toHaveLength(4);
    last().answer(3);
    await urgent;
    await flush();
    expect(last().sent[4]?.prompt).toBe('second');
    last().answer(4);
    await waiting;
    await engine.close();
  });

  it('rejects invalid/pre-cancelled/expired inputs without starting a process', async () => {
    const { engine, request, clock, helpers } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(request(effort(), { signal: abort.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    await expect(request(effort(), { deadlineMs: clock.now() })).rejects.toMatchObject({
      code: 'timeout',
    });
    await expect(request({ ...meeting(), inputBudget: 1024 })).rejects.toMatchObject({
      code: 'invalid_budget',
    });
    expect(helpers).toHaveLength(0);
    await engine.close();
    expect(() => setup({ warmup: [] })).toThrow('invalid_request');
  });
});
