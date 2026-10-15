import {
  type CorralDefinition,
  CorralDefinition as Definition,
  type RunEvent,
} from '@corral/contracts';
import {
  FakeClock,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

const done = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
/** A pending approval, once its commit (which also moves the run to awaiting_user) applied. */
const pending = (p: RunProjection) =>
  p.status === 'awaiting_user'
    ? (Object.values(p.approvals).find((a) => a.status === 'pending') ?? null)
    : null;

async function drain() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function runtime(options: Partial<ScriptedAgentOptions> = {}, policy = SPEC_HARD_CAPS) {
  const clock = new FakeClock();
  return new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      policy,
      agents: new ScriptedAgentAdapter({ turns: 1, ...options }),
    }),
  );
}

async function start(
  transport: InProcessTransport,
  definition: CorralDefinition = Definition.parse(researchTeam),
) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_team',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  return { runId, events };
}

let commands = 0;
async function resolve(
  transport: InProcessTransport,
  runId: string,
  decision: 'approve' | 'reject',
  override: {
    subjectVersionId?: string;
    approvalId?: string;
    expectedControlRevision?: number;
    commandId?: string;
  } = {},
) {
  const p = await waitForProjection(transport, runId, (x) => pending(x) !== null || done(x));
  const approval = pending(p);
  return transport.sendCommand({
    schemaVersion: '0.1',
    commandId: override.commandId ?? `cmd_resolve_${++commands}`,
    runId,
    type: 'resolve_approval',
    expectedControlRevision: override.expectedControlRevision ?? p.controlRevision,
    payload: {
      approvalId: override.approvalId ?? approval?.approvalId ?? 'appr_missing',
      decision,
      subjectVersionId:
        override.subjectVersionId ?? approval?.subjectVersionIds[0] ?? 'artv_missing',
    },
  });
}

const executionsOf = (p: RunProjection, nodeId: string) =>
  (p.nodeExecutions[nodeId] ?? []).map((id) => p.executions[id]);
const submittedBy = (p: RunProjection, executionId: string | undefined) =>
  p.tasks[p.executions[executionId ?? '']?.taskId ?? '']?.submittedArtifactVersionIds[0];

describe('review loop and approvals (C-026–C-029)', () => {
  it('[TC-RUN-003-H] [TC-ART-002-H] [TC-ART-002-N] round 2 reviews the new draft, then two approvals finalize the output', async () => {
    const transport = runtime();
    const { runId, events } = await start(transport);

    // The approval node asks the person once both rounds are reviewed.
    const atApproval = await waitForProjection(transport, runId, (p) => pending(p) !== null);
    expect(atApproval.status).toBe('awaiting_user');
    expect(pending(atApproval)?.kind).toBe('user_action');
    const [write1, write2] = executionsOf(atApproval, 'write');
    const [review1, review2] = executionsOf(atApproval, 'review');
    const draft1 = submittedBy(atApproval, write1?.executionId);
    const draft2 = submittedBy(atApproval, write2?.executionId);
    expect(draft1).not.toBe(draft2);
    // Round 2's reviewer was given round 2's draft, not draft@1.
    const reviews = Object.values(atApproval.reviews);
    expect(reviews.map((r) => [r.targetVersionId, r.verdict])).toEqual([
      [draft1, 'revise'],
      [draft2, 'pass'],
    ]);
    expect(reviews[1]?.reviewVersionId).toBe(submittedBy(atApproval, review2?.executionId));
    expect(reviews[0]?.reviewVersionId).toBe(submittedBy(atApproval, review1?.executionId));
    // draft@1 → draft@2 is one artifact with two versions.
    const [a1, a2] = [atApproval.artifacts[draft1 ?? ''], atApproval.artifacts[draft2 ?? '']];
    expect(a2?.artifactId).toBe(a1?.artifactId);
    expect([a1?.version, a2?.version]).toEqual([1, 2]);
    expect(a2?.parentVersionId).toBe(draft1);
    // Round 2 started with draft@1 and review@1 carried in, pinned.
    const round2 = events.find((e) => e.type === 'loop.iteration_started' && e.payload.no === 2);
    expect(
      round2?.type === 'loop.iteration_started' && [...round2.payload.pinnedCarryInputs].sort(),
    ).toEqual([draft1, reviews[0]?.reviewVersionId].sort());

    expect((await resolve(transport, runId, 'approve')).status).toBe('applied');
    const atFinal = await waitForProjection(
      transport,
      runId,
      (p) => pending(p)?.kind === 'final_output',
    );
    expect(pending(atFinal)?.subjectVersionIds).toEqual([draft2, reviews[1]?.reviewVersionId]);
    expect(pending(atFinal)?.criteriaVersionId).toBe(reviews[1]?.criteriaVersionId);
    await resolve(transport, runId, 'approve');
    const final = await waitForProjection(transport, runId, done);
    expect(final.status).toBe('succeeded');
    expect(final.output?.artifactVersionIds).toEqual([draft2]);
  });

  it('[TC-ART-004-H] completion, a passing review and the final approval are separate facts', async () => {
    const transport = runtime();
    const { runId } = await start(transport);
    await resolve(transport, runId, 'approve');
    await resolve(transport, runId, 'approve');
    const final = await waitForProjection(transport, runId, done);
    const finalApproval = Object.values(final.approvals).find((a) => a.kind === 'final_output');
    expect(finalApproval?.status).toBe('approved');
    expect(final.outputApprovalId).toBe(finalApproval?.approvalId);
    const lastWrite = executionsOf(final, 'write').at(-1);
    expect(final.tasks[lastWrite?.taskId ?? '']?.status).toBe('completed');
    expect(Object.values(final.reviews).at(-1)?.verdict).toBe('pass');
  });

  it('[TC-ART-003-H] [TC-ART-003-N] a malformed or mismatched review is never a pass', async () => {
    for (const bad of [
      () => 'not json at all',
      (_draft: string, criteria: string) =>
        JSON.stringify({
          targetArtifactVersionId: 'artv_9999',
          criteriaVersionId: criteria,
          verdict: 'pass',
          issues: [],
          evidenceRefs: [],
        }),
      (draft: string) =>
        JSON.stringify({
          targetArtifactVersionId: draft,
          criteriaVersionId: 'crit_9999',
          verdict: 'pass',
          issues: [],
          evidenceRefs: [],
        }),
      (draft: string, criteria: string) =>
        JSON.stringify({
          targetArtifactVersionId: draft,
          criteriaVersionId: criteria,
          verdict: 'revise',
          issues: [],
          evidenceRefs: [],
        }),
    ]) {
      const transport = runtime({
        review: (input) => {
          const draft = input.inputs.find((i) => i.name === 'draft')?.artifactVersionId ?? '';
          return bad(draft, input.criteriaVersionId);
        },
      });
      const { runId, events } = await start(transport);
      const asked = await waitForProjection(
        transport,
        runId,
        (p) => pending(p) !== null || done(p),
      );
      const recorded = events.filter((e) => e.type === 'review.recorded');
      expect(recorded.map((e) => e.type === 'review.recorded' && e.payload.verdict)).toEqual([
        'inconclusive',
      ]);
      // An inconclusive review goes to the person, not to the next step.
      expect(pending(asked)?.kind).toBe('user_action');
      expect(executionsOf(asked, 'write')).toHaveLength(1);
      await resolve(transport, runId, 'reject');
      const final = await waitForProjection(transport, runId, done);
      expect(final.output).toBeNull();
      expect(final.status).toBe('cancelled');
    }
  });

  it('[TC-RUN-003-N] at the Loop cap no third round starts without the person, and approval cannot pass the hard cap', async () => {
    const alwaysRevise = { review: () => 'revise' as const };
    const transport = runtime(alwaysRevise);
    const { runId } = await start(transport);
    const atCap = await waitForProjection(transport, runId, (p) => pending(p) !== null);
    expect(pending(atCap)?.kind).toBe('loop_cap');
    expect(executionsOf(atCap, 'write')).toHaveLength(2);
    await drain();
    expect(executionsOf((await transport.getSnapshot(runId)).projection, 'write')).toHaveLength(2);
    await resolve(transport, runId, 'approve');
    await waitForProjection(transport, runId, (p) => executionsOf(p, 'write').length === 3);

    // With the installation's hard cap at 2 rounds, the cap is final: no approval is offered.
    const capped = runtime(alwaysRevise, { ...SPEC_HARD_CAPS, maxLoopIterations: 2 });
    const second = await start(capped);
    const final = await waitForProjection(capped, second.runId, done);
    expect(Object.values(final.approvals)).toEqual([]);
    expect(executionsOf(final, 'write')).toHaveLength(2);
    expect(final.status).toBe('failed');
    const limit = second.events.find((e) => e.type === 'limit.reached');
    expect(limit?.type === 'limit.reached' && limit.payload.limitKind).toBe('loop_iterations');
  });

  it('[TC-RNS-008-H] [TC-RNS-008-N] [TC-ART-004-N] an approval applies once and refuses a stale subject', async () => {
    const transport = runtime();
    const { runId } = await start(transport);
    const atApproval = await waitForProjection(transport, runId, (p) => pending(p) !== null);
    const approval = pending(atApproval);
    const [write1] = executionsOf(atApproval, 'write');
    const oldDraft = submittedBy(atApproval, write1?.executionId) ?? '';

    const stale = await resolve(transport, runId, 'approve', { subjectVersionId: oldDraft });
    expect(stale.error?.code).toBe('APPROVAL_STALE');
    const behind = await resolve(transport, runId, 'approve', { expectedControlRevision: 7 });
    expect(behind.error?.code).toBe('STALE_CONTROL_REVISION');

    const first = await resolve(transport, runId, 'approve', { commandId: 'cmd_approve' });
    const resent = await resolve(transport, runId, 'approve', {
      commandId: 'cmd_approve',
      approvalId: approval?.approvalId ?? '',
      subjectVersionId: approval?.subjectVersionIds[0] ?? '',
    });
    expect(resent).toEqual(first);
    const again = await resolve(transport, runId, 'approve', {
      approvalId: approval?.approvalId ?? '',
      subjectVersionId: approval?.subjectVersionIds[0] ?? '',
    });
    expect(again.error?.code).toBe('APPROVAL_STALE');
    const p = (await transport.getSnapshot(runId)).projection;
    expect(p.approvals[approval?.approvalId ?? '']?.status).toBe('approved');
  });
});
