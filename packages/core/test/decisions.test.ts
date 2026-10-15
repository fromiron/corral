import type { AgentAdapter, RequestPermit, RunEvent } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  ScriptedDecisionProvider,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  canonicalJson,
  InProcessTransport,
  type JudgmentConfig,
  judgmentSettings,
  parseWorkspaceConfig,
  type RunProjection,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

// reasoning_effort judgments, observe only (CR-003, C-068/C-069, ADR-025).

const terminal = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled'].includes(p.status) && p.lastSeq > 0;

async function drain() {
  for (let i = 0; i < 300; i++) await Promise.resolve();
}

const BRIEF = 'Compare two vendors for a confidential procurement memo.';

async function run(
  judgments: JudgmentConfig | undefined,
  options: Partial<ScriptedAgentOptions> & {
    agents?: AgentAdapter;
    limits?: { maxModelCalls?: number };
  } = {},
) {
  const clock = new FakeClock();
  const permits: RequestPermit[] = [];
  const agents =
    options.agents ??
    new ScriptedAgentAdapter({
      turns: 2,
      ...options,
      reply: (turn, input, permit) => {
        permits.push(permit);
        return `turn ${turn} of ${input.nodeId}`;
      },
    });
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents,
    policy: SPEC_HARD_CAPS,
    ...(judgments ? { judgments } : {}),
  });
  const transport = new InProcessTransport(coordinator);
  const definition = linearCorral(['writer']);
  definition.input = { ...definition.input, brief: BRIEF };
  if (options.limits) definition.limits = { ...definition.limits, ...options.limits };
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_start',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  return { clock, transport, runId, events, permits, coordinator };
}

async function finished(r: Awaited<ReturnType<typeof run>>) {
  const p = await waitForProjection(r.transport, r.runId, terminal);
  await drain();
  return p;
}

const observe = (...providers: ScriptedDecisionProvider[]): JudgmentConfig => ({
  providers,
  settings: { reasoning_effort: { mode: 'observe', providers: providers.map((p) => p.id) } },
});

const decisionEvents = (events: RunEvent[]) => events.filter((e) => e.type.startsWith('decision.'));

describe('reasoning_effort contract (C-068)', () => {
  it('[TC-DEC-001-H] a declaring provider gets one question per request and its answer is recorded with provider@version', async () => {
    const provider = new ScriptedDecisionProvider({ id: 'scripted', version: '1' });
    const r = await run(observe(provider));
    const p = await finished(r);
    expect(p.status).toBe('succeeded');
    expect(provider.asked).toHaveLength(2);
    const [first] = provider.asked;
    expect(first?.questionKind).toBe('reasoning_effort');
    expect(first?.questionVersion).toBe(1);
    expect(first?.candidates).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(first?.subject).toMatchObject({ runId: r.runId, attemptNo: 1 });
    expect(first?.input.excerpt).toContain(BRIEF);
    const prepared = r.events.filter((e) => e.type === 'model.request_prepared');
    expect(provider.asked.map((q) => q.subject.modelCallId)).toEqual(
      prepared.map((e) => e.type === 'model.request_prepared' && e.payload.modelCallId),
    );
    const observed = r.events.filter((e) => e.type === 'decision.observed');
    expect(observed).toHaveLength(2);
    expect(observed[0]?.type === 'decision.observed' && observed[0].payload).toMatchObject({
      provider: 'scripted@1',
      answer: 'medium',
      evidenceLevel: 'model_probability',
      questionKind: 'reasoning_effort',
    });
    // Each judgment follows its own request's decision.requested.
    const types = decisionEvents(r.events).map((e) => e.type);
    expect(types).toEqual([
      'decision.requested',
      'decision.observed',
      'decision.requested',
      'decision.observed',
    ]);
    expect(p.decisions && Object.keys(p.decisions)).toHaveLength(2);
  });

  it('[TC-DEC-001-N] the request text never reaches events: only its hash and features', async () => {
    const r = await run(observe(new ScriptedDecisionProvider()));
    await finished(r);
    const requested = r.events.find((e) => e.type === 'decision.requested');
    expect(requested?.type === 'decision.requested' && requested.payload.inputHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    for (const e of decisionEvents(r.events)) expect(canonicalJson(e)).not.toContain('vendors');
  });

  it('[TC-DEC-001-N] a provider that does not declare the question is never asked', async () => {
    const provider = new ScriptedDecisionProvider({
      questions: [{ kind: 'reasoning_effort', version: 2 }],
    });
    const r = await run(observe(provider));
    await finished(r);
    expect(provider.asked).toHaveLength(0);
    expect(decisionEvents(r.events)).toHaveLength(0);
    const started = r.events.find((e) => e.type === 'run.started');
    expect(
      started?.type === 'run.started' && started.payload.decisions?.reasoning_effort.providers,
    ).toEqual([
      {
        id: 'scripted',
        version: '1',
        privacy: 'local',
        available: false,
        reason: 'does not answer reasoning_effort v1',
      },
    ]);
  });

  it('[TC-DEC-001-N] answers outside the contract fail as invalid_response, never repaired', async () => {
    for (const answer of [
      { answer: 'maximum', probabilities: null, evidenceLevel: 'rule' },
      {
        answer: 'high',
        probabilities: { low: 0.1, medium: 0.1, high: 0.2, xhigh: 0.1 },
        evidenceLevel: 'model_probability',
      },
      { answer: 'high', probabilities: null, evidenceLevel: 'rule', note: 'extra' },
    ]) {
      const r = await run(observe(new ScriptedDecisionProvider({ answer })));
      await finished(r);
      const failed = r.events.filter((e) => e.type === 'decision.failed');
      expect(failed).toHaveLength(2);
      expect(failed[0]?.type === 'decision.failed' && failed[0].payload.reason).toBe(
        'invalid_response',
      );
      expect(r.events.some((e) => e.type === 'decision.observed')).toBe(false);
    }
  });

  it('[TC-DEC-001-N] a provider that throws fails as provider_error; an unknown provider is recorded as not installed', async () => {
    const throwing = new ScriptedDecisionProvider({
      answer: () => {
        throw new Error('boom');
      },
    });
    const r = await run({
      providers: [throwing],
      settings: { reasoning_effort: { mode: 'observe', providers: ['scripted', 'missing'] } },
    });
    const p = await finished(r);
    expect(p.status).toBe('succeeded');
    const failed = r.events.filter((e) => e.type === 'decision.failed');
    expect(failed.map((e) => e.type === 'decision.failed' && e.payload.reason)).toEqual([
      'provider_error',
      'provider_error',
    ]);
    const started = r.events.find((e) => e.type === 'run.started');
    expect(
      started?.type === 'run.started' && started.payload.decisions?.reasoning_effort.providers[1],
    ).toMatchObject({ id: 'missing', available: false, reason: 'not installed' });
  });
});

describe('observe only (C-069)', () => {
  // Judgments take sequence numbers, so runSeq and eventId shift; everything else must not.
  const withoutDecisions = (events: RunEvent[]) =>
    events
      .filter((e) => !e.type.startsWith('decision.'))
      .map(({ runSeq: _seq, eventId: _id, ...e }) => e as RunEvent)
      .map((e) =>
        e.type === 'run.started'
          ? canonicalJson({
              ...e,
              payload: Object.fromEntries(
                Object.entries(e.payload).filter(([key]) => key !== 'decisions'),
              ),
            })
          : canonicalJson(e),
      );

  it('[TC-DEC-002-H] observe leaves permits, reservations and every other event exactly as off', async () => {
    const off = await run({
      providers: [new ScriptedDecisionProvider()],
      settings: { reasoning_effort: { mode: 'off', providers: ['scripted'] } },
    });
    await finished(off);
    const on = await run(observe(new ScriptedDecisionProvider()));
    await finished(on);
    expect(on.permits).toEqual(off.permits);
    expect(withoutDecisions(on.events)).toEqual(withoutDecisions(off.events));
    expect(decisionEvents(off.events)).toHaveLength(0);
    const started = off.events.find((e) => e.type === 'run.started');
    expect(
      started?.type === 'run.started' && started.payload.decisions?.reasoning_effort.mode,
    ).toBe('off');
  });

  it('[TC-DEC-002-N] a provider past its timeout fails as timeout and the run is unaffected', async () => {
    const never = new Gate();
    const provider = new ScriptedDecisionProvider({ timeoutMs: 500, before: () => never.wait() });
    const r = await run(observe(provider), { turns: 1 });
    await waitForProjection(
      r.transport,
      r.runId,
      (p) => r.events.some((e) => e.type === 'decision.requested') && p.lastSeq > 0,
    );
    r.clock.advance(500);
    const p = await finished(r);
    expect(p.status).toBe('succeeded');
    const failed = r.events.find((e) => e.type === 'decision.failed');
    expect(failed?.type === 'decision.failed' && failed.payload.reason).toBe('timeout');
    never.open();
    await drain();
    // An answer after the timeout is not recorded as well.
    expect(r.events.some((e) => e.type === 'decision.observed')).toBe(false);
  });

  it('[TC-DEC-002-N] an answer that arrives after its request finished is recorded as late', async () => {
    const hold = new Gate();
    const agentGate = new Gate();
    const provider = new ScriptedDecisionProvider({ timeoutMs: 60_000, before: () => hold.wait() });
    const r = await run(observe(provider), { turns: 2, beforeReply: () => agentGate.wait() });
    // Let the first request finish while its judgment is still held back.
    while (agentGate.waiting === 0) await drain();
    agentGate.open();
    await waitForProjection(r.transport, r.runId, (p) =>
      Object.values(p.modelCalls).some((c) => c.finished),
    );
    hold.open();
    await finished(r);
    const observed = r.events.filter((e) => e.type === 'decision.observed');
    expect(observed[0]?.type === 'decision.observed' && observed[0].payload).toMatchObject({
      afterRequestFinished: true,
      readyBeforeDispatch: false,
    });
  });

  it('[TC-DEC-002-N] an answer after the run ended is not committed', async () => {
    const hold = new Gate();
    const provider = new ScriptedDecisionProvider({ timeoutMs: 60_000, before: () => hold.wait() });
    const r = await run(observe(provider), { turns: 1 });
    await finished(r);
    const before = r.events.length;
    hold.open();
    await drain();
    expect(r.events.length).toBe(before);
    expect(r.events.some((e) => e.type === 'decision.observed')).toBe(false);
  });

  it('[TC-DEC-002-N] cancelling the execution aborts its pending judgment as cancelled', async () => {
    const hold = new Gate();
    let aborted = false;
    const provider = new ScriptedDecisionProvider({
      timeoutMs: 60_000,
      before: async (_q, cancellation) => {
        cancellation.onCancel(() => {
          aborted = true;
        });
        await hold.wait();
      },
    });
    const agentGate = new Gate();
    const r = await run(observe(provider), { turns: 2, beforeReply: () => agentGate.wait() });
    while (agentGate.waiting === 0) await drain();
    await r.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cmd_cancel',
      runId: r.runId,
      type: 'cancel',
      payload: { scope: { kind: 'execution', executionId: 'exec_0001' }, reason: 'stop' },
    });
    agentGate.open();
    await drain();
    expect(aborted).toBe(true);
    const failed = r.events.find((e) => e.type === 'decision.failed');
    expect(failed?.type === 'decision.failed' && failed.payload.reason).toBe('cancelled');
    hold.open();
  });

  it('[TC-DEC-002-N] reaching maxCalls stops judging, records the limit once and the run continues', async () => {
    const provider = new ScriptedDecisionProvider();
    const r = await run(
      {
        providers: [provider],
        settings: { reasoning_effort: { mode: 'observe', providers: ['scripted'], maxCalls: 1 } },
      },
      { turns: 3 },
    );
    const p = await finished(r);
    expect(p.status).toBe('succeeded');
    expect(provider.asked).toHaveLength(1);
    const limits = r.events.filter(
      (e) => e.type === 'limit.reached' && e.payload.limitKind === 'decision_calls',
    );
    expect(limits).toHaveLength(1);
  });
});

describe('workspace judgment settings (C-068)', () => {
  it('[TC-DEC-002-H] a workspace turns judgments on with one or two named providers', () => {
    const parsed = parseWorkspaceConfig({
      schemaVersion: '0.1',
      decisions: {
        reasoning_effort: {
          mode: 'observe',
          providers: ['local-heuristic', 'local-model'],
          maxCalls: 20,
        },
      },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && judgmentSettings(parsed.config)).toEqual({
      reasoning_effort: {
        mode: 'observe',
        providers: ['local-heuristic', 'local-model'],
        maxCalls: 20,
      },
    });
  });

  it('[TC-DEC-001-N] unknown modes, three providers or an apply mode are refused; no setting means off', () => {
    for (const reasoning_effort of [
      { mode: 'apply', providers: ['local-heuristic'] },
      { mode: 'observe', providers: ['a', 'b', 'c'] },
      { mode: 'observe', providers: [] },
      { mode: 'observe', providers: ['a'], maxCalls: 101 },
    ]) {
      const parsed = parseWorkspaceConfig({
        schemaVersion: '0.1',
        decisions: { reasoning_effort },
      });
      expect(parsed.ok).toBe(false);
    }
    const plain = parseWorkspaceConfig({ schemaVersion: '0.1' });
    expect(plain.ok && judgmentSettings(plain.config)).toEqual({
      reasoning_effort: { mode: 'off', providers: [] },
    });
  });
});

describe('external providers (C-070)', () => {
  const liveModels = {
    resolve: (profile: string, mode: 'mock' | 'live') =>
      mode === 'mock'
        ? {
            ok: true as const,
            snapshot: { profile, provider: null, modelId: null, auth: 'mock' as const },
          }
        : {
            ok: true as const,
            snapshot: { profile, provider: 'openai', modelId: 'gpt-test', auth: 'oauth' as const },
          },
  };

  async function liveRun(judgments: JudgmentConfig) {
    const clock = new FakeClock();
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      policy: SPEC_HARD_CAPS,
      models: liveModels,
      judgments,
    });
    const transport = new InProcessTransport(coordinator);
    const definition = linearCorral(['writer']);
    definition.input = { ...definition.input, brief: BRIEF };
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_live',
      definition,
      mode: 'live',
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    const events: RunEvent[] = [];
    transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  }

  it('[TC-DEC-003-H] an opted-in external provider runs only in a live run, behind an admitted decision effect', async () => {
    const external = new ScriptedDecisionProvider({ id: 'remote', privacy: 'external' });
    const events = await liveRun({
      providers: [external],
      settings: {
        reasoning_effort: { mode: 'observe', providers: ['remote'], allowExternal: true },
      },
    });
    expect(external.asked).toHaveLength(1);
    const order = events
      .filter(
        (e) =>
          e.type.startsWith('decision.') ||
          (e.type === 'effect.admitted' && e.payload.kind === 'decision') ||
          e.type === 'effect.settled',
      )
      .map((e) => (e.type === 'effect.admitted' ? `admitted:${e.payload.kind}` : e.type));
    // The send is admitted before the provider is asked, and settled with the answer.
    expect(order.slice(order.indexOf('decision.requested'))).toEqual(
      expect.arrayContaining(['decision.requested', 'admitted:decision', 'decision.observed']),
    );
    expect(order.indexOf('admitted:decision')).toBeLessThan(order.indexOf('decision.observed'));
    const admitted = events.find(
      (e) => e.type === 'effect.admitted' && e.payload.kind === 'decision',
    );
    const effectId = admitted?.type === 'effect.admitted' ? admitted.payload.effectId : '';
    expect(events.some((e) => e.type === 'effect.settled' && e.payload.effectId === effectId)).toBe(
      true,
    );
    for (const e of events) expect(canonicalJson(e)).not.toContain('vendors');
  });

  it('[TC-DEC-003-N] external providers are refused in mock runs and in live runs without the opt-in', async () => {
    const external = new ScriptedDecisionProvider({ id: 'remote', privacy: 'external' });
    const mock = await run({
      providers: [external],
      settings: {
        reasoning_effort: { mode: 'observe', providers: ['remote'], allowExternal: true },
      },
    });
    await finished(mock);
    const notOptedIn = await liveRun({
      providers: [external],
      settings: { reasoning_effort: { mode: 'observe', providers: ['remote'] } },
    });
    expect(external.asked).toHaveLength(0);
    for (const events of [mock.events, notOptedIn]) {
      expect(decisionEvents(events)).toHaveLength(0);
      const started = events.find((e) => e.type === 'run.started');
      expect(
        started?.type === 'run.started' &&
          started.payload.decisions?.reasoning_effort.providers[0]?.reason,
      ).toBe('external providers run only in live runs the workspace opted in to');
    }
  });
});
