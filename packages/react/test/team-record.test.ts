import {
  type CorralDefinition,
  type EventOf,
  type RequiredOutputReview,
  RunEvent,
} from '@corral/contracts';
import { applyEvent, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { assert, describe, expect, it } from 'vitest';
import { selectTeamRecord } from '../src/run/teamRecord.ts';

const shared = {
  modelProfile: 'critic',
  principles: 'Check sources.',
  targets: { kind: 'all' },
} as const;
const gate: RequiredOutputReview = {
  bindingId: 'binding',
  bindingName: 'final',
  sourceNodeId: 'writer',
  reviewerNodeId: 'reviewer',
  decisionNodeId: 'decision',
  loopNodeId: 'loop',
};
const zero = { total: 0, open: 0, answered: 0, cancelled: 0, timed_out: 0 };

function log() {
  let projection = emptyProjection('run');
  projection.currentCriteriaVersionId = 'criteria';
  projection.status = 'running';
  const events: RunEvent[] = [];
  function add<K extends RunEvent['type']>(
    type: K,
    payload: EventOf<K>['payload'],
    executionId?: string,
  ) {
    const seq = events.length + 1;
    const event = RunEvent.parse({
      schemaVersion: '0.1',
      runId: 'run',
      eventId: `event_${seq}`,
      runSeq: seq,
      actor: { kind: 'runtime', id: 'runtime' },
      recordedAt: '2026-11-10T10:00:00Z',
      causedByEventIds: [],
      type,
      payload,
      ...(executionId ? { executionId } : {}),
    });
    projection = applyEvent(projection, event);
    events.push(event);
    return seq;
  }
  function execution(
    id: string,
    nodeId: string,
    iterationId: string | null = null,
    advisor = false,
  ) {
    add('execution.created', {
      executionId: id,
      nodeId,
      iterationId,
      taskId: `task_${id}`,
      attemptNo: 1,
      parentExecutionId: null,
      depth: 0,
      modelProfile: 'model-a',
      ...(advisor ? { advisor: true } : {}),
    });
  }
  return {
    add,
    execution,
    events,
    get p() {
      return projection;
    },
  };
}

it('distinguishes an unconfigured team, zero questions and zero observations', () => {
  const { p } = log();
  const d = linearCorral(['writer']);
  expect(selectTeamRecord(p, d, [])).toBeNull();
  d.sharedOutrider = shared;
  expect(selectTeamRecord(p, d, [])).toEqual({ questions: zero, observation: null, reviews: [] });
  d.sharedOutrider.observation = {
    targets: { kind: 'all' },
    review: { interval: 2, maxRequestsPerReview: 3 },
  };
  expect(selectTeamRecord(p, d, [])?.observation).toEqual({
    delivered: 0,
    notDelivered: 0,
    late: 0,
    deliveredSeqs: [],
    notDeliveredSeqs: [],
    lateSeqs: [],
  });
});

it('counts each actual shared question once by its own status, not by the target name or model calls', () => {
  const l = log();
  const d = { ...linearCorral(['writer']), sharedOutrider: shared };
  for (const status of ['open', 'answered', 'cancelled', 'timed_out', 'ordinary'] as const) {
    l.add('message.question_created', {
      questionId: status,
      taskId: `task_${status}`,
      senderExecutionId: 'e',
      targetRoleId: 'outrider',
      targetNodeId: 'outrider',
      body: 'Check this?',
      artifactRefs: [],
      deadline: '2026-11-11T10:00:00Z',
      ...(status === 'ordinary' ? {} : { sharedOutrider: true }),
    });
    if (status !== 'open' && status !== 'ordinary')
      l.add('message.closed', {
        questionId: status,
        outcome: status,
        answerRef: status === 'answered' ? 'answer' : null,
      });
  }
  const counts = { total: 4, open: 1, answered: 1, cancelled: 1, timed_out: 1 };
  expect(selectTeamRecord(l.p, d, l.events)?.questions).toEqual(counts);
  // Older expanded snapshots lost the authored setting, but a marked question remains evidence.
  expect(selectTeamRecord(l.p, linearCorral(['writer']), l.events)?.questions).toEqual(counts);
});

it('links admitted opinions to their delivery, and only late results from an observing execution', () => {
  const l = log();
  const d: CorralDefinition = {
    ...linearCorral(['writer']),
    sharedOutrider: {
      ...shared,
      observation: { targets: { kind: 'all' }, review: { interval: 2, maxRequestsPerReview: 3 } },
    },
  };
  l.execution('watcher', 'observer', null, true);
  l.execution('responder', 'consultant');
  const advice = {
    observerExecutionId: 'watcher',
    targetExecutionId: 'work',
    severity: 'concern',
  } as const;
  const admitted = (id: string) => {
    l.add('directive.accepted', {
      directiveId: id,
      targetExecutionId: 'work',
      text: 'Check sources.',
      origin: 'advice',
      delivery: 'next_request',
    });
    return l.add('advice.admitted', {
      ...advice,
      adviceId: `advice_${id}`,
      directiveId: id,
      delivery: 'next_request',
    });
  };
  const sentAdmission = admitted('sent');
  const delivered = l.add('directive.dispatched', {
    directiveId: 'sent',
    modelCallId: 'call',
    executionEpoch: 1,
  });
  const expiredAdmission = admitted('expired');
  const expired = l.add('directive.undelivered', {
    directiveId: 'expired',
    status: 'expired',
    reason: 'Target ended.',
  });
  const preserved = l.add('advice.admitted', {
    ...advice,
    adviceId: 'kept',
    delivery: 'preserve',
    note: 'Target already ended.',
  });
  admitted('queued');
  admitted('unknown');
  l.add('directive.undelivered', {
    directiveId: 'unknown',
    status: 'delivery_unknown',
    reason: 'Backend restarted.',
  });
  const late = (executionId: string, originalEventType: string, originalRef: string) =>
    l.add(
      'observation.late',
      { originalEventType, originalRef, whyIgnored: 'Scope ended.' },
      executionId,
    );
  const lateSeq = late('watcher', 'model.finished', 'closed_call');
  late('responder', 'reply', 'closed_question');
  late('responder', 'model.finished', 'responder_call');
  late('watcher', 'model.dispatch', 'not_dispatched');
  const lateEvent = l.events[lateSeq - 1];
  assert(lateEvent);
  const foreign = { ...lateEvent, runId: 'another_run' };
  expect(selectTeamRecord(l.p, d, [...l.events, foreign, lateEvent])?.observation).toEqual({
    delivered: 1,
    notDelivered: 2,
    late: 1,
    deliveredSeqs: [delivered],
    notDeliveredSeqs: [expired, preserved],
    lateSeqs: [lateSeq],
  });
  expect(selectTeamRecord(l.p, d, [])?.observation).toMatchObject({
    deliveredSeqs: [sentAdmission],
    notDeliveredSeqs: [expiredAdmission, preserved],
  });
  // No authored revision survived, but delivery and late events remain inspectable facts.
  expect(selectTeamRecord(l.p, null, l.events)).toMatchObject({
    questions: null,
    observation: { delivered: 1, notDelivered: 2, late: 1 },
  });
});

function reviewLog() {
  const l = log();
  const d = linearCorral(['writer']);
  const writer = d.nodes.find((n) => n.id === gate.sourceNodeId);
  const out = d.nodes.find((n) => n.type === 'output');
  assert(writer && out?.inputBindings[0]);
  writer.label = 'Report writer';
  out.inputBindings[0].bindingId = gate.bindingId;
  out.requiredReviews = [{ ...gate }];
  const start = (no: number) =>
    l.add('loop.iteration_started', {
      loopNodeId: 'loop',
      iterationId: `round_${no}`,
      no,
      pinnedCarryInputs: [],
      criteriaVersionId: 'criteria',
    });
  function round(no: number, verdict: 'pass' | 'revise', names = ['report']) {
    start(no);
    const writer = `writer_${no}`,
      reviewer = `reviewer_${no}`,
      iterationId = `round_${no}`;
    l.add('task.created', {
      taskId: `task_${writer}`,
      nodeId: 'writer',
      roleId: 'writer_role',
      contract: 'text',
      dependsOnTaskIds: [],
    });
    l.execution(writer, 'writer', iterationId);
    l.execution(reviewer, 'reviewer', iterationId);
    const refs: EventOf<'workflow.branch_selected'>['payload']['evidenceRefs'] = [];
    const ids: string[] = [];
    for (const name of names) {
      const id = `${name}_${no}`,
        review = `review_${id}`;
      const artifact = {
        name,
        version: no,
        parentVersionId: no === 1 ? null : `${name}_${no - 1}`,
        contentHash: 'a'.repeat(64),
        byteLength: 10,
        modelCallId: null,
        contextSnapshotId: null,
      };
      l.add('artifact.version_created', {
        ...artifact,
        artifactVersionId: id,
        artifactId: name,
        authorExecutionId: writer,
        contract: 'text',
      });
      l.add('artifact.version_created', {
        ...artifact,
        artifactVersionId: review,
        artifactId: `reviews_${name}`,
        authorExecutionId: reviewer,
        contract: 'review',
      });
      l.add('review.recorded', {
        reviewVersionId: review,
        targetVersionId: id,
        criteriaVersionId: 'criteria',
        issues: [],
        verdict,
      });
      refs.push({ kind: 'review', id: review }, { kind: 'artifact', id });
      ids.push(id);
    }
    l.add('task.submitted', { taskId: `task_${writer}`, artifactVersionIds: ids });
    l.add('task.completed', { taskId: `task_${writer}`, completionEvidence: 'Submitted' });
    l.add('workflow.branch_selected', {
      nodeId: 'decision',
      mode: 'review',
      iterationId,
      configRevision: 0,
      selectedPort: verdict,
      targetNodeId: 'loop',
      targetPort: verdict === 'pass' ? 'exit' : 'repeat',
      reasonCode: 'review_verdict',
      evidenceRefs: refs,
      executionRefs: [],
    });
    l.add('loop.iteration_finished', {
      loopNodeId: 'loop',
      iterationId,
      outcome: verdict,
      submittedVersionIds: ids,
    });
  }
  const finish = (...ids: string[]) => {
    l.add('output.finalized', { nodeId: out.id, artifactVersionIds: ids, approvalId: null });
    l.p.status = 'succeeded';
  };
  const record = () => {
    const result = selectTeamRecord(l.p, d, l.events);
    assert(result);
    return result;
  };
  const review = () => {
    const first = record().reviews[0];
    assert(first);
    return first;
  };
  return { l, d, out, start, round, finish, record, review };
}

describe('required reviews', () => {
  it('separates the passing decision from finalization and names the reviewed V2 and its actual author', () => {
    const { l, start, round, finish, review, record } = reviewLog();
    expect(record().questions).toBeNull();
    round(1, 'revise');
    round(2, 'pass');
    l.p.status = 'awaiting_user';
    expect(review()).toEqual({
      outputId: 'output',
      binding: 'final',
      bindingId: 'binding',
      loopId: 'loop',
      rounds: 2,
      round: { id: 'round_2', no: 2 },
      status: 'passed',
      submissions: [],
    });
    // The pass is linked to its evidence round, not simply the last entry in the iteration list.
    start(3);
    finish('report_2');
    expect(review()).toMatchObject({
      rounds: 3,
      round: { id: 'round_2', no: 2 },
      status: 'passed',
      submissions: [{ id: 'report_2', name: 'report', version: 2, author: 'Report writer' }],
    });
  });

  it('keeps gates and candidate versions independent, even with multiple results on one output', () => {
    const { out, round, finish, record } = reviewLog();
    out.inputBindings.push({
      kind: 'task_output',
      name: 'notes',
      sourceNodeId: 'researcher',
      bindingId: 'notes_binding',
    });
    assert(out.requiredReviews);
    out.requiredReviews.push({
      ...gate,
      bindingId: 'notes_binding',
      bindingName: 'notes',
      sourceNodeId: 'researcher',
      decisionNodeId: 'other_decision',
      loopNodeId: 'other_loop',
    });
    round(1, 'pass', ['report', 'appendix']);
    finish('report_1', 'appendix_1');
    expect(record().reviews).toMatchObject([
      {
        binding: 'final',
        status: 'passed',
        submissions: [{ id: 'report_1' }, { id: 'appendix_1' }],
      },
      { binding: 'notes', status: 'unrecorded', rounds: 0, round: null, submissions: [] },
    ]);
  });

  it.each([
    'stale',
    'criteria',
    'target',
    'decision',
    'round',
    'revise',
    'missing review',
    'wrong port',
    'source',
    'binding',
    'unreviewed final',
    'missing final candidate',
  ] as const)('does not report a passing submission from %s evidence', (bad) => {
    const { l, out, round, finish, review } = reviewLog();
    round(1, 'revise');
    round(2, 'pass', ['report', 'appendix']);
    finish('report_2', ...(bad === 'missing final candidate' ? [] : ['appendix_2']));
    const r = l.p.reviews.review_report_2;
    const branch = Object.values(l.p.workflowBranches ?? {}).at(-1);
    assert(r && branch);
    switch (bad) {
      case 'stale':
        r.stale = true;
        break;
      case 'criteria':
        l.p.currentCriteriaVersionId = 'new_criteria';
        break;
      case 'target':
        r.targetVersionId = 'report_1';
        break;
      case 'decision':
        branch.nodeId = 'other_decision';
        break;
      case 'round':
        assert(l.p.iterations.round_2);
        l.p.iterations.round_2.loopNodeId = 'other_loop';
        break;
      case 'revise':
        r.verdict = 'revise';
        break;
      case 'missing review':
        branch.evidenceRefs = branch.evidenceRefs.filter((ref) => ref.kind !== 'review');
        break;
      case 'wrong port':
        branch.selectedPort = 'revise';
        break;
      case 'source':
        assert(l.p.artifacts.report_2);
        l.p.artifacts.report_2.authorExecutionId = 'reviewer_2';
        break;
      case 'binding':
        assert(out.inputBindings[0]);
        out.inputBindings[0].bindingId = 'replaced_binding';
        break;
      case 'unreviewed final':
        assert(l.p.output);
        l.p.output.artifactVersionIds.push('report_1');
        break;
    }
    expect(review().status).toBe('unrecorded');
  });

  it('does not keep claiming a pass for the previous candidate while a changed submission waits', () => {
    const { l, round, review } = reviewLog();
    round(1, 'pass');
    assert(l.p.tasks.task_writer_1);
    l.p.tasks.task_writer_1.submittedArtifactVersionIds = ['another_version'];
    expect(review().status).not.toBe('passed');
    expect(review().submissions).toEqual([]);
  });

  it('reports waiting, actual progress, scoped exhaustion, cancellation and failure without a final submission', () => {
    const { l, round, start, review } = reviewLog();
    expect(review()).toMatchObject({ rounds: 0, round: null, status: 'waiting' });
    round(1, 'revise');
    start(2);
    expect(review()).toMatchObject({
      rounds: 2,
      round: { id: 'round_2', no: 2 },
      status: 'inProgress',
    });
    l.p.status = 'failed';
    l.p.statusReason = 'loop_exhausted: loop_other cap_reached';
    expect(review().status).toBe('failed');
    const second = l.p.iterations.round_2;
    assert(second);
    second.outcome = 'cap_reached';
    l.p.statusReason = 'loop_exhausted: loop cap_reached';
    expect(review()).toMatchObject({ rounds: 2, status: 'exhausted', submissions: [] });
    second.outcome = 'cancelled';
    l.p.status = 'cancelled';
    l.p.statusReason = 'final_output_rejected';
    expect(review()).toMatchObject({ status: 'cancelled', submissions: [] });
    l.p.status = 'failed';
    l.p.statusReason = 'execution_failed: reviewer';
    expect(review()).toMatchObject({ status: 'failed', submissions: [] });
  });
});
