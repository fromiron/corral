import type {
  AgentHost,
  DecisionCancellation,
  DecisionProvider,
  ExternalEffortJudge,
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
  levels: ('low' | 'medium' | 'high' | 'xhigh')[] = ['low', 'medium', 'high'],
  options: {
    externalJudges?: ExternalEffortJudge[];
    external?: 'jev' | 'openai-decisions';
    mode?: 'live' | 'mock';
  } = {},
) {
  let observed = 0;
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
    decide: async () => {
      observed++;
      return answer;
    },
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
          reasoning: { levels, providerDefault: true },
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
          ...(options.external
            ? {
                allowExternal: true,
                external: {
                  provider: options.external,
                  model: options.external === 'jev' ? 'jev-latest' : 'gpt-6-luna',
                },
              }
            : {}),
        },
      },
    },
    ...(options.externalJudges ? { externalJudges: options.externalJudges } : {}),
  });
  const team = linearCorral(['writer']);
  team.roles[0]!.reasoning = { mode: 'auto' };
  const start = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: options.mode ?? 'live',
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
  return {
    coordinator,
    clock,
    host,
    runId: start.runId!,
    command,
    done,
    observed: () => observed,
  };
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
      judged: 'high',
      ladder: ['low', 'medium', 'high'],
      policyVersion: 'corral-effort-v2',
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
  let settled = false;
  const request = s.host.prepareModelRequest(undefined, input).finally(() => {
    settled = true;
  });
  await judging.wait();
  s.clock.advance(2999);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(settled).toBe(false);
  s.clock.advance(1);
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

it('observe does not judge an automatic request again, and apply uses the run limit', async () => {
  let calls = 0;
  const s = await setup(async () => {
    calls++;
    return answer;
  }, true);
  const first = await s.host.prepareModelRequest(undefined, input);
  expect(first.reasoning?.source).toBe('local-model');
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const second = await s.host.prepareModelRequest(undefined, input);
  expect(second.reasoning?.source).toBe('local-model');
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const third = await s.host.prepareModelRequest(undefined, input);
  expect(third.reasoning).toMatchObject({ source: 'fallback', fallback: 'limit' });
  expect(calls).toBe(2);
  expect(s.observed()).toBe(0);
  expect(s.coordinator.getSnapshot(s.runId).projection.decisions).toEqual({});
  s.command('cancel');
});

describe('corral-effort-v2', () => {
  const judged = (level: string, probabilities: Record<string, number>, extra = {}) => ({
    answer: level,
    probabilities,
    evidenceLevel: 'model_probability',
    ...extra,
  });

  it('reviews an uncertain low judgment when the distribution makes under-calling costly', async () => {
    const s = await setup(async () =>
      judged('low', { low: 0.55, medium: 0.05, high: 0.25, xhigh: 0.15 }),
    );
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(permit.reasoning).toMatchObject({
      resolved: 'medium',
      source: 'fallback',
      fallback: 'abstained',
      policyVersion: 'corral-effort-v2',
    });
    s.command('cancel');
  });

  it.each([
    { probabilities: { low: 0.8, medium: 0.1, high: 0.05, xhigh: 0.05 }, resolved: 'low' },
    { probabilities: { low: 0.6, medium: 0, high: 0.3, xhigh: 0.1 }, resolved: 'low' },
    { probabilities: { low: 0.55, medium: 0.44, high: 0.01, xhigh: 0 }, resolved: 'low' },
  ])(
    'keeps a clear or lower-risk low judgment: $probabilities',
    async ({ probabilities, resolved }) => {
      const s = await setup(async () => judged('low', probabilities));
      const permit = await s.host.prepareModelRequest(undefined, input);
      expect(permit.reasoning).toMatchObject({ resolved, judged: 'low', source: 'local-model' });
      s.command('cancel');
    },
  );

  it('preserves a likely xhigh judgment even when a full expected-cost rule would lower it', async () => {
    const s = await setup(
      async () => judged('xhigh', { low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.4 }),
      false,
      6,
      ['low', 'medium', 'high', 'xhigh'],
    );
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(permit.reasoning).toMatchObject({ resolved: 'xhigh', judged: 'xhigh' });
    s.command('cancel');
  });

  it('applies the most likely level, not an expected-cost choice', async () => {
    // Expected cost with an extra penalty for under-calling would pick medium here.
    const s = await setup(async () =>
      judged('high', { low: 0.45, medium: 0.05, high: 0.5, xhigh: 0 }),
    );
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(permit.reasoning).toMatchObject({ resolved: 'high', judged: 'high' });
    s.command('cancel');
  });

  it('moves an unsupported level to the nearest higher supported one, else the nearest lower', async () => {
    const cases = [
      { level: 'high', levels: ['low', 'medium', 'xhigh'], resolved: 'xhigh' },
      { level: 'xhigh', levels: ['low', 'medium', 'high'], resolved: 'high' },
      { level: 'low', levels: ['medium', 'high'], resolved: 'medium' },
    ] as const;
    for (const c of cases) {
      const probabilities = { low: 0, medium: 0, high: 0, xhigh: 0, [c.level]: 1 };
      const s = await setup(async () => judged(c.level, probabilities), false, 6, [...c.levels]);
      const permit = await s.host.prepareModelRequest(undefined, input);
      expect(permit.reasoning).toMatchObject({
        resolved: c.resolved,
        judged: c.level,
        ladder: c.levels,
        policyVersion: 'corral-effort-v2',
      });
      s.command('cancel');
    }
  });

  it('an abstained judgment requests medium and says so', async () => {
    const s = await setup(async () =>
      judged('high', { low: 0.2, medium: 0.25, high: 0.3, xhigh: 0.25 }, { abstain: true }),
    );
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(permit.reasoning).toMatchObject({
      resolved: 'medium',
      source: 'fallback',
      fallback: 'abstained',
      policyVersion: 'corral-effort-v2',
      judgeVersion: 'v6',
    });
    expect(permit.reasoning?.judged).toBeUndefined();
    s.command('cancel');
  });
});

describe('external judgment (Jev)', () => {
  const ladder = ['low', 'medium', 'high', 'xhigh'] as const;
  const abstained = {
    answer: 'high',
    probabilities: { low: 0.2, medium: 0.25, high: 0.3, xhigh: 0.25 },
    evidenceLevel: 'model_probability',
    abstain: true,
  };
  function jev(
    answer: (cancellation: DecisionCancellation) => Promise<{ answer: string; model: string }>,
    available: true | string = true,
    provider: ExternalEffortJudge['provider'] = 'jev',
  ) {
    const calls: Parameters<ExternalEffortJudge['judge']>[] = [];
    const judge: ExternalEffortJudge = {
      provider,
      available: () => available,
      judge: async (...args) => {
        calls.push(args);
        return answer(args[2]) as ReturnType<ExternalEffortJudge['judge']>;
      },
    };
    return { judge, calls };
  }
  const decisionEffects = (s: Awaited<ReturnType<typeof setup>>) =>
    Object.values(s.coordinator.getSnapshot(s.runId).projection.effects).filter(
      (effect) => effect.kind === 'decision',
    );

  it('uses the existing opt-in external path once for a guarded low judgment', async () => {
    const j = jev(async () => ({ answer: 'high', model: 'reviewed' }));
    const s = await setup(
      async () => ({
        answer: 'low',
        probabilities: { low: 0.55, medium: 0.05, high: 0.25, xhigh: 0.15 },
        evidenceLevel: 'model_probability',
      }),
      false,
      6,
      [...ladder],
      {
        externalJudges: [j.judge],
        external: 'jev',
      },
    );
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(permit.reasoning).toMatchObject({
      resolved: 'high',
      source: 'external-model',
      escalated: true,
      policyVersion: 'corral-effort-v2',
    });
    expect(j.calls).toHaveLength(1);
    expect(decisionEffects(s)).toHaveLength(1);
    s.command('cancel');
  });

  it('asks Jev once when the local judge abstains, inside a recorded decision effect', async () => {
    const j = jev(async () => ({ answer: 'xhigh', model: 'jev-2026-09-15' }));
    const s = await setup(async () => abstained, false, 6, [...ladder], {
      externalJudges: [j.judge],
      external: 'jev',
    });
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(permit.reasoning).toMatchObject({
      resolved: 'xhigh',
      judged: 'xhigh',
      source: 'external-model',
      escalated: true,
      judgeVersion: 'jev-2026-09-15',
      policyVersion: 'corral-effort-v2',
    });
    expect(j.calls).toHaveLength(1);
    const [[sent, request] = []] = j.calls;
    if (!request) throw new Error('Jev was not asked');
    expect(sent).toEqual(input);
    expect(request).toMatchObject({
      model: 'jev-latest',
      owner: { runId: s.runId, attemptNo: 1 },
    });
    expect(decisionEffects(s)).toEqual([
      expect.objectContaining({
        effectId: request.owner.effectId,
        status: 'settled',
        outcome: 'succeeded',
      }),
    ]);
    s.command('cancel');
  });

  it("asks only the decision API the workspace chose, with that API's model", async () => {
    const typesafe = jev(async () => ({ answer: 'low', model: 'jev-latest' }));
    const openai = jev(
      async () => ({ answer: 'high', model: 'gpt-6-luna' }),
      true,
      'openai-decisions',
    );
    const s = await setup(async () => abstained, false, 6, [...ladder], {
      externalJudges: [typesafe.judge, openai.judge],
      external: 'openai-decisions',
    });
    const permit = await s.host.prepareModelRequest(undefined, input);
    expect(permit.reasoning).toMatchObject({
      resolved: 'high',
      source: 'external-model',
      judgeVersion: 'gpt-6-luna',
    });
    expect(typesafe.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(1);
    expect(openai.calls[0]?.[1].model).toBe('gpt-6-luna');
    s.command('cancel');
  });

  it('never asks Jev when the local judge is clear, it is off, it has no key, or the run is mock', async () => {
    const clear = {
      answer: 'high',
      probabilities: { low: 0, medium: 0, high: 1, xhigh: 0 },
      evidenceLevel: 'model_probability',
    };
    const cases = [
      { decide: clear, external: true, available: true as const, mode: 'live' as const },
      { decide: abstained, external: false, available: true as const, mode: 'live' as const },
      { decide: abstained, external: true, available: 'no TypeSafe key', mode: 'live' as const },
      { decide: abstained, external: true, available: true as const, mode: 'mock' as const },
    ];
    for (const c of cases) {
      const j = jev(async () => ({ answer: 'low', model: 'jev-latest' }), c.available);
      const s = await setup(async () => c.decide, false, 6, [...ladder], {
        externalJudges: [j.judge],
        ...(c.external ? { external: 'jev' as const } : {}),
        mode: c.mode,
      });
      const permit = await s.host.prepareModelRequest(undefined, input);
      expect(j.calls).toHaveLength(0);
      expect(permit.reasoning?.source).not.toBe('external-model');
      expect(permit.reasoning?.escalated).toBeUndefined();
      expect(decisionEffects(s)).toEqual([]);
      s.command('cancel');
    }
  });

  it('turns a Jev failure or an answer outside the ladder into medium, and says Jev was tried', async () => {
    const cases = [
      { fail: new Error('HTTP 401', { cause: 'provider_error' }), fallback: 'provider_error' },
      { fail: null, answer: 'max', fallback: 'invalid_response' },
    ];
    for (const c of cases) {
      const j = jev(async () => {
        if (c.fail) throw c.fail;
        return { answer: c.answer ?? 'low', model: 'jev-latest' };
      });
      const s = await setup(async () => abstained, false, 6, [...ladder], {
        externalJudges: [j.judge],
        external: 'jev',
      });
      const permit = await s.host.prepareModelRequest(undefined, input);
      expect(permit.reasoning).toMatchObject({
        resolved: 'medium',
        source: 'fallback',
        fallback: c.fallback,
        escalated: true,
      });
      expect(decisionEffects(s)).toEqual([expect.objectContaining({ outcome: 'failed' })]);
      s.command('cancel');
    }
  });

  it('shares the 3 s deadline: a slow local judge leaves no time, a slow Jev times out', async () => {
    const slowLocal = jev(async () => ({ answer: 'low', model: 'jev-latest' }));
    let s = await setup(
      async () => {
        s.clock.advance(2600);
        return abstained;
      },
      false,
      6,
      [...ladder],
      { externalJudges: [slowLocal.judge], external: 'jev' },
    );
    expect((await s.host.prepareModelRequest(undefined, input)).reasoning).toMatchObject({
      fallback: 'abstained',
    });
    expect(slowLocal.calls).toHaveLength(0);
    s.command('cancel');

    const asked = new Gate();
    let aborted = false;
    const slowJev = jev(
      (cancellation) =>
        new Promise(() => {
          cancellation.onCancel(() => {
            aborted = true;
          });
          asked.open();
        }),
    );
    s = await setup(async () => abstained, false, 6, [...ladder], {
      externalJudges: [slowJev.judge],
      external: 'jev',
    });
    const request = s.host.prepareModelRequest(undefined, input);
    await asked.wait();
    s.clock.advance(3000);
    expect((await request).reasoning).toMatchObject({
      resolved: 'medium',
      fallback: 'timeout',
      escalated: true,
    });
    expect(aborted).toBe(true);
    expect(decisionEffects(s)).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
    s.command('cancel');
  });

  it('cancelling the run while Jev answers aborts it and admits no model request', async () => {
    const asked = new Gate();
    let aborted = false;
    const j = jev(
      (cancellation) =>
        new Promise(() => {
          cancellation.onCancel(() => {
            aborted = true;
          });
          asked.open();
        }),
    );
    const s = await setup(async () => abstained, false, 6, [...ladder], {
      externalJudges: [j.judge],
      external: 'jev',
    });
    const request = s.host.prepareModelRequest(undefined, input);
    await asked.wait();
    s.command('cancel');
    await expect(request).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(Object.values(s.coordinator.getSnapshot(s.runId).projection.modelCalls ?? {})).toEqual(
      [],
    );
  });
});
