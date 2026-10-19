import {
  type AgentHost,
  type AgentSettlement,
  type AgentStartInput,
  DEFAULT_LIMITS,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { autoDefinition } from '../src/auto-team.ts';
import {
  Coordinator,
  createAutoStarter,
  InProcessTransport,
  planRun,
  waitForProjection,
} from '../src/index.ts';
import { resolveUltraSelection, ultraBudgetAllowance } from '../src/ultra-team.ts';

const ultra = {
  version: 1 as const,
  modelProfiles: ['primary', 'verifier', 'specialist'],
  verifierProfile: 'verifier',
  reasoning: { primary: 'max' as const, verifier: 'high' as const, specialist: 'max' as const },
};

it('[TC-ULTRA-003-N] refuses aliases, disconnected or unverified models and explicit effort before any model or run starts', async () => {
  const selection = {
    version: 1 as const,
    modelProfiles: ['primary', 'verifier'],
    verifierProfile: 'verifier',
  };
  const startRun = vi.fn();
  const choose = vi.fn();
  for (const problem of ['alias', 'missing', 'unverified', 'effort'] as const) {
    const models = {
      resolve: (profile: string) =>
        profile === 'verifier' && problem === 'missing'
          ? { ok: false as const, code: 'CAPABILITY_DENIED' as const, reason: 'Not connected' }
          : {
              ok: true as const,
              snapshot: {
                profile,
                provider: 'test',
                modelId: problem === 'alias' ? 'same-model' : profile,
                auth: 'api_key' as const,
                reasoning: {
                  levels: ['high' as const],
                  providerDefault: true,
                  ...(problem === 'unverified' ? {} : { identity: 'a'.repeat(64) }),
                },
              },
            },
    };
    const starter = createAutoStarter({
      startRun,
      route: choose,
      resolveUltra: (pool, primary, mode) => resolveUltraSelection(pool, primary, mode, models),
    });
    const result = await starter.start(
      {
        commandId: `guard_${problem}`,
        brief: 'Check evidence',
        mode: 'live',
        qualityPreset: 'ultra',
        ultra: selection,
        choice: {
          modelProfile: 'primary',
          ...(problem === 'effort'
            ? { reasoning: { mode: 'fixed' as const, level: 'high' as const } }
            : {}),
        },
      },
      { fileTools: false },
    );
    expect(result.receipt.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.runId).toBeNull();
  }
  expect(startRun).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
});

it('[TC-ULTRA-003-N] protects the remaining mandatory stages and keeps draining latched after unknown usage settles', () => {
  const state = {
    spent: 31000,
    reserved: 0,
    unknownOutstanding: 0,
    modelCalls: 9,
    reservations: {},
  };
  const delegate = ultraBudgetAllowance(state, DEFAULT_LIMITS, 'plan', true, false);
  expect(delegate.draining).toBe(true);
  expect(delegate.maxOutputTokens).toBe(0);
  const synthesis = ultraBudgetAllowance(state, DEFAULT_LIMITS, 'synthesize', false, true);
  expect(synthesis.maxOutputTokens).toBe(4096);
  expect(
    ultraBudgetAllowance({ ...state, spent: 0 }, DEFAULT_LIMITS, 'write', true, true)
      .maxOutputTokens,
  ).toBe(0);
  expect(
    ultraBudgetAllowance({ ...state, spent: 60000 }, DEFAULT_LIMITS, 'synthesize', false, true)
      .maxOutputTokens,
  ).toBe(0);
});

it('[TC-ULTRA-003-N] bounds active specialists, preserves Reins and fences cancelled requests without releasing unknown usage', async () => {
  const hosts: AgentHost[] = [];
  const exits: ((settlement: AgentSettlement) => void)[] = [];
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: {
      async start(_input, host) {
        hosts.push(host);
        const settled = new Promise<AgentSettlement>((resolve) => exits.push(resolve));
        return { cancel: async () => {}, waitForSettlement: () => settled };
      },
    },
  });
  const starter = createAutoStarter({
    startRun: (request) => coordinator.startRun(request),
    resolveUltra: (selection, primary, mode) => coordinator.resolveUltra(selection, primary, mode),
  });
  const request = {
    commandId: 'ultra_guard',
    brief: 'Fixture',
    mode: 'mock' as const,
    qualityPreset: 'ultra' as const,
    choice: { modelProfile: 'primary' },
    ultra: {
      version: 1 as const,
      modelProfiles: ['primary', 'verifier'],
      verifierProfile: 'verifier',
    },
  };
  const result = await starter.start(request, { fileTools: false });
  const runId = result.runId!;
  expect((await starter.start(request, { fileTools: false })).runId).toBe(runId);
  const transport = new InProcessTransport(coordinator);
  await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1);
  const parent = hosts[0]!;
  expect(
    (
      await parent.invokeTool({
        name: 'spawn_subagents',
        args: { tasks: [1, 2].map(() => ({ targetNodeId: 'specialist_0', brief: 'Fixture' })) },
      })
    ).ok,
  ).toBe(true);
  const active = await waitForProjection(transport, runId, (p) => p.executionOrder.length === 3);
  expect(
    await parent.invokeTool({
      name: 'spawn_subagents',
      args: { tasks: [{ targetNodeId: 'specialist_0', brief: 'One too many' }] },
    }),
  ).toMatchObject({ ok: false, error: { code: 'LIMIT_REACHED' } });
  const command = { schemaVersion: '0.1' as const, runId };
  expect(
    coordinator.submit({
      ...command,
      commandId: 'patch_ultra',
      type: 'patch',
      expectedControlRevision: active.controlRevision,
      payload: { kind: 'node_future', nodeId: 'write', reasoning: { mode: 'fixed', level: 'low' } },
    }).error?.code,
  ).toBe('CAPABILITY_DENIED');
  expect(
    coordinator.submit({
      ...command,
      commandId: 'steer_ultra',
      type: 'steer',
      payload: {
        targetExecutionId: active.executionOrder[0]!,
        text: 'Use supplied evidence',
        delivery: 'next_request',
      },
    }).error,
  ).toBeUndefined();
  const permit = await hosts[1]!.prepareModelRequest();
  await hosts[1]!.modelRequestDispatched?.(permit.modelCallId);
  expect(
    coordinator.submit({
      ...command,
      commandId: 'cancel_ultra',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'Fixture complete' },
    }).error,
  ).toBeUndefined();
  await expect(hosts[1]!.prepareModelRequest()).rejects.toThrow();
  for (const exit of exits) exit({ outcome: 'cancelled' });
  const final = await waitForProjection(transport, runId, (p) => p.status === 'cancelled');
  expect(final.budget.modelCalls).toBe(1);
  expect(final.budget.unknownOutstanding).toBe(permit.maxOutputTokens);
  const snapshot = coordinator.getRunSnapshot(runId)!;
  expect(
    coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'forged_ultra',
      mode: 'mock',
      definition: snapshot.definition,
      autoRoute: {
        ...snapshot.autoRoute!,
        ultra: { ...snapshot.autoRoute!.ultra!, reasoning: { primary: 'low', verifier: 'max' } },
      },
    }).receipt.error?.code,
  ).toBe('CAPABILITY_DENIED');
});

it('[TC-ULTRA-003-H] builds maximum-reasoning collaboration with synthesis before a different model verifies the final artifact', () => {
  const input = {
    id: 'multi_ultra',
    template: 'write_review' as const,
    qualityPreset: 'ultra' as const,
    brief: 'Compare the supplied evidence.',
    choice: { modelProfile: 'primary' },
    fileTools: true,
    ultra,
  };
  const definition = autoDefinition(input);
  expect(definition.roles.find((role) => role.id === 'reviewer')?.modelProfile).toBe('verifier');
  expect(definition.roles.find((role) => role.id === 'synthesizer')?.reasoning).toEqual({
    mode: 'fixed',
    level: 'max',
  });
  expect(
    definition.roles
      .filter((role) => role.allowedWorkTools.includes('write_file'))
      .map((role) => role.id),
  ).toEqual(['writer']);
  expect(
    definition.nodes.filter((node) => node.type === 'agent' && node.invocation === 'callable'),
  ).toHaveLength(2);
  const reviewer = definition.nodes.find((node) => node.id === 'review');
  expect(reviewer && 'inputBindings' in reviewer && reviewer.inputBindings).toContainEqual({
    kind: 'task_output',
    name: 'draft',
    sourceNodeId: 'synthesize',
  });
  const output = definition.nodes.find((node) => node.type === 'output');
  expect(output?.type === 'output' && output.inputBindings).toContainEqual({
    kind: 'task_output',
    name: 'draft',
    sourceNodeId: 'synthesize',
  });
  expect(planRun(definition)).toMatchObject({ ok: true });
});

it('[TC-ULTRA-003-H] runs parallel specialists, synthesizes each repair and requires the selected model to review the exact final artifact', async () => {
  const seen: AgentStartInput[] = [];
  const models = {
    resolve: (profile: string) => ({
      ok: true as const,
      snapshot: {
        profile,
        provider: profile === 'primary' ? 'openai' : 'hive',
        modelId: profile,
        auth: 'api_key' as const,
        reasoning: {
          levels: profile === 'verifier' ? ['high' as const] : ['high' as const, 'max' as const],
          providerDefault: true,
          identity: 'a'.repeat(64),
        },
      },
    }),
  };
  const scripted = new ScriptedAgentAdapter({
    turns: 1,
    collaborate: false,
    appendNotes: false,
    review: (input) => (input.round === 1 ? 'revise' : 'pass'),
    script: async (input, host) => {
      if (input.nodeId === 'plan') {
        const child = await host.invokeTool({
          name: 'spawn_subagents',
          args: {
            tasks: input.capabilities.delegateTo.map((target) => ({
              targetNodeId: target.nodeId,
              brief: 'Check the supplied assumptions.',
            })),
          },
        });
        expect(child.ok).toBe(true);
        if (child.ok)
          expect(
            (
              await host.invokeTool({
                name: 'await_tasks',
                args: { taskIds: child.result.taskIds },
              })
            ).ok,
          ).toBe(true);
      }
      return null;
    },
  });
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    models,
    agents: {
      start: (input, host) => {
        seen.push(input);
        return scripted.start(input, host);
      },
    },
  });
  const starter = createAutoStarter({
    startRun: (request) => coordinator.startRun(request),
    resolveUltra: (selection, primary, mode) =>
      resolveUltraSelection(selection, primary, mode, models),
  });
  const result = await starter.start(
    {
      commandId: 'ultra_multi',
      brief: 'Compare evidence',
      mode: 'live',
      qualityPreset: 'ultra',
      choice: { modelProfile: 'primary' },
      ultra: { version: 1, modelProfiles: ultra.modelProfiles, verifierProfile: 'verifier' },
    },
    { fileTools: false },
  );
  expect(result.receipt.error).toBeUndefined();
  const final = await waitForProjection(new InProcessTransport(coordinator), result.runId!, (p) =>
    ['succeeded', 'failed', 'cancelled'].includes(p.status),
  );
  expect(final.status).toBe('succeeded');
  expect(seen.filter((input) => input.depth === 1)).toHaveLength(2);
  expect(
    seen.filter((input) => input.nodeId === 'review').map((input) => input.modelProfile),
  ).toEqual(['verifier', 'verifier']);
  for (const input of seen)
    expect(input.role.reasoning).toEqual({
      mode: 'fixed',
      level: input.modelProfile === 'verifier' ? 'high' : 'max',
    });
  const finalArtifact = final.artifacts[final.output!.artifactVersionIds[0]!]!;
  expect(final.executions[finalArtifact.authorExecutionId]?.nodeId).toBe('synthesize');
  expect(final.budget.unknownOutstanding).toBe(0);
});
