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
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

async function fixture(
  options: {
    count?: number;
    checks?: string[];
    available?: boolean;
    promotion?: () => Promise<{ checkpointId: string }>;
    cancelCandidate?: boolean;
    cancelRun?: boolean;
    allFailed?: boolean;
    verdict?: 'pass' | 'fail' | 'error' | 'stale' | 'unisolated';
  } = {},
) {
  const clock = new FakeClock();
  const seen: AgentStartInput[] = [];
  let active = 0,
    maxActive = 0;
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
  const tree = '1'.repeat(40);
  let checks = 0;
  const runCheck = vi.fn<NonNullable<NonNullable<CoordinatorDeps['files']>['runCheck']>>(
    async (input, plan) => {
      const verdict = checks++ === 0 || options.allFailed ? (options.verdict ?? 'pass') : 'pass';
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
        verdict: verdict === 'error' ? 'not_evaluated' : verdict === 'fail' ? 'fail' : 'pass',
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
  });
  const store = new InMemoryRunStore();
  const promoteCandidate = vi.fn(options.promotion ?? (async () => ({ checkpointId: 'promoted' })));
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    harnesses: { resolve: () => harness },
    files: {
      available: () => true,
      execute: async () => ({}),
      isolatedChecksAvailable: () => options.available ?? true,
      currentTreeForRun: async () => tree,
      prepareCandidates: async () => ({ baselineTree: tree }),
      bindCandidateExecution: () => {},
      currentCandidateTree: async () => tree,
      promoteCandidate,
      runCheck,
      planCheck: async (input) => {
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
        active++;
        maxActive = Math.max(maxActive, active);
        if (input.nodeId === 'write_1' && (options.cancelCandidate || options.cancelRun)) {
          const revision = coordinator.getSnapshot(input.runId).projection.controlRevision;
          coordinator.submit(
            options.cancelRun
              ? {
                  schemaVersion: '0.1',
                  runId: input.runId,
                  commandId: 'cancel-run',
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'test' },
                }
              : {
                  schemaVersion: '0.1',
                  runId: input.runId,
                  commandId: 'cancel-candidate',
                  type: 'cancel_candidate',
                  expectedControlRevision: revision,
                  payload: { candidateId: input.candidateId! },
                },
          );
        }
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
        const handle = await scripted.start(input, {
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
        return {
          ...handle,
          waitForSettlement: async () => {
            try {
              return await handle.waitForSettlement();
            } finally {
              active--;
            }
          },
        };
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
      sessionId: 'session',
      brief: 'Implement a fixture',
      mode: 'mock',
      qualityPreset: 'ultra',
      choice: { modelProfile: 'primary' },
      ultra: {
        version: 1,
        modelProfiles: ['primary', 'verifier'],
        verifierProfile: 'verifier',
        comparison: {
          modelProfiles: Array.from({ length: options.count ?? 3 }, (_, index) =>
            index % 2 ? 'verifier' : 'primary',
          ),
        },
      },
      harness: harness.binding,
    },
    { fileTools: true },
  );
  const final = result.runId
    ? await waitForProjection(new InProcessTransport(coordinator), result.runId, (p) =>
        ['succeeded', 'failed', 'cancelled', 'awaiting_user'].includes(p.status),
      )
    : null;
  return { result, final, coordinator, seen, runCheck, promoteCandidate, store, clock, maxActive };
}

it('[TC-ULTRA-002-H] uses one Run with isolated candidates and promotes exactly the selected checked tree', async () => {
  const f = await fixture({ count: 5 });
  expect(f.maxActive).toBeLessThanOrEqual(3);
  expect(f.result.receipt.status, JSON.stringify(f.result.receipt)).toBe('applied');
  const view = f.coordinator.candidateComparison(f.result.runId!);
  expect(view?.status).toBe('awaiting_selection');
  expect(view?.candidates.map((c) => c.state)).toEqual(Array(5).fill('acceptable'));
  expect(new Set(f.seen.map((input) => input.runId)).size).toBe(1);
  expect(
    f.seen
      .filter((input) => input.candidateId)
      .every((input) => input.model.workerIsolation === 'linux-bwrap'),
  ).toBe(true);
  expect(f.runCheck).toHaveBeenCalledTimes(5);
  const candidate = view!.candidates[1]!;
  const command = {
    schemaVersion: '0.1' as const,
    commandId: 'select',
    runId: f.result.runId!,
    expectedControlRevision: f.final!.controlRevision,
    type: 'select_candidate' as const,
    payload: { candidateId: candidate.candidateId, tree: candidate.tree! },
  };
  expect(f.coordinator.submit(command).status).toBe('accepted');
  await waitForProjection(
    new InProcessTransport(f.coordinator),
    f.result.runId!,
    (p) => p.status === 'succeeded',
  );
  expect(f.coordinator.candidateComparison(f.result.runId!)?.selectedCandidateId).toBe(
    candidate.candidateId,
  );
  expect(f.coordinator.submit(command).status).toBe('applied');
});

it('[TC-ULTRA-002-N] a failed isolated check excludes only its candidate and rejects stale selection', async () => {
  const f = await fixture({ verdict: 'error' });
  const view = f.coordinator.candidateComparison(f.result.runId!)!;
  expect(view.status).toBe('awaiting_selection');
  expect(view.candidates.map((candidate) => candidate.state)).toEqual([
    'failed',
    'acceptable',
    'acceptable',
  ]);
  expect(view.candidates[0]?.checks).toHaveLength(1);
  expect(view.candidates[0]?.tree).toBe('1'.repeat(40));
  const runId = f.result.runId!,
    revision = f.coordinator.getSnapshot(runId).projection.controlRevision;
  expect(
    f.coordinator.submit({
      schemaVersion: '0.1',
      runId,
      commandId: 'stale',
      type: 'select_candidate',
      expectedControlRevision: revision,
      payload: { candidateId: 'candidate_2', tree: '2'.repeat(40) },
    }).status,
  ).toBe('rejected');
  expect(f.promoteCandidate).not.toHaveBeenCalled();
});
it('[TC-ULTRA-002-F] candidate cancellation preserves siblings and a late submission cannot restore its eligibility', async () => {
  const f = await fixture({ cancelCandidate: true });
  const view = f.coordinator.candidateComparison(f.result.runId!)!;
  expect(view.status).toBe('awaiting_selection');
  expect(view.candidates.map((candidate) => candidate.state)).toEqual([
    'cancelled',
    'acceptable',
    'acceptable',
  ]);
  expect(f.seen.some((input) => input.nodeId === 'synthesize_1')).toBe(false);
});
it('[TC-ULTRA-002-F] run cancellation stops every candidate and restart never promotes saved evidence', async () => {
  const stopped = await fixture({ cancelRun: true });
  expect(stopped.final?.status).toBe('cancelled');
  expect(stopped.promoteCandidate).not.toHaveBeenCalled();
  const f = await fixture();
  const restored = new Coordinator({
    store: f.store,
    clock: f.clock,
    timers: f.clock,
    ids: new SequentialIdFactory(),
    agents: {
      start: async () => {
        throw new Error('must not restart');
      },
    },
  });
  expect(restored.getSnapshot(f.result.runId!).projection.status).toBe('interrupted');
  expect(restored.candidateComparison(f.result.runId!)?.status).toBe('interrupted');
  expect(f.promoteCandidate).not.toHaveBeenCalled();
});
it('[TC-ULTRA-002-N] no failed check is accepted when every candidate fails', async () => {
  const f = await fixture({ allFailed: true, verdict: 'error' });
  expect(f.final?.status).toBe('failed');
  expect(f.coordinator.candidateComparison(f.result.runId!)?.status).toBe(
    'no_acceptable_candidate',
  );
  expect(f.promoteCandidate).not.toHaveBeenCalled();
});

it('[TC-ULTRA-002-F] keeps the copy owner while an admitted promotion is applying', async () => {
  let complete!: () => void;
  const applying = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const f = await fixture({
    promotion: async () => {
      await applying;
      return { checkpointId: 'promoted' };
    },
  });
  const runId = f.result.runId!,
    candidate = f.coordinator.candidateComparison(runId)!.candidates[0]!;
  expect(
    f.coordinator.submit({
      schemaVersion: '0.1',
      runId,
      commandId: 'promote',
      type: 'select_candidate',
      expectedControlRevision: f.final!.controlRevision,
      payload: { candidateId: candidate.candidateId, tree: candidate.tree! },
    }).status,
  ).toBe('accepted');
  await Promise.resolve();
  const cancelled = f.coordinator.submit({
    schemaVersion: '0.1',
    runId,
    commandId: 'cancel-during-apply',
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'stop' },
  });
  expect(cancelled.error?.code).toBe('CAPABILITY_DENIED');
  expect(f.coordinator.getSnapshot(runId).projection.status).toBe('awaiting_user');
  f.clock.advance(f.final!.limits!.runDeadlineMs);
  expect(f.coordinator.getSnapshot(runId).projection.status).toBe('awaiting_user');
  complete();
  await waitForProjection(
    new InProcessTransport(f.coordinator),
    runId,
    (p) => p.status === 'succeeded',
  );
  expect(f.promoteCandidate).toHaveBeenCalledTimes(1);
});
