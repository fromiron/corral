import type {
  AgentStartInput,
  EffectiveHarnessSnapshot,
  VerificationReport,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import {
  Coordinator,
  type CoordinatorDeps,
  createAutoStarter,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

async function fixture(
  options: {
    checks?: string[];
    available?: boolean;
    mutateOnStop?: boolean;
    changeBeforeCheck?: boolean;
    verdict?: 'pass' | 'fail' | 'error' | 'stale' | 'unisolated';
  } = {},
) {
  const clock = new FakeClock();
  const seen: AgentStartInput[] = [];
  const harness: EffectiveHarnessSnapshot = {
    binding: { profileId: 'checked', revision: 1 },
    snapshotHash: 'a'.repeat(64),
    piVersion: '1.3.0',
    policyRevision: 1,
    policy: 'strict',
    resources: [],
    tools: [],
    diagnostics: [],
    allowedTools: [
      'write_artifact',
      'submit_result',
      'run_check',
      'preview_file',
      'read_artifact',
      'update_plan',
    ],
    projectTools: {
      projectId: 'default',
      revision: 1,
      hash: 'b'.repeat(64),
      checkIds: options.checks ?? ['types'],
      lspServerIds: [],
    },
  };
  let tree = '1'.repeat(40);
  let checks = 0;
  const runCheck = vi.fn<NonNullable<NonNullable<CoordinatorDeps['files']>['runCheck']>>(
    async (input, plan) => {
      const verdict = checks++ === 0 ? (options.verdict ?? 'pass') : 'pass';
      const report: VerificationReport = {
        verificationId: `check_${checks}`,
        owner: {
          kind: 'execution',
          runId: input.runId,
          executionId: input.executionId,
          attemptNo: input.attemptNo,
          effectId: input.effectId,
        },
        sessionId: 'session',
        commandId: input.commandId,
        configRevision: 1,
        fingerprint: plan.fingerprint,
        tree,
        state: verdict === 'error' ? 'error' : 'completed',
        verdict: verdict === 'fail' ? 'fail' : 'pass',
        ...(verdict === 'unisolated' ? {} : { isolation: 'linux-bwrap' as const }),
        exitCode: verdict === 'fail' ? 1 : 0,
        signal: null,
        timedOut: false,
        cleanupConfirmed: true,
        targetUnchanged: true,
        durationMs: 1,
        startedAt: clock.nowIso(),
        endedAt: clock.nowIso(),
        retainUntil: clock.nowIso(),
        output: { text: verdict, bytes: verdict.length, hash: 'e'.repeat(64), truncated: false },
      };
      return { ...report, stale: verdict === 'stale' };
    },
  );
  const scripted = new ScriptedAgentAdapter({
    turns: 1,
    collaborate: false,
    appendNotes: false,
    reply: (_turn, input) => `${input.nodeId} ${input.round}`,
    review: () => 'pass',
    script: async (input, host) => {
      if (options.mutateOnStop && input.nodeId === 'review')
        expect((await host.invokeTool({ name: 'preview_file', args: { path: 'a.txt' } })).ok).toBe(
          true,
        );
      return null;
    },
  });
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    harnesses: { resolve: () => harness },
    previewTools: {
      execute: async () => ({}),
      closeExecution: async () => {},
      closeRun: async () => {
        if (options.mutateOnStop) tree = '2'.repeat(40);
      },
    },
    files: {
      available: () => true,
      execute: async () => ({}),
      isolatedChecksAvailable: () => options.available ?? true,
      currentTreeForRun: async () => tree,
      runCheck,
      planCheck: async (input) => {
        if (options.changeBeforeCheck) tree = '2'.repeat(40);
        return {
          commandId: input.commandId,
          name: 'Types',
          argv: ['node', 'check.mjs'],
          timeoutMs: 1000,
          configRevision: 1,
          fingerprint: 'd'.repeat(64),
          tree,
          trusted: true,
        };
      },
    },
    agents: {
      start: async (input, host) => {
        seen.push(input);
        await host.reportHarness!({
          ok: true,
          snapshotHash: harness.snapshotHash,
          diagnostics: [],
          tools: harness.allowedTools.map((name) => ({
            name,
            source: 'corral',
            schemaHash: 'b'.repeat(64),
            exposure: 'direct',
            sideEffect: name === 'run_check' ? 'external' : 'none',
          })),
        });
        return scripted.start(input, {
          ...host,
          prepareModelRequest: () =>
            host.prepareModelRequest({
              purpose: 'turn',
              directiveIds: [],
              contextHash: 'c'.repeat(64),
              contextBytes: 10,
              sections: [],
            }),
        });
      },
    },
  });
  const starter = createAutoStarter({
    startRun: (request) => coordinator.startRun(request),
    resolveUltra: (selection, primary, mode) => coordinator.resolveUltra(selection, primary, mode),
  });
  const result = await starter.start(
    {
      commandId: 'start',
      brief: 'Implement a fixture',
      mode: 'mock',
      qualityPreset: 'ultra',
      choice: { modelProfile: 'primary' },
      ultra: { version: 1, modelProfiles: ['primary', 'verifier'], verifierProfile: 'verifier' },
      harness: harness.binding,
    },
    { fileTools: true },
  );
  const final = result.runId
    ? await waitForProjection(new InProcessTransport(coordinator), result.runId, (p) =>
        ['succeeded', 'failed', 'cancelled'].includes(p.status),
      )
    : null;
  return { result, final, coordinator, seen, runCheck };
}

it.each([{ checks: [] }, { available: false }])(
  '[TC-ULTRA-003-N] refuses repository Ultra without selected isolated checks before starting agents: %j',
  async (options) => {
    const f = await fixture(options);
    expect(f.result.receipt.error?.code).toBe('CAPABILITY_DENIED');
    expect(f.seen).toHaveLength(0);
  },
);
it('[TC-ULTRA-003-H] pins selected checks, forces isolation, and gives execution evidence to the verifier', async () => {
  const f = await fixture();
  expect(f.final?.status).toBe('succeeded');
  expect(f.runCheck).toHaveBeenCalledOnce();
  expect(f.runCheck.mock.calls[0]![0]).toMatchObject({
    isolation: 'linux-bwrap',
    commandId: 'types',
  });
  const reviewer = f.seen.find((input) => input.nodeId === 'review')!;
  expect(reviewer.inputs.find((input) => input.name === 'recipe_check_types')?.text).toContain(
    '"verdict":"pass"',
  );
  const loop = f.coordinator
    .getRunSnapshot(f.result.runId!)!
    .definition.nodes.find((node) => node.type === 'loop');
  expect(loop?.type === 'loop' && loop.reviewRecipe?.checkIds).toEqual(['types']);
});
it.each(['error', 'stale', 'unisolated'] as const)(
  '[TC-ULTRA-003-N] blocks completion on %s check evidence',
  async (verdict) => {
    const f = await fixture({ verdict });
    expect(f.final?.status).toBe('failed');
    expect(f.final?.output).toBeNull();
    expect(f.seen.some((input) => input.nodeId === 'review')).toBe(false);
  },
);
it('[TC-ULTRA-003-N] a model pass cannot override a failed project check', async () => {
  const f = await fixture({ verdict: 'fail' });
  expect(f.final?.status).toBe('succeeded');
  expect(f.runCheck).toHaveBeenCalledTimes(2);
  expect(f.seen.filter((input) => input.nodeId === 'write')).toHaveLength(2);
});

it('[TC-ULTRA-003-N] rechecks the candidate after owned services finish shutdown', async () => {
  const f = await fixture({ mutateOnStop: true });
  expect(f.runCheck).toHaveBeenCalledOnce();
  expect(f.final?.status).toBe('failed');
  expect(f.final?.output).toBeNull();
});

it('[TC-ULTRA-003-N] refuses a passing report for a tree changed after synthesis started', async () => {
  const f = await fixture({ changeBeforeCheck: true });
  expect(f.final?.status).toBe('failed');
  expect(
    f.seen
      .find((input) => input.nodeId === 'synthesize')
      ?.inputs.find((input) => input.name === 'candidate_tree')?.text,
  ).toBe('1'.repeat(40));
  expect(f.runCheck.mock.calls[0]?.[0].expectedTree).toBe('1'.repeat(40));
});
