import type {
  AgentHost,
  DecisionCancellation,
  DecisionProvider,
  ReasoningInput,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, SPEC_HARD_CAPS } from '../src/index.ts';

const input: ReasoningInput = {
  kind: 'turn',
  request: 'solve the task',
  prevRequest: '',
  prev: '',
  step: 0,
  plan: '',
  calls: [],
  directiveIds: [],
};
const answer = {
  answer: 'high',
  probabilities: { low: 0, medium: 0, high: 1, xhigh: 0 },
  evidenceLevel: 'model_probability',
};
async function setup(
  decide: (input: ReasoningInput, cancellation: DecisionCancellation) => Promise<unknown>,
  observe = false,
  maxModelConcurrency = 6,
) {
  const clock = new FakeClock();
  const started = new Gate(),
    done = new Gate();
  let host!: AgentHost;
  let executionId = '';
  const provider: DecisionProvider = {
    id: 'local-model',
    version: 'v6',
    privacy: 'local',
    timeoutMs: 1500,
    questions: [{ kind: 'reasoning_effort', version: 1 }],
    available: () => true,
    decide: async () => answer,
    decideRequest: decide,
  };
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    policy: { ...SPEC_HARD_CAPS, maxModelConcurrency },
    agents: {
      start: async (i, h) => {
        host = h;
        executionId = i.executionId;
        started.open();
        return {
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' };
          },
        };
      },
    },
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: {
          profile,
          provider: 'openai-codex',
          modelId: 'gpt-6-luna',
          auth: 'oauth',
          reasoning: { levels: ['low', 'medium', 'high'], providerDefault: true },
        },
      }),
    },
    judgments: {
      providers: [provider],
      settings: {
        reasoning_effort: {
          mode: observe ? 'observe' : 'off',
          providers: observe ? ['local-model'] : [],
          apply: true,
          ...(observe ? { maxCalls: 2 } : {}),
        },
      },
    },
  });
  const team = linearCorral(['writer']);
  team.roles[0]!.reasoning = { mode: 'auto' };
  const start = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'live',
    definition: team,
  });
  expect(start.runId).not.toBeNull();
  await started.wait();
  const command = (type: 'cancel' | 'steer') =>
    coordinator.submit({
      schemaVersion: '0.1',
      runId: start.runId!,
      commandId: type,
      type,
      ...(type === 'cancel'
        ? { payload: { scope: { kind: 'run' }, reason: 'test' } }
        : {
            payload: {
              targetExecutionId: executionId,
              text: 'new instruction',
              delivery: 'next_request',
            },
          }),
    } as Parameters<Coordinator['submit']>[0]);
  return { coordinator, clock, host, runId: start.runId!, command, done };
}

describe('automatic reasoning admission', () => {
  it('local reasoning leaves the provider slot available', async () => {
    const judging = new Gate(),
      finish = new Gate();
    const s = await setup(
      async () => {
        judging.open();
        await finish.wait();
        return answer;
      },
      false,
      1,
    );
    const pending = s.host.prepareModelRequest(undefined, input);
    await judging.wait();
    let acquired = false;
    const auxiliary = s.coordinator
      .acquireAuxiliaryModelSlot({ aborted: false, onCancel: () => () => {} })
      .then((release) => {
        acquired = true;
        return release;
      });
    for (let n = 0; n < 20; n++) await Promise.resolve();
    try {
      expect(acquired).toBe(true);
    } finally {
      finish.open();
      s.command('cancel');
      await pending.catch(() => {});
      (await auxiliary)();
    }
  });
  it('applies real probabilities before reserving a model request', async () => {
    let received: ReasoningInput | undefined;
    const s = await setup(async (i) => {
      received = i;
      return answer;
    });
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(received).toEqual(input);
    expect(permit.reasoning).toMatchObject({
      source: 'local-model',
      resolved: 'high',
      judgeVersion: 'v6',
      kind: 'turn',
    });
    expect(permit.reasoning?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    s.command('cancel');
  });
  it('cancellation while judging never admits a model request', async () => {
    const judging = new Gate();
    const s = await setup(async (_i, cancellation) => {
      judging.open();
      await new Promise<void>((resolve) => cancellation.onCancel(resolve));
      return answer;
    });
    const request = s.host.prepareModelRequest(undefined, input);
    const outcome = request.then(
      () => 'admitted',
      () => 'cancelled',
    );
    await judging.wait();
    s.command('cancel');
    expect(await outcome).toBe('cancelled');
    expect(Object.keys(s.coordinator.getSnapshot(s.runId).projection.modelCalls)).toHaveLength(0);
  });
  it('a new directive invalidates a judgment before budget admission', async () => {
    const judging = new Gate(),
      finish = new Gate();
    const s = await setup(async () => {
      judging.open();
      await finish.wait();
      return answer;
    });
    const request = s.host.prepareModelRequest(undefined, input);
    const outcome = request.then(
      () => 'admitted',
      (e: Error) => e.message,
    );
    await judging.wait();
    s.command('steer');
    finish.open();
    expect(await outcome).toContain('REASONING_STALE');
    expect(Object.keys(s.coordinator.getSnapshot(s.runId).projection.modelCalls)).toHaveLength(0);
    s.command('cancel');
  });
});

it('pausing during a judgment waits for resume and then requests fresh preparation', async () => {
  const judging = new Gate(),
    finish = new Gate();
  const s = await setup(async () => {
    judging.open();
    await finish.wait();
    return answer;
  });
  let settled = false;
  const request = s.host
    .prepareModelRequest(undefined, input)
    .then(
      () => 'admitted',
      (error: Error) => error.message,
    )
    .finally(() => {
      settled = true;
    });
  await judging.wait();
  s.coordinator.submit({
    schemaVersion: '0.1',
    runId: s.runId,
    commandId: 'pause',
    type: 'pause',
    payload: { scope: 'run' },
  });
  finish.open();
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(s.coordinator.getSnapshot(s.runId).projection.status).toBe('paused');
  s.coordinator.submit({
    schemaVersion: '0.1',
    runId: s.runId,
    commandId: 'resume',
    type: 'resume',
    payload: { scope: 'run' },
  });
  expect(await request).toBe('REASONING_STALE');
  s.command('cancel');
});

it('a timed-out judge records medium fallback rather than automatic success', async () => {
  const judging = new Gate();
  const s = await setup(async () => {
    judging.open();
    return new Promise(() => {});
  });
  const request = s.host.prepareModelRequest(undefined, input);
  await judging.wait();
  s.clock.advance(3000);
  const permit = await request;
  expect(permit.reasoning).toMatchObject({
    resolved: 'medium',
    source: 'fallback',
    fallback: 'timeout',
  });
  s.command('cancel');
});

it('duplicate preparation is refused without a second judge or reservation', async () => {
  const judging = new Gate(),
    finish = new Gate();
  let calls = 0;
  const s = await setup(async () => {
    calls++;
    judging.open();
    await finish.wait();
    return answer;
  });
  const first = s.host.prepareModelRequest(undefined, input);
  await judging.wait();
  await expect(s.host.prepareModelRequest(undefined, input)).rejects.toThrow('already in progress');
  expect(calls).toBe(1);
  finish.open();
  await first;
  s.command('cancel');
});

it('observe and apply consume one shared per-run judgment limit', async () => {
  let calls = 0;
  const s = await setup(async () => {
    calls++;
    return answer;
  }, true);
  const first = await s.host.prepareModelRequest(undefined, input);
  expect(first.reasoning?.source).toBe('local-model');
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const second = await s.host.prepareModelRequest(undefined, input);
  expect(second.reasoning).toMatchObject({ source: 'fallback', fallback: 'limit' });
  expect(calls).toBe(1);
  s.command('cancel');
});
