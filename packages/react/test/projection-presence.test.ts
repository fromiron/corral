import type { RunEvent } from '@corral/contracts';
import { type ExecutionView, emptyProjection, type RunProjection } from '@corral/core';
import { describe, expect, it } from 'vitest';
import {
  executionViewPresence,
  projectionPresence,
  statusPresence,
} from '../src/run/projectionPresence.ts';

// docs/specs/features/presence.md: a Run's presence from what the screen already holds.

const execution = (executionId: string, patch: Partial<ExecutionView> = {}): ExecutionView =>
  ({
    executionId,
    nodeId: 'writer',
    taskId: `task_${executionId}`,
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'active',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
    ...patch,
  }) as ExecutionView;

type Approval = RunProjection['approvals'][string];
const approval = (approvalId: string, patch: Partial<Approval> = {}): Approval =>
  ({
    approvalId,
    kind: 'user_action',
    subjectVersionIds: [],
    criteriaVersionId: null,
    status: 'pending',
    ...patch,
  }) as Approval;

function waiting(approvals: Approval[] = []): RunProjection {
  const projection = emptyProjection('run');
  projection.status = 'running';
  projection.executions.lead = execution('lead', { status: 'waiting_approval' });
  projection.executionOrder = ['lead'];
  for (const item of approvals) projection.approvals[item.approvalId] = item;
  return projection;
}

const asked = (runSeq: number, requestId = `question_${runSeq}`) =>
  ({
    type: 'user_input.requested',
    runSeq,
    payload: { executionId: 'lead', attemptNo: 1, requestId },
  }) as unknown as RunEvent;
const requested = (runSeq: number, approvalId: string) =>
  ({ type: 'approval.requested', runSeq, payload: { approvalId } }) as unknown as RunEvent;

describe('what the run waits for', () => {
  it('counts only open approvals', () => {
    const closed = waiting([approval('done', { status: 'approved', limit: undefined })]);
    closed.executions.lead = execution('lead');
    expect(projectionPresence(closed).kind).toBe('working');
    const open = waiting([approval('done', { status: 'approved' }), approval('open')]);
    expect(projectionPresence(open)).toMatchObject({ kind: 'awaiting_user', need: 'approval' });
  });

  it('asks whether to continue for a limit’s approval', () => {
    const limited = waiting([
      approval('limit', { limit: { kind: 'no_progress', used: 3, max: 3 } as never }),
    ]);
    expect(projectionPresence(limited).need).toBe('continue');
  });

  it('knows a question only from the events, and names it', () => {
    const projection = waiting();
    expect(projectionPresence(projection, [asked(4)])).toMatchObject({
      kind: 'awaiting_user',
      need: 'question',
    });
  });

  it('names the request that came first, whichever kind it is', () => {
    const projection = waiting([approval('later')]);
    expect(projectionPresence(projection, [asked(2), requested(5, 'later')]).need).toBe('question');
    expect(projectionPresence(projection, [requested(2, 'later'), asked(5)]).need).toBe('approval');
  });

  it('counts an approval once, however it is known', () => {
    const projection = waiting([approval('open')]);
    projection.executions.lead = execution('lead');
    // Approval-only: the need is approval, not a question for the same request.
    expect(projectionPresence(projection, [requested(3, 'open')]).need).toBe('approval');
  });
});

describe('a completed run’s loops', () => {
  type Outcome = RunProjection['iterations'][string]['outcome'];
  function looped(status: RunProjection['status'], loops: [string, Outcome[]][]) {
    const projection = emptyProjection('run');
    projection.status = status;
    for (const [loop, outcomes] of loops) {
      projection.loopIterations[loop] = outcomes.map((_, index) => `${loop}_${index + 1}`);
      outcomes.forEach((outcome, index) => {
        projection.iterations[`${loop}_${index + 1}`] = {
          iterationId: `${loop}_${index + 1}`,
          loopNodeId: loop,
          parentIterationId: null,
          no: index + 1,
          criteriaVersionId: 'criteria',
          outcome,
        };
      });
    }
    return projection;
  }

  it('says the loop ran out of rounds, by its last finished round', () => {
    expect(
      projectionPresence(looped('succeeded', [['review', ['revise', 'cap_reached']]])).detail,
    ).toBe('round_limit');
    expect(
      projectionPresence(looped('succeeded', [['review', ['revise', 'stalled']]])).detail,
    ).toBe('rounds_stalled');
    // A round still running does not hide the last one that finished.
    expect(
      projectionPresence(looped('succeeded', [['review', ['cap_reached', null]]])).detail,
    ).toBe('round_limit');
  });

  it('says nothing when an inner loop ran out earlier but passed last', () => {
    expect(
      projectionPresence(looped('succeeded', [['inner', ['cap_reached', 'revise', 'pass']]]))
        .detail,
    ).toBeUndefined();
  });

  it('takes the loop that started first when one ran out and a later one passed', () => {
    expect(
      projectionPresence(
        looped('succeeded', [
          ['draft', ['cap_reached']],
          ['review', ['pass']],
        ]),
      ).detail,
    ).toBe('round_limit');
  });

  it('says nothing for a run that failed', () => {
    expect(projectionPresence(looped('failed', [['review', ['cap_reached']]])).detail).toBe(
      undefined,
    );
  });
});

describe('an execution’s presence from its view', () => {
  it('watches when an advisor waits for a message, and waits for a reply otherwise', () => {
    expect(
      executionViewPresence(execution('a', { status: 'waiting_message', advisor: true })).detail,
    ).toBe('watching');
    expect(executionViewPresence(execution('b', { status: 'waiting_message' })).detail).toBe(
      'waiting_reply',
    );
  });

  it('reads a bare status of either kind, and nothing else', () => {
    expect(statusPresence('waiting_children')?.detail).toBe('waiting_agents');
    expect(statusPresence('validating')?.kind).toBe('starting');
    expect(statusPresence('in_progress')).toBeNull();
  });
});
