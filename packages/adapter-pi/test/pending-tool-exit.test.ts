import type { AgentHost, AgentStartInput, ToolOutcome } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { LEGACY_PROTOCOL_VERSION as protocolVersion } from '../src/protocol.ts';
import { recordingHost } from './harness.ts';

const executionId = 'exec_pending';
const tick = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function input(): AgentStartInput {
  const role = linearCorral(['writer']).roles[0];
  if (!role) throw new Error('test writer role is missing');
  return {
    runId: 'run_pending',
    executionId,
    taskId: 'task_pending',
    nodeId: 'writer',
    attemptNo: 1,
    role,
    modelProfile: 'model-a',
    mode: 'live',
    model: { profile: 'model-a', provider: 'openai', modelId: 'faux-1', auth: 'mock' },
    depth: 0,
    round: null,
    criteriaVersionId: 'criteria_pending',
    assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [] },
    inputs: [],
  };
}

async function fixture(overrides: Partial<AgentHost> = {}) {
  const pair = memoryChannelPair();
  const sent = vi.spyOn(pair.host, 'send');
  const pending = deferred<ToolOutcome>();
  const execute = vi.fn(() => pending.promise);
  const adapter = new PiAgentAdapter({
    spawn: () => pair.host,
    credentials: async () => null,
    cancelGraceMs: 50,
  });
  const handle = await adapter.start(
    input(),
    recordingHost({ executeTool: execute, ...overrides }).host,
  );
  const send = (frame: Record<string, unknown>) =>
    pair.worker.send({ ...frame, protocolVersion, executionId });
  pair.worker.send({ type: 'ready', protocolVersion });
  await tick();
  const results = () =>
    sent.mock.calls
      .map(([frame]) => frame)
      .filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          'type' in frame &&
          frame.type === 'tool_result',
      );
  return { ...pair, handle, pending, execute, send, results };
}

const outcome: ToolOutcome = {
  ok: true,
  toolCallId: 'tool_pending',
  result: { outcome: 'answered' },
};
const observe = {
  type: 'observe',
  modelCallId: 'call_pending',
  text: '',
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
  rawUsage: null,
};

afterEach(() => vi.useRealTimers());

describe('pending host tool does not retain an exited Pi worker (C-017)', () => {
  it.each(['ask', 'await_tasks'])(
    '[TC-ABS-011-N] an unexpected exit settles before a pending %s call completes',
    async (name) => {
      const f = await fixture();
      try {
        f.send({ type: 'authorize_tool', requestId: 'req_1', name, args: {} });
        f.send({ type: 'execute_tool', requestId: 'req_2', toolCallId: 'tool_pending' });
        await tick();
        expect(f.execute).toHaveBeenCalledExactlyOnceWith('tool_pending');
        let settlement: unknown;
        void f.handle.waitForSettlement().then((value) => {
          settlement = value;
        });
        f.worker.kill();
        await tick();
        expect(settlement).toMatchObject({
          outcome: 'failed',
          error: 'the model worker stopped unexpectedly (exit 0)',
        });
        expect(f.results()).toEqual([]);
      } finally {
        f.pending.resolve(outcome);
        f.worker.kill();
        await tick();
      }
    },
  );

  it.each(['resolve', 'reject'] as const)(
    '[TC-ABS-011-N] a late %s cannot send a result during exit queue draining',
    async (completion) => {
      const observed = deferred<void>();
      const f = await fixture({ observe: () => observed.promise });
      try {
        f.send({ type: 'execute_tool', requestId: 'req_1', toolCallId: 'tool_pending' });
        await tick();
        f.send(observe);
        await tick();
        f.worker.kill();
        await tick();
        if (completion === 'resolve') f.pending.resolve(outcome);
        else f.pending.reject(new Error('private provider request'));
        await tick();
        // Inspect sends at the host boundary: the closed memory transport also drops frames.
        expect(f.results()).toEqual([]);
      } finally {
        observed.resolve();
        f.pending.resolve(outcome);
        f.worker.kill();
        await tick();
      }
      await expect(f.handle.waitForSettlement()).resolves.toMatchObject({ outcome: 'failed' });
    },
  );

  it('[TC-ABS-011-N] records a worker cancellation while its host tool is pending', async () => {
    const f = await fixture();
    try {
      f.send({ type: 'execute_tool', requestId: 'req_1', toolCallId: 'tool_pending' });
      await tick();
      await f.handle.cancel('test cancellation');
      f.send({ type: 'settled', outcome: 'cancelled' });
      await tick();
      f.worker.kill();
      let settlement: unknown;
      void f.handle.waitForSettlement().then((value) => {
        settlement = value;
      });
      await tick();
      expect(settlement).toEqual({ outcome: 'cancelled' });
      f.pending.resolve(outcome);
      await tick();
      expect(f.results()).toEqual([]);
    } finally {
      f.pending.resolve(outcome);
      f.worker.kill();
      await tick();
    }
  });

  it('[TC-ABS-011-N] confirmed forced exit is not mislabeled unconfirmed by a pending tool', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      f.send({ type: 'execute_tool', requestId: 'req_1', toolCallId: 'tool_pending' });
      await tick();
      await f.handle.cancel('test cancellation');
      await vi.advanceTimersByTimeAsync(50);
      let settlement: unknown;
      void f.handle.waitForSettlement().then((value) => {
        settlement = value;
      });
      await tick();
      expect(settlement).toMatchObject({ outcome: 'cancelled', terminationMode: 'forced' });
      await vi.advanceTimersByTimeAsync(100);
      expect(settlement).toMatchObject({ outcome: 'cancelled', terminationMode: 'forced' });
    } finally {
      f.pending.resolve(outcome);
      f.worker.kill();
      await tick();
    }
  });

  it('[TC-ABS-011-N] suppresses a late result after settlement is reported but before exit', async () => {
    const f = await fixture();
    try {
      f.send({ type: 'execute_tool', requestId: 'req_1', toolCallId: 'tool_pending' });
      await tick();
      f.send({ type: 'settled', outcome: 'cancelled' });
      await tick();
      f.pending.resolve(outcome);
      await tick();
      expect(f.results()).toEqual([]);
      let ended = false;
      void f.handle.waitForSettlement().then(() => {
        ended = true;
      });
      await tick();
      expect(ended).toBe(false);
      f.worker.kill();
      await expect(f.handle.waitForSettlement()).resolves.toEqual({ outcome: 'cancelled' });
    } finally {
      f.pending.resolve(outcome);
      f.worker.kill();
      await tick();
    }
  });

  it('[TC-ABS-011-N] returns a sanitized failure for a rejected live tool promise', async () => {
    const f = await fixture();
    try {
      f.send({ type: 'execute_tool', requestId: 'req_1', toolCallId: 'tool_pending' });
      await tick();
      f.pending.reject(new Error('private provider request'));
      await tick();
      expect(f.results()).toEqual([
        expect.objectContaining({
          requestId: 'req_1',
          ok: false,
          reason: 'the host could not complete this request',
        }),
      ]);
    } finally {
      f.worker.kill();
      await tick();
    }
  });

  it('[TC-ABS-011-H] preserves observation and authorization order and returns one live result', async () => {
    const observed = deferred<void>();
    const authorized = deferred<void>();
    const calls: string[] = [];
    const f = await fixture({
      observe: async () => {
        await observed.promise;
        calls.push('observed');
      },
      authorizeTool: async () => {
        await authorized.promise;
        calls.push('authorized');
        return { ok: true, toolCallId: 'tool_pending' };
      },
    });
    try {
      f.send(observe);
      f.send({ type: 'authorize_tool', requestId: 'req_1', name: 'ask', args: {} });
      f.send({ type: 'execute_tool', requestId: 'req_2', toolCallId: 'tool_pending' });
      await tick();
      expect(f.execute).not.toHaveBeenCalled();
      observed.resolve();
      await tick();
      expect(calls).toEqual(['observed']);
      expect(f.execute).not.toHaveBeenCalled();
      authorized.resolve();
      await tick();
      expect(calls).toEqual(['observed', 'authorized']);
      expect(f.execute).toHaveBeenCalledExactlyOnceWith('tool_pending');
      expect(f.results()).toEqual([]);
      f.pending.resolve(outcome);
      await tick();
      expect(f.results()).toEqual([
        expect.objectContaining({ requestId: 'req_2', ok: true, result: outcome.result }),
      ]);
    } finally {
      observed.resolve();
      authorized.resolve();
      f.pending.resolve(outcome);
      f.worker.kill();
      await tick();
    }
  });
});
