import { type AgentStartInput, DEFAULT_LIMITS, type StartRunRequest } from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  autoDefinition,
  Coordinator,
  createAutoStarter,
  InMemoryRunStore,
  InProcessTransport,
  SIMULATED_MODELS,
  waitForProjection,
} from '../src/index.ts';

const choice = {
  modelProfile: 'model-a',
  reasoning: { mode: 'fixed' as const, level: 'low' as const },
};
const terminal = (p: { status: string }) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const review = (input: AgentStartInput, pass: boolean) =>
  JSON.stringify({
    targetArtifactVersionId: input.inputs.find((item) => item.name === 'draft')?.artifactVersionId,
    criteriaVersionId: input.criteriaVersionId,
    verdict: pass ? 'pass' : 'revise',
    issues: pass
      ? []
      : [
          {
            criterionId: 'criterion_1',
            reason: `Fix issue in round ${input.round}`,
            severity: 'required',
            evidenceRefs: [],
          },
        ],
    evidenceRefs: [],
  });

async function run(
  preset: 'default' | 'ultra',
  mode: 'mock' | 'live' = 'mock',
  alwaysRevise = false,
) {
  const clock = new FakeClock(),
    store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    models: { resolve: (profile) => SIMULATED_MODELS.resolve(profile, 'mock') },
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      reply: (_turn, input) => `Fixed task result ${input.nodeId} ${input.round}`,
      review: (input) => review(input, !alwaysRevise && (input.round ?? 0) === 3),
    }),
  });
  let started: StartRunRequest | undefined;
  const starter = createAutoStarter({
    startRun: (request) => {
      started = request;
      return coordinator.startRun(request);
    },
  });
  const request = {
    commandId: 'quality_start',
    brief: 'Hello',
    choice,
    mode,
    qualityPreset: preset,
  };
  const result = await starter.start(request, { fileTools: false });
  expect(result.receipt.error).toBeUndefined();
  expect(result.runId).toBeTruthy();
  const final = await waitForProjection(
    new InProcessTransport(coordinator),
    result.runId!,
    terminal,
  );
  return { coordinator, store, result, final, started: started!, starter, request };
}

describe('explicit Ultra preset (CR-031)', () => {
  it('[TC-ULTRA-001-H] compares the same fixed task without changing model, effort, limits or default definitions', async () => {
    const input = {
      id: 'comparison',
      template: 'single' as const,
      brief: 'Hello',
      choice,
      fileTools: false,
    };
    expect(autoDefinition({ ...input, qualityPreset: 'default' })).toEqual(autoDefinition(input));
    const baseline = await run('default');
    expect(baseline.final.status).toBe('succeeded');
    expect(baseline.final.budget.modelCalls).toBe(1);
    for (const mode of ['mock', 'live'] as const) {
      const ultra = await run('ultra', mode);
      const snapshot = ultra.coordinator.getRunSnapshot(ultra.result.runId!)!;
      expect(snapshot.autoRoute?.qualityPreset).toBe('ultra');
      expect(snapshot.mode).toBe(mode);
      expect(snapshot.definition.limits).toEqual(baseline.started.definition.limits);
      expect(snapshot.definition.limits).toEqual(DEFAULT_LIMITS);
      expect(snapshot.definition.roles.map((role) => role.id)).toEqual([
        'planner',
        'writer',
        'reviewer',
      ]);
      for (const role of snapshot.definition.roles) {
        expect(role.modelProfile).toBe(choice.modelProfile);
        expect(role.reasoning).toEqual(choice.reasoning);
      }
      expect(
        snapshot.definition.roles.find((role) => role.id === 'reviewer')?.allowedWorkTools,
      ).not.toContain('write_file');
      expect(ultra.final.status).toBe('succeeded');
      expect(ultra.final.budget.modelCalls).toBe(7);
      expect(ultra.final.budget.unknownOutstanding).toBe(0);
      expect((await ultra.starter.start(ultra.request, { fileTools: false })).runId).toBe(
        ultra.result.runId,
      );
      expect(
        (
          await ultra.starter.start(
            { ...ultra.request, qualityPreset: 'default' },
            { fileTools: false },
          )
        ).receipt.error?.code,
      ).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  it('[TC-ULTRA-001-N] caps repairs and refuses forged built-ins or role escalation', async () => {
    const exhausted = await run('ultra', 'mock', true);
    expect(exhausted.final.status).toBe('failed');
    expect(exhausted.final.budget.modelCalls).toBe(7);
    expect(Object.values(exhausted.final.approvals)).toHaveLength(0);
    const events = exhausted.store.readEvents(exhausted.result.runId!, 0);
    expect(
      events.some(
        (event) => event.type === 'recipe.stopped' && event.payload.reason === 'attempt_limit',
      ),
    ).toBe(true);
    let index = 0;
    for (const mutate of [
      (request: StartRunRequest) => {
        request.definition.roles[0]!.allowedWorkTools.push('write_file');
      },
      (request: StartRunRequest) => {
        request.roleOverrides = { reviewer: { modelProfile: 'model-b' } };
      },
    ]) {
      const request = JSON.parse(JSON.stringify(exhausted.started)) as StartRunRequest;
      request.commandId += `_${++index}`;
      mutate(request);
      expect(exhausted.coordinator.startRun(request).receipt.error?.code).toBe('CAPABILITY_DENIED');
    }
  });
});
