import {
  CorralDefinition,
  ImageGenerationProfile,
  LimitReached,
  LoopIterationFinished,
  PatchPayload,
  RecipeStopReason,
  ReviewRecipeRevision,
  RunEvent,
  RunLimits,
  TaskBrief,
} from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

// Runs have no usage budget (docs/specs/product-contract.md §9). What stops a run is a Loop's
// round cap, a stall, the no-progress warning, a failure path, a person's approval or cancel.

it.each([1, 3, 6])(
  'calls and tokens do not stop a run with %i host model slots',
  async (maxModelConcurrency) => {
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 105 }),
      policy: { ...SPEC_HARD_CAPS, maxModelConcurrency },
    });
    const result = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition: linearCorral(['writer']),
    });
    expect(result.runId).not.toBeNull();
    // Six replies without progress pause it; nothing counts calls or tokens against a cap.
    const projection = await waitForProjection(
      new InProcessTransport(coordinator),
      result.runId!,
      (p) => ['succeeded', 'failed', 'awaiting_user'].includes(p.status),
    );
    expect(projection.status).toBe('awaiting_user');
    expect(Object.keys(projection.modelCalls)).toHaveLength(6);
    const events = store.readEvents(result.runId!, 0);
    expect(
      events.filter((e) => e.type === 'extension.ui_notified' && e.payload.key === 'no_progress'),
    ).toHaveLength(1);
    expect(
      events.some((e) => e.type === 'limit.reached' && e.payload.limitKind === 'no_progress'),
    ).toBe(true);
    expect(events.some((e) => e.type.startsWith('budget.'))).toBe(false);
    expect('budget' in projection).toBe(false);
    expect('usageLimits' in projection).toBe(false);
  },
);

it('a run continues past the no-progress pause only on approval', async () => {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 8 }),
  });
  const transport = new InProcessTransport(coordinator);
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_no_progress',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  const paused = await waitForProjection(transport, started.runId!, (p) =>
    ['awaiting_user', 'succeeded', 'failed'].includes(p.status),
  );
  expect(paused.status).toBe('awaiting_user');
  const approval = Object.values(paused.approvals).find((a) => a.status === 'pending');
  if (!approval) throw new Error('no-progress approval not created');
  const receipt = await coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'continue_no_progress',
    runId: started.runId!,
    type: 'resolve_approval',
    expectedControlRevision: paused.controlRevision,
    payload: {
      approvalId: approval.approvalId,
      decision: 'approve',
      subjectVersionId: approval.subjectVersionIds[0] ?? '',
    },
  });
  expect(receipt.status).toBe('applied');
  const final = await waitForProjection(transport, started.runId!, (p) =>
    ['succeeded', 'failed'].includes(p.status),
  );
  expect(final.status).toBe('succeeded');
  expect(Object.keys(final.modelCalls)).toHaveLength(8);
});

it('usage is recorded on each model call', async () => {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 2 }),
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_usage',
    mode: 'mock',
    definition: linearCorral(['writer', 'reviewer']),
  });
  const final = await waitForProjection(new InProcessTransport(coordinator), started.runId!, (p) =>
    ['succeeded', 'failed'].includes(p.status),
  );
  expect(final.status).toBe('succeeded');
  const calls = Object.values(final.modelCalls);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.finished).toBe(true);
    expect(call.usage).not.toBeNull();
  }
});

it('a spawn patch still applies', async () => {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 3 }),
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_spawn_patch',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  const receipt = await coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'spawn_patch',
    runId: started.runId!,
    type: 'patch',
    expectedControlRevision: 0,
    payload: { kind: 'run_limits', changes: { maxSpawns: 20 } },
  });
  expect(receipt.status).toBe('applied');
  const projection = await waitForProjection(
    new InProcessTransport(coordinator),
    started.runId!,
    (p) => ['succeeded', 'failed'].includes(p.status),
  );
  expect(projection.limits?.maxSpawns).toBe(20);
});

describe('the schemas carry no usage budget', () => {
  const definition = () => linearCorral(['writer']);

  it.each([
    ['maxModelCalls', 40],
    ['maxOutputTokens', 64000],
    ['maxOutputTokensPerCall', 4096],
    ['modelTimeoutMs', 180000],
    ['runDeadlineMs', 3600000],
  ])('run limits refuse %s', (key, value) => {
    expect(RunLimits.safeParse({ ...definition().limits, [key]: value }).success).toBe(false);
    expect(
      CorralDefinition.safeParse({
        ...definition(),
        limits: { ...definition().limits, [key]: value },
      }).success,
    ).toBe(false);
  });

  it('a definition refuses an execution policy', () => {
    expect(
      CorralDefinition.safeParse({ ...definition(), executionPolicy: { version: 2 } }).success,
    ).toBe(false);
  });

  it('a Loop refuses a budget', () => {
    const base = definition();
    const loop = {
      id: 'loop',
      type: 'loop',
      label: 'Loop',
      maxIterations: 2,
      budget: { maxModelCalls: 1 },
    };
    expect(CorralDefinition.safeParse({ ...base, nodes: [...base.nodes, loop] }).success).toBe(
      false,
    );
  });

  it('a run_limits patch takes only spawns', () => {
    expect(PatchPayload.safeParse({ kind: 'run_limits', changes: { maxSpawns: 20 } }).success).toBe(
      true,
    );
    for (const key of ['maxModelCalls', 'maxOutputTokens'])
      expect(PatchPayload.safeParse({ kind: 'run_limits', changes: { [key]: 2 } }).success).toBe(
        false,
      );
  });

  it('a review recipe keeps attempt and repair counts and no usage caps', () => {
    const recipe = {
      recipeId: 'recipe',
      revision: 1,
      criteriaHash: 'a'.repeat(64),
      candidateNodeId: 'writer',
      evaluatorRoleId: 'reviewer',
      checkIds: [],
      criteriaFiles: [],
      maxAttempts: 3,
      maxRepairs: 2,
    };
    expect(ReviewRecipeRevision.safeParse(recipe).success).toBe(true);
    for (const [key, value] of [
      ['maxWallMs', 60000],
      ['maxModelCalls', 10],
      ['maxOutputTokens', 1000],
    ] as const)
      expect(ReviewRecipeRevision.safeParse({ ...recipe, [key]: value }).success).toBe(false);
    for (const reason of ['call_limit', 'token_limit', 'deadline'])
      expect(RecipeStopReason.safeParse(reason).success).toBe(false);
  });

  it('an image profile has no call or price cap', () => {
    const profile = {
      profileId: 'images',
      modelProfileId: 'model-a',
      modelId: 'gpt-image-1',
      api: 'openai-images',
      timeoutMs: 60000,
    };
    expect(ImageGenerationProfile.safeParse(profile).success).toBe(true);
    expect(ImageGenerationProfile.safeParse({ ...profile, maxCallsPerRun: 4 }).success).toBe(false);
    expect(ImageGenerationProfile.safeParse({ ...profile, maxCostUsdPerCall: 1 }).success).toBe(
      false,
    );
  });

  it('events have no budget ledger, budget limit or budget stop', () => {
    const envelope = {
      schemaVersion: '0.1',
      eventId: 'event_1',
      runId: 'run_1',
      runSeq: 1,
      recordedAt: '2026-11-08T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'coordinator' },
      causedByEventIds: [],
    };
    expect(
      RunEvent.safeParse({
        ...envelope,
        type: 'budget.reserved',
        payload: {
          reservationId: 'r',
          modelCallId: null,
          scope: 'run',
          amount: { outputTokens: 1, modelCalls: 1 },
        },
      }).success,
    ).toBe(false);
    for (const limitKind of ['model_calls', 'output_tokens', 'deadline'])
      expect(LimitReached.shape.payload.safeParse({ limitKind, used: 1, max: 1 }).success).toBe(
        false,
      );
    expect(
      LimitReached.shape.payload.safeParse({ limitKind: 'spawns', used: 1, max: 1 }).success,
    ).toBe(true);
    expect(
      LoopIterationFinished.shape.payload.shape.outcome.safeParse('budget_exhausted').success,
    ).toBe(false);
  });

  it('usage outside model calls is one usage record', () => {
    const envelope = {
      schemaVersion: '0.1',
      eventId: 'event_1',
      runId: 'run_1',
      runSeq: 1,
      recordedAt: '2026-11-08T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'coordinator' },
      causedByEventIds: [],
    };
    expect(
      RunEvent.safeParse({
        ...envelope,
        type: 'usage.recorded',
        payload: {
          usageId: 'auto_route:attempt_1',
          kind: 'auto_route',
          profileId: 'model-a',
          inputTokens: null,
          outputTokens: 12,
          costMicros: null,
        },
      }).success,
    ).toBe(true);
  });

  it('a task brief has no unlimited marker', () => {
    expect('usageLimits' in TaskBrief.shape).toBe(false);
  });
});

describe('runs recorded before the budget was removed', () => {
  it('a stored log with retired budget events still replays, and those events change nothing', () => {
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const { runId } = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start_old',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    const events = store.readEvents(runId ?? '', 0);
    const [first] = events;
    if (!first) throw new Error('the run recorded nothing');
    // Retired events kept in an old log, between the run start and everything after it.
    const retired = [
      {
        ...first,
        type: 'budget.reserved',
        payload: { reservationId: 'r', modelCallId: null, scope: 'run', amount: {} },
      },
      {
        ...first,
        type: 'budget.settled',
        payload: { reservationId: 'r', actual: null, unknownOutstanding: 0 },
      },
    ] as unknown as RunEvent[];
    const old = [first, ...retired, ...events.slice(1)].map((event, index) => ({
      ...event,
      runSeq: index + 1,
    }));
    const replayed = old.reduce(applyEvent, emptyProjection(runId ?? ''));
    const current = events.reduce(applyEvent, emptyProjection(runId ?? ''));
    expect(replayed.lastSeq).toBe(old.length);
    expect({ ...replayed, lastSeq: 0 }).toEqual({ ...current, lastSeq: 0 });
  });
});
