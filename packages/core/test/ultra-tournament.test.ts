import {
  type AgentHost,
  type AgentStartInput,
  DEFAULT_LIMITS,
  type EffectiveHarnessSnapshot,
  UltraSelection,
  type VerificationReport,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  Coordinator,
  type CoordinatorDeps,
  createAutoStarter,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

// CR-048: version 2 Ultra runs a candidate tournament — isolated candidates, an anonymous
// judgment over passing candidates, refinement of the winner's copy, and an apply that asks
// nobody. Deterministic agents, trees and checks; no paid calls.

const BASELINE = '1'.repeat(40);
type Verdict = 'pass' | 'fail' | 'error';
type JudgeReply = (kind: 'selection' | 'refinement', input: AgentStartInput, nth: number) => string;

const given = (input: AgentStartInput, name: string) =>
  input.inputs.find((item) => item.name === name)?.text ?? null;
const labelsOf = (input: AgentStartInput) =>
  input.inputs.flatMap((item) =>
    /^candidate_[A-E]$/.test(item.name) ? [item.name.slice(-1)] : [],
  );

/** Picks the last label and borrows the first other label's first changed file. */
const defaultJudge: JudgeReply = (kind, input, nth) => {
  if (kind === 'selection') {
    const labels = labelsOf(input);
    const winner = labels.at(-1)!;
    const other = labels.find((label) => label !== winner);
    const otherFiles = other
      ? (JSON.parse(given(input, `candidate_${other}`)!) as { files: string[] }).files
      : [];
    return JSON.stringify({
      version: 1,
      kind: 'selection',
      winner,
      ranking: [winner, ...labels.filter((label) => label !== winner)],
      reasons: [{ candidate: winner, criterion: 'criteria', evidence: 'checks pass' }],
      improvements: ['tighten the error path'],
      borrow: other ? [{ from: other, what: 'its helper', paths: otherFiles.slice(0, 1) }] : [],
    });
  }
  return JSON.stringify({
    version: 1,
    kind: 'refinement',
    verdict: nth === 1 ? 'improved' : 'equal',
    done: nth !== 1,
    reasons: ['compared the proposed revision'],
    improvements: nth === 1 ? ['one more pass'] : [],
  });
};

async function fixture(
  options: {
    ultra?: Partial<Extract<UltraSelection, { version: 2 }>>;
    fileTools?: boolean;
    diff?: string;
    contextWindow?: number;
    onReady?: (input: AgentStartInput, host: AgentHost) => Promise<void>;
    available?: boolean;
    /** Check verdict for a candidate's nth check (1-based, counted per candidate). */
    verdict?: (candidateId: string, nth: number) => Verdict;
    judge?: JudgeReply;
    promotion?: (input: { commandId: string }) => Promise<{ checkpointId: string }>;
    /** Called as each agent starts; may submit commands or block. */
    onStart?: (input: AgentStartInput, coordinator: Coordinator) => Promise<void> | void;
    until?: string[];
    clock?: FakeClock;
    /** Start the version 1 comparison instead, to show it is unchanged. */
    legacy?: boolean;
  } = {},
) {
  const clock = options.clock ?? new FakeClock();
  const seen: AgentStartInput[] = [];
  const permits: { nodeId: string; maxOutputTokens: number }[] = [];
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
      checkIds: ['types'],
      lspServerIds: [],
    },
  };
  // Each write gives its candidate copy a new tree; a restore puts an accepted tree back.
  const trees = new Map<string, string>();
  let written = 0;
  const treeOf = (candidateId: string) => trees.get(candidateId) ?? BASELINE;
  const candidateOfExecution = (executionId: string) =>
    seen.find((input) => input.executionId === executionId)?.candidateId ?? null;
  const checksRun = new Map<string, number>();
  const runCheck = vi.fn<NonNullable<NonNullable<CoordinatorDeps['files']>['runCheck']>>(
    async (input, plan) => {
      const candidateId = candidateOfExecution(input.executionId) ?? 'none';
      const nth = (checksRun.get(candidateId) ?? 0) + 1;
      checksRun.set(candidateId, nth);
      const verdict = options.verdict?.(candidateId, nth) ?? 'pass';
      const report: VerificationReport = {
        verificationId: `check_${candidateId}_${nth}`,
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
        tree: plan.tree,
        state: verdict === 'error' ? 'error' : 'completed',
        verdict: verdict === 'error' ? 'not_evaluated' : verdict,
        isolation: 'linux-bwrap',
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
      return { ...report, stale: false };
    },
  );
  const judgeCalls = { selection: 0, refinement: 0 };
  const judge = options.judge ?? defaultJudge;
  const scripted = new ScriptedAgentAdapter({
    turns: 1,
    collaborate: false,
    appendNotes: false,
    reply: (_turn, input) => {
      if (input.nodeId !== 'judge') return `${input.nodeId} ${input.round}`;
      const kind = JSON.parse(given(input, 'tournament') ?? '{}').kind as
        | 'selection'
        | 'refinement';
      judgeCalls[kind]++;
      return judge(kind, input, judgeCalls[kind]);
    },
    review: () => 'pass',
  });
  const store = new InMemoryRunStore();
  const promoteCandidate = vi.fn(
    options.promotion ?? (async (_input: { commandId: string }) => ({ checkpointId: 'promoted' })),
  );
  const restoreCandidate = vi.fn(async (_runId: string, candidateId: string, tree: string) => {
    trees.set(candidateId, tree);
  });
  const candidateDiff = vi.fn(
    async (_runId: string, candidateId: string, tree: string, paths?: string[]) => {
      const files = [`src/${candidateId}.ts`, 'README.md'];
      const shown = paths ? files.filter((file) => paths.includes(file)) : files;
      return {
        files,
        diff: options.diff ?? shown.map((file) => `--- ${file} @ ${tree}`).join('\n'),
      };
    },
  );
  const coordinator: Coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    harnesses: { resolve: () => harness },
    ...(options.contextWindow
      ? {
          models: {
            resolve: (profile: string) => ({
              ok: true as const,
              snapshot: {
                profile,
                provider: null,
                modelId: null,
                auth: 'mock' as const,
                contextWindow: options.contextWindow,
              },
            }),
          },
        }
      : {}),
    files: {
      available: () => true,
      execute: async () => ({}),
      isolatedChecksAvailable: () => options.available ?? true,
      currentTreeForRun: async () => BASELINE,
      prepareCandidates: async () => ({ baselineTree: BASELINE }),
      bindCandidateExecution: () => {},
      currentCandidateTree: async (_runId, candidateId) => treeOf(candidateId),
      promoteCandidate,
      restoreCandidate,
      candidateDiff,
      runCheck,
      planCheck: async (input) => {
        const candidateId = candidateOfExecution(input.executionId);
        return {
          commandId: input.commandId,
          name: 'Types',
          argv: ['node', 'check.mjs'],
          timeoutMs: 1000,
          configRevision: 1,
          fingerprint: 'd'.repeat(64),
          tree: candidateId ? treeOf(candidateId) : BASELINE,
          trusted: true,
        };
      },
    },
    agents: {
      start: async (input, host) => {
        seen.push(input);
        if (input.candidateId && input.nodeId.startsWith('write_'))
          trees.set(input.candidateId, (++written).toString(16).padStart(40, 'a'));
        await options.onStart?.(input, coordinator);
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
        await options.onReady?.(input, host);
        return scripted.start(input, {
          ...host,
          prepareModelRequest: async () => {
            const permit = await host.prepareModelRequest({
              purpose: 'turn',
              directiveIds: [],
              contextHash: 'c'.repeat(64),
              contextBytes: 10,
              sections: [],
            });
            permits.push({ nodeId: input.nodeId, maxOutputTokens: permit.maxOutputTokens });
            return permit;
          },
        });
      },
    },
  });
  const starter = createAutoStarter({
    startRun: (request) => coordinator.startRun(request),
    resolveUltra: (selection, primary, mode, models, context) =>
      coordinator.resolveUltra(selection, primary, mode, models, context),
  });
  const result = await starter.start(
    {
      commandId: 'start',
      sessionId: 'session',
      brief: 'Implement a fixture',
      mode: 'mock',
      qualityPreset: 'ultra',
      choice: { modelProfile: 'primary' },
      ultra: options.legacy
        ? {
            version: 1,
            modelProfiles: ['primary', 'verifier'],
            verifierProfile: 'verifier',
            comparison: { modelProfiles: ['primary', 'verifier'] },
          }
        : {
            version: 2,
            modelProfiles: ['primary', 'verifier'],
            verifierProfile: 'verifier',
            ...options.ultra,
          },
      harness: harness.binding,
    },
    { fileTools: options.fileTools ?? true },
  );
  const final = result.runId
    ? await waitForProjection(new InProcessTransport(coordinator), result.runId, (p) =>
        (options.until ?? ['succeeded', 'failed', 'cancelled', 'awaiting_user']).includes(p.status),
      )
    : null;
  return {
    result,
    final,
    coordinator,
    seen,
    permits,
    trees,
    judgeCalls,
    runCheck,
    promoteCandidate,
    restoreCandidate,
    store,
    clock,
  };
}

const judges = (seen: AgentStartInput[]) => seen.filter((input) => input.nodeId === 'judge');
const settled = (coordinator: Coordinator, runId: string, statuses: string[]) =>
  waitForProjection(new InProcessTransport(coordinator), runId, (p) => statuses.includes(p.status));

describe('CR-048 selection contract', () => {
  it('[TC-ULTRA-004-H] accepts a version 2 selection and keeps candidates inside the pool', () => {
    expect(
      UltraSelection.safeParse({
        version: 2,
        modelProfiles: ['a', 'b'],
        verifierProfile: 'b',
        candidates: ['a', 'a', 'b'],
        refinementRounds: 3,
        autoApply: false,
      }).success,
    ).toBe(true);
    expect(
      UltraSelection.safeParse({
        version: 2,
        modelProfiles: ['a', 'b'],
        verifierProfile: 'b',
        candidates: ['a', 'c'],
      }).success,
    ).toBe(false);
    expect(
      UltraSelection.safeParse({
        version: 2,
        modelProfiles: ['a', 'b'],
        verifierProfile: 'b',
        refinementRounds: 4,
      }).success,
    ).toBe(false);
    expect(
      UltraSelection.safeParse({ version: 1, modelProfiles: ['a', 'b'], verifierProfile: 'b' })
        .success,
    ).toBe(true);
  });
});

describe('CR-048 candidate tournament', () => {
  it('[TC-ULTRA-004-H] judges anonymous passing candidates, refines the winner and applies it without confirmation', async () => {
    const f = await fixture();
    const runId = f.result.runId!;
    expect(f.result.autoRoute?.ultra).toMatchObject({
      version: 2,
      mode: 'competition',
      refinementRounds: 2,
      autoApply: true,
      comparison: { modelProfiles: ['primary', 'verifier'] },
    });
    expect(f.final?.status, JSON.stringify(f.final?.status)).toBe('succeeded');
    const view = f.coordinator.candidateComparison(runId)!;
    expect(view.status).toBe('selected');
    expect(view.selectedCandidateId).toBe('candidate_2');
    expect(view.tournament).toMatchObject({
      judgeProfile: 'verifier',
      winnerCandidateId: 'candidate_2',
      ranking: ['candidate_2', 'candidate_1'],
      judgment: { state: 'valid' },
      held: null,
    });
    // Round 1 was accepted; round 2 changed nothing worth keeping and was put back.
    expect(view.tournament!.rounds.map((round) => round.state)).toEqual(['accepted', 'discarded']);
    const accepted = view.tournament!.rounds[0]!.tree!;
    expect(view.candidates[1]!.tree).toBe(accepted);
    expect(f.restoreCandidate).toHaveBeenLastCalledWith(runId, 'candidate_2', accepted);
    expect(f.promoteCandidate).toHaveBeenCalledTimes(1);
    expect(f.promoteCandidate.mock.calls[0]![0]).toMatchObject({
      runId,
      candidateId: 'candidate_2',
      expectedTree: accepted,
      baselineTree: BASELINE,
      commandId: `auto_apply_${runId}`,
    });
    // The judge sees labels, diffs and checks, never which model wrote what.
    expect(judges(f.seen)).toHaveLength(3);
    for (const input of judges(f.seen)) {
      expect(input.modelProfile).toBe('verifier');
      const shown = input.inputs.map((item) => item.text ?? '').join('\n');
      expect(shown).not.toMatch(/\b(primary|verifier)\b/);
    }
    // The refinement writer receives the judge's points and the borrowed diff.
    const refining = f.seen.filter((input) => input.nodeId === 'write_2').at(1)!;
    const brief = JSON.parse(given(refining, 'refinement')!);
    expect(brief.improvements).toEqual(['tighten the error path']);
    expect(brief.borrow[0].diff).toContain('src/candidate_1.ts');
    // The mock has no catalog metadata; unlimited execution is separate from its output fallback.
    expect(f.final?.usageLimits).toBe('none');
    expect(
      f.permits.every((permit) => permit.maxOutputTokens === DEFAULT_LIMITS.maxOutputTokensPerCall),
    ).toBe(true);
    // Another select after the apply cannot apply again.
    expect(
      f.coordinator.submit({
        schemaVersion: '0.1',
        runId,
        commandId: 'again',
        type: 'select_candidate',
        expectedControlRevision: f.coordinator.getSnapshot(runId).projection.controlRevision,
        payload: { candidateId: 'candidate_1', tree: view.candidates[0]!.tree! },
      }).status,
    ).toBe('rejected');
    expect(f.promoteCandidate).toHaveBeenCalledTimes(1);
  });

  it('[TC-ULTRA-004-H] a single passing candidate wins without a judgment call', async () => {
    const f = await fixture({
      ultra: { refinementRounds: 0 },
      verdict: (candidateId) => (candidateId === 'candidate_1' ? 'error' : 'pass'),
    });
    expect(f.final?.status).toBe('succeeded');
    expect(judges(f.seen)).toHaveLength(0);
    const view = f.coordinator.candidateComparison(f.result.runId!)!;
    expect(view.tournament?.winnerCandidateId).toBe('candidate_2');
    expect(f.promoteCandidate.mock.calls[0]![0]).toMatchObject({ candidateId: 'candidate_2' });
  });

  it('[TC-ULTRA-004-N] an invalid judgment is retried once and then leaves manual selection open', async () => {
    const f = await fixture({ judge: () => 'not a judgment' });
    const runId = f.result.runId!;
    expect(f.final?.status).toBe('awaiting_user');
    expect(judges(f.seen)).toHaveLength(2);
    const view = f.coordinator.candidateComparison(runId)!;
    expect(view.status).toBe('judgment_failed');
    expect(view.tournament?.judgment.state).toBe('invalid');
    expect(f.promoteCandidate).not.toHaveBeenCalled();
    const candidate = view.candidates[0]!;
    expect(
      f.coordinator.submit({
        schemaVersion: '0.1',
        runId,
        commandId: 'manual',
        type: 'select_candidate',
        expectedControlRevision: f.final!.controlRevision,
        payload: { candidateId: candidate.candidateId, tree: candidate.tree! },
      }).status,
    ).toBe('accepted');
    await settled(f.coordinator, runId, ['succeeded']);
    expect(f.promoteCandidate.mock.calls[0]![0]).toMatchObject({ commandId: 'manual' });
  });

  it('[TC-ULTRA-004-N] a judgment naming a failed candidate or evidence it does not have is rejected', async () => {
    const f = await fixture({
      ultra: { candidates: ['primary', 'verifier', 'primary'] },
      verdict: (candidateId) => (candidateId === 'candidate_1' ? 'error' : 'pass'),
      // Only passing candidates get a label, so the failed one cannot be named at all.
      judge: (kind, input, nth) =>
        kind === 'selection'
          ? JSON.stringify({
              version: 1,
              kind: 'selection',
              winner: nth === 1 ? 'A' : 'C',
              ranking: nth === 1 ? ['A', 'B'] : ['C', 'A'],
              reasons: [],
              improvements: [],
              borrow:
                nth === 1 ? [{ from: 'B', what: 'invented', paths: ['src/elsewhere.ts'] }] : [],
            })
          : defaultJudge(kind, input, nth),
    });
    expect(labelsOf(judges(f.seen)[0]!)).toEqual(['A', 'B']);
    expect(JSON.parse(given(judges(f.seen)[0]!, 'candidate_A')!).files).toContain(
      'src/candidate_2.ts',
    );
    expect(judges(f.seen)).toHaveLength(2);
    expect(f.coordinator.candidateComparison(f.result.runId!)?.status).toBe('judgment_failed');
    expect(f.promoteCandidate).not.toHaveBeenCalled();
  });

  it('[TC-ULTRA-004-N] refinement rounds that fail checks or regress are discarded and the copy restored', async () => {
    let refinementCheck = 0;
    const f = await fixture({
      verdict: (candidateId, nth) =>
        candidateId === 'candidate_2' && nth > 1 && ++refinementCheck === 1 ? 'fail' : 'pass',
      judge: (kind, input, nth) =>
        kind === 'refinement'
          ? JSON.stringify({
              version: 1,
              kind: 'refinement',
              verdict: 'worse',
              done: false,
              reasons: ['regressed'],
              improvements: [],
            })
          : defaultJudge(kind, input, nth),
    });
    const runId = f.result.runId!;
    expect(f.final?.status).toBe('succeeded');
    const view = f.coordinator.candidateComparison(runId)!;
    expect(view.tournament!.rounds.map((round) => [round.state, round.reason])).toEqual([
      ['discarded', 'checks_failed'],
      ['discarded', 'judged_worse'],
    ]);
    const original = view.candidates[1]!.tree!;
    expect(f.restoreCandidate).toHaveBeenCalledTimes(2);
    for (const call of f.restoreCandidate.mock.calls) expect(call[2]).toBe(original);
    expect(f.promoteCandidate.mock.calls[0]![0]).toMatchObject({ expectedTree: original });
  });

  it('[TC-ULTRA-004-N] a refused apply holds the winner and keeps manual selection open', async () => {
    let attempts = 0;
    const f = await fixture({
      ultra: { refinementRounds: 0 },
      promotion: async () => {
        if (++attempts === 1)
          throw new Error('working copy tree changed since candidate comparison began');
        return { checkpointId: 'promoted' };
      },
    });
    const runId = f.result.runId!;
    expect(f.final?.status).toBe('awaiting_user');
    const view = f.coordinator.candidateComparison(runId)!;
    expect(view.status).toBe('auto_apply_held');
    expect(view.tournament?.held).toContain('working copy tree changed');
    const winner = view.candidates.find(
      (c) => c.candidateId === view.tournament?.winnerCandidateId,
    )!;
    expect(
      f.coordinator.submit({
        schemaVersion: '0.1',
        runId,
        commandId: 'manual',
        type: 'select_candidate',
        expectedControlRevision: f.final!.controlRevision,
        payload: { candidateId: winner.candidateId, tree: winner.tree! },
      }).status,
    ).toBe('accepted');
    await settled(f.coordinator, runId, ['succeeded']);
    expect(f.promoteCandidate).toHaveBeenCalledTimes(2);
  });

  it('[TC-ULTRA-004-N] with auto apply off the judged winner waits for a person', async () => {
    const f = await fixture({ ultra: { refinementRounds: 0, autoApply: false } });
    expect(f.final?.status).toBe('awaiting_user');
    const view = f.coordinator.candidateComparison(f.result.runId!)!;
    expect(view.status).toBe('awaiting_selection');
    expect(view.tournament?.winnerCandidateId).toBe('candidate_2');
    expect(f.promoteCandidate).not.toHaveBeenCalled();
  });

  it('[TC-ULTRA-004-N] version 2 has no Run deadline or call timeout', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked: { coordinator: Coordinator; runId: string } | null = null;
    const clock = new FakeClock();
    const pending = fixture({
      clock,
      onStart: async (input, coordinator) => {
        if (input.nodeId !== 'judge' || blocked) return;
        blocked = { coordinator, runId: input.runId };
        await held;
      },
      until: ['succeeded', 'failed', 'cancelled'],
    });
    await vi.waitFor(() => expect(blocked).not.toBeNull());
    // Nothing but a person's cancel stops version 2; the old caps would have ended it here.
    clock.advance(DEFAULT_LIMITS.runDeadlineMs + DEFAULT_LIMITS.modelTimeoutMs + 1);
    await Promise.resolve();
    expect(blocked!.coordinator.getSnapshot(blocked!.runId).projection.status).toBe('running');
    release();
    const f = await pending;
    expect(f.final?.status).toBe('succeeded');
    expect(f.final?.usageLimits).toBe('none');
  });

  it('[TC-ULTRA-004-N] a request without a working copy starts as collaboration and says why', async () => {
    const f = await fixture({ fileTools: false, until: ['succeeded', 'failed'] });
    expect(f.final?.status).toBe('succeeded');
    expect(f.result.autoRoute?.ultra).toMatchObject({
      version: 2,
      mode: 'collaboration',
      fallbackReason: 'no_working_copy',
    });
    expect(f.result.autoRoute?.ultra).not.toHaveProperty('comparison');
    expect(f.coordinator.candidateComparison(f.result.runId!)).toBeNull();
  });

  it('[TC-ULTRA-004-N] version 1 keeps manual selection while new Runs use unlimited defaults', async () => {
    const f = await fixture({ legacy: true });
    expect(f.final?.status).toBe('awaiting_user');
    expect(f.coordinator.candidateComparison(f.result.runId!)?.status).toBe('awaiting_selection');
    expect(judges(f.seen)).toHaveLength(0);
    expect(f.promoteCandidate).not.toHaveBeenCalled();
    expect(f.final?.usageLimits).toBe('none');
    expect(
      f.permits.every((permit) => permit.maxOutputTokens <= DEFAULT_LIMITS.maxOutputTokensPerCall),
    ).toBe(true);
  });
});

describe('CR-048 cancellation and recovery', () => {
  it('[TC-ULTRA-004-F] cancelling the winner during refinement stops it and keeps the last accepted tree for a person', async () => {
    let writes = 0;
    const f = await fixture({
      onStart: (input, coordinator) => {
        if (input.nodeId !== 'write_2' || ++writes !== 2) return;
        coordinator.submit({
          schemaVersion: '0.1',
          runId: input.runId,
          commandId: 'cancel-winner',
          type: 'cancel_candidate',
          expectedControlRevision: coordinator.getSnapshot(input.runId).projection.controlRevision,
          payload: { candidateId: 'candidate_2' },
        });
      },
    });
    const runId = f.result.runId!;
    expect(f.final?.status).toBe('awaiting_user');
    const view = f.coordinator.candidateComparison(runId)!;
    expect(view.status).toBe('awaiting_selection');
    expect(view.candidates[1]!.state).toBe('acceptable');
    expect(view.tournament!.rounds.at(-1)?.state).toBe('cancelled');
    expect(f.restoreCandidate).toHaveBeenLastCalledWith(
      runId,
      'candidate_2',
      view.candidates[1]!.tree,
    );
    expect(f.promoteCandidate).not.toHaveBeenCalled();
  });

  it('[TC-ULTRA-004-F] cancelling the Run while judging applies nothing and a late judgment changes nothing', async () => {
    const f = await fixture({
      onStart: (input, coordinator) => {
        if (input.nodeId !== 'judge') return;
        coordinator.submit({
          schemaVersion: '0.1',
          runId: input.runId,
          commandId: 'cancel-run',
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'stop' },
        });
      },
    });
    expect(f.final?.status).toBe('cancelled');
    expect(f.promoteCandidate).not.toHaveBeenCalled();
    expect(f.coordinator.candidateComparison(f.result.runId!)?.status).not.toBe('selected');
  });

  it('[TC-ULTRA-004-F] a restart during the tournament never resumes the automatic apply', async () => {
    const f = await fixture({
      onStart: async (input) => {
        if (input.nodeId === 'judge') await new Promise(() => {});
      },
      until: ['running'],
    });
    await vi.waitFor(() => expect(judges(f.seen)).toHaveLength(1));
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
});

it('[TC-LLM-005-H] judge budgets all evidence together and can page the original anonymous packet', async () => {
  const diff = '--- source.ts\n' + '가日🙂'.repeat(30000);
  const observed: { bytes: number; ref: string | null; result: unknown; denied: boolean }[] = [];
  const f = await fixture({
    diff,
    contextWindow: 32768,
    ultra: { refinementRounds: 1 },
    onReady: async (input, host) => {
      if (input.nodeId !== 'judge') return;
      const candidate = input.inputs.find(
        (i) => i.name === 'candidate_A' || i.name === 'previous',
      )!;
      const result = await host.invokeTool({
        name: 'read_artifact',
        args: { artifactVersionId: candidate.sourceRef, offset: 10000, limit: 128 },
      });
      const denied = !(
        await host.invokeTool({
          name: 'read_artifact',
          args: { artifactVersionId: 'source_unowned' },
        })
      ).ok;
      observed.push({
        bytes: utf8ToBytes(JSON.stringify(input.inputs)).length,
        ref: candidate.sourceRef ?? null,
        result,
        denied,
      });
    },
  });
  expect(observed.length).toBeGreaterThan(0);
  for (const item of observed) {
    expect(item.bytes).toBeLessThan(16384);
    expect(item.ref).toMatch(/^source_/);
    expect(item.result).toMatchObject({
      ok: true,
      result: {
        offset: 10000,
        nextOffset: 10128,
        complete: false,
        text: expect.stringContaining('가日🙂'),
      },
    });
    expect(item.denied).toBe(true);
  }
  expect(f.final?.status).toBe('succeeded');
});
