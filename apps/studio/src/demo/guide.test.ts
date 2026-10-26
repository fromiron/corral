import type { ExecutionStatus, RunStatus } from '@corral/contracts';
import { emptyProjection, type RunProjection } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { guideSteps } from './guide.ts';

type Exec = { id: string; node: string; status?: ExecutionStatus; parent?: string; round?: number };

function projection(status: RunStatus, executions: Exec[], extra: Partial<RunProjection> = {}) {
  const p = emptyProjection('run_0001');
  p.status = status;
  for (const e of executions) {
    const iterationId = e.round ? `iter_${e.round}` : null;
    if (iterationId) {
      p.iterations[iterationId] = {
        iterationId,
        loopNodeId: 'review_loop',
        no: e.round ?? 1,
        criteriaVersionId: 'crit_0001',
        outcome: null,
      };
    }
    p.executions[e.id] = {
      executionId: e.id,
      nodeId: e.node,
      taskId: `task_${e.id}`,
      attemptNo: 1,
      parentExecutionId: e.parent ?? null,
      previousExecutionId: null,
      depth: e.parent ? 1 : 0,
      iterationId,
      modelProfile: 'model-a',
      configRevision: 0,
      criteriaVersionId: null,
      status: e.status ?? 'active',
      activity: null,
      waitingOn: null,
      modelCallIds: [],
      error: null,
    };
    p.executionOrder.push(e.id);
  }
  return Object.assign(p, extra);
}

const states = (p: RunProjection | null) =>
  Object.fromEntries(guideSteps(p).map((s) => [s.id, s.state]));

const team: Exec[] = [
  { id: 'r', node: 'research', status: 'succeeded' },
  { id: 'h1', node: 'helper', parent: 'r', status: 'succeeded' },
  { id: 'h2', node: 'helper', parent: 'r', status: 'succeeded' },
  { id: 'w1', node: 'write', round: 1, status: 'succeeded' },
  { id: 'q1', node: 'respond', parent: 'w1', status: 'succeeded' },
];

describe('demo guide', () => {
  it('starts with the run and follows committed facts in order', () => {
    expect(states(null)).toEqual({
      start: 'current',
      delegate: 'pending',
      ask: 'pending',
      revise: 'pending',
      steer: 'pending',
      finish: 'pending',
    });
    expect(states(projection('running', team.slice(0, 1)))).toMatchObject({
      start: 'done',
      delegate: 'current',
    });
    expect(states(projection('running', team))).toMatchObject({
      delegate: 'done',
      ask: 'done',
      revise: 'current',
    });
  });

  it('offers the running round 2 Writer as the steer target until an instruction is delivered', () => {
    const p = projection('running', [...team, { id: 'w2', node: 'write', round: 2 }]);
    const steer = guideSteps(p).find((s) => s.id === 'steer');
    expect(steer).toMatchObject({ state: 'current', steerTarget: 'w2' });
    p.directives.d1 = {
      directiveId: 'd1',
      targetExecutionId: 'w2',
      text: 'Lead with cost.',
      status: 'delivered',
      commandId: null,
      acceptedSeq: 1,
      contextSnapshotId: null,
      modelCallId: null,
      reason: null,
    };
    expect(states(p)).toMatchObject({ revise: 'done', steer: 'done', finish: 'current' });
  });

  it('an instruction that was only accepted, or went to round 1, does not complete the steer step', () => {
    const p = projection('running', [...team, { id: 'w2', node: 'write', round: 2 }]);
    p.directives.d1 = {
      directiveId: 'd1',
      targetExecutionId: 'w2',
      text: 'Lead with cost.',
      status: 'queued',
      commandId: null,
      acceptedSeq: 1,
      contextSnapshotId: null,
      modelCallId: null,
      reason: null,
    };
    p.directives.d2 = {
      ...p.directives.d1,
      directiveId: 'd2',
      targetExecutionId: 'w1',
      status: 'delivered',
    };
    expect(states(p).steer).toBe('current');
  });

  it('skipping the optional steer does not block the finish step', () => {
    const p = projection('awaiting_user', [
      ...team,
      { id: 'w2', node: 'write', round: 2, status: 'succeeded' },
    ]);
    expect(states(p)).toMatchObject({ steer: 'missed', finish: 'current' });
  });

  it('a run that ends without success marks every unfinished step missed', () => {
    for (const status of ['cancelled', 'failed', 'interrupted'] as const) {
      expect(states(projection(status, team.slice(0, 1)))).toEqual({
        start: 'done',
        delegate: 'missed',
        ask: 'missed',
        revise: 'missed',
        steer: 'missed',
        finish: 'missed',
      });
    }
  });

  it('one helper is not yet a delegation to two', () => {
    expect(states(projection('running', team.slice(0, 2))).delegate).toBe('current');
  });
});
