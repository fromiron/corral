import type { ExecutionView } from '@corral/core';
import { describe, expect, it } from 'vitest';
import {
  decisionRunStatus,
  nodeRunStatus,
  nodeRunSummary,
  observedRunRelations,
} from '../src/run/selectors.ts';
import { projectionWith, researchTeamDraft } from '../src/stories/fixtures.tsx';

function execution(id: string, change: Partial<ExecutionView> = {}): ExecutionView {
  return {
    executionId: id,
    nodeId: 'worker',
    taskId: 'task',
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'succeeded',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
    ...change,
  };
}

describe('current task attempts in node status', () => {
  it('a successful retry resolves its own earlier failure', () => {
    const p = projectionWith({
      executions: {
        first: execution('first', { status: 'failed' }),
        retry: execution('retry', { attemptNo: 2 }),
      },
      nodeExecutions: { worker: ['first', 'retry'] },
      executionOrder: ['first', 'retry'],
    });
    expect(nodeRunSummary(p, 'worker')).toEqual({
      status: 'done',
      counts: { done: 1 },
      previousFailures: 1,
    });
  });

  it('does not treat cancellation as failure', () => {
    const p = projectionWith({
      executions: { cancelled: execution('cancelled', { status: 'cancelled' }) },
      nodeExecutions: { worker: ['cancelled'] },
    });
    expect(nodeRunStatus(p, 'worker')).toBe('cancelled');
  });

  it.each([
    'waiting_children',
    'waiting_message',
    'waiting_approval',
    'queued',
    'ready',
    'pausing',
    'paused',
    'cancelling',
  ] as const)('preserves %s rather than claiming active work', (status) => {
    const p = projectionWith({
      executions: { e: execution('e', { status }) },
      nodeExecutions: { worker: ['e'] },
    });
    expect(nodeRunStatus(p, 'worker')).toBe(status);
  });

  it('unattributed approvals do not change approval Decision nodes', () => {
    const p = projectionWith({
      approvals: {
        a: {
          approvalId: 'a',
          kind: 'user_action',
          subjectVersionIds: ['criteria'],
          criteriaVersionId: 'criteria',
          status: 'pending',
        },
      },
    });
    for (const id of ['approval_a', 'approval_b']) {
      expect(decisionRunStatus(p, { id, type: 'decision', mode: 'approval' })).toEqual({
        status: 'idle',
        count: 0,
      });
    }
  });

  it('only the Output named by the recorded finalization is done', () => {
    const p = projectionWith({ output: { nodeId: 'actual', artifactVersionIds: ['draft'] } });
    expect(decisionRunStatus(p, { id: 'actual', type: 'output' })).toEqual({
      status: 'done',
      count: 0,
    });
    expect(decisionRunStatus(p, { id: 'other', type: 'output' })).toEqual({
      status: 'idle',
      count: 0,
    });
  });
});

describe('node activity and concurrent tasks', () => {
  it.each(['model', 'tool', 'finalizing'] as const)('names actual %s activity', (activity) => {
    const p = projectionWith({
      executions: { e: execution('e', { status: 'active', activity }) },
      nodeExecutions: { worker: ['e'] },
    });
    expect(nodeRunStatus(p, 'worker')).toBe(activity);
  });

  it('keeps unrelated failed and waiting tasks visible beside live work', () => {
    const p = projectionWith({
      executions: {
        live: execution('live', { taskId: 'live', status: 'active', activity: 'model' }),
        failed: execution('failed', { taskId: 'failed', status: 'failed' }),
        waiting: execution('waiting', { taskId: 'waiting', status: 'waiting_message' }),
      },
      nodeExecutions: { worker: ['live', 'failed', 'waiting'] },
    });
    expect(nodeRunSummary(p, 'worker')).toEqual({
      status: 'model',
      counts: { model: 1, failed: 1, waiting_message: 1 },
      previousFailures: 0,
    });
  });

  it('different waiting tasks do not claim active work', () => {
    const p = projectionWith({
      executions: {
        children: execution('children', { taskId: 'children', status: 'waiting_children' }),
        reply: execution('reply', { taskId: 'reply', status: 'waiting_message' }),
      },
      nodeExecutions: { worker: ['children', 'reply'] },
    });
    expect(nodeRunSummary(p, 'worker')).toEqual({
      status: 'mixed',
      counts: { waiting_children: 1, waiting_message: 1 },
      previousFailures: 0,
    });
  });

  it('a success in another task cannot resolve a failed task', () => {
    const p = projectionWith({
      executions: {
        a: execution('a', { status: 'failed' }),
        b: execution('b', { taskId: 'different' }),
      },
      nodeExecutions: { worker: ['a', 'b'] },
    });
    expect(nodeRunSummary(p, 'worker')).toEqual({
      status: 'failed',
      counts: { failed: 1, done: 1 },
      previousFailures: 0,
    });
  });

  it('uses a task’s assigned current attempt, not array position', () => {
    const p = projectionWith({
      executions: {
        assigned: execution('assigned', { status: 'waiting_children' }),
        next: execution('next', { attemptNo: 2, status: 'queued' }),
      },
      tasks: {
        task: {
          taskId: 'task',
          nodeId: 'worker',
          roleId: 'role',
          contract: 'text',
          status: 'in_progress',
          activeExecutionId: 'assigned',
          attemptCount: 1,
          submittedArtifactVersionIds: [],
        },
      },
      nodeExecutions: { worker: ['assigned', 'next'] },
    });
    expect(nodeRunStatus(p, 'worker')).toBe('waiting_children');
  });

  it('uses an approval only for its exact current execution and preserves cancelling', () => {
    const p = projectionWith({
      executions: { e: execution('e', { status: 'active', activity: 'tool' }) },
      nodeExecutions: { worker: ['e'] },
      approvals: {
        a: {
          approvalId: 'a',
          kind: 'user_action',
          subjectVersionIds: ['plan'],
          criteriaVersionId: null,
          status: 'pending',
          tool: {
            executionId: 'old',
            attemptNo: 1,
            toolCallId: 'tool',
            bodyRef: 'plan',
            fingerprint: '0'.repeat(64),
            deadline: '2026-10-26T00:00:00.000Z',
          },
        },
      },
    });
    expect(nodeRunStatus(p, 'worker')).toBe('tool');
    const approval = p.approvals.a?.tool;
    const current = p.executions.e;
    if (!approval || !current) throw new Error('missing fixture');
    approval.executionId = 'e';
    expect(nodeRunStatus(p, 'worker')).toBe('waiting_approval');
    current.status = 'cancelling';
    expect(nodeRunStatus(p, 'worker')).toBe('cancelling');
  });
});

describe('observed relationships', () => {
  const definition = researchTeamDraft().definition;
  const parent = execution('parent', { nodeId: 'research', taskId: 'parent', status: 'active' });
  const question = {
    questionId: 'question',
    taskId: 'response',
    senderExecutionId: 'parent',
    targetNodeId: 'respond',
    targetRoleId: 'responder',
    body: 'Question',
    artifactRefs: [],
    deadline: '2026-10-26T00:00:00.000Z',
    status: 'open' as const,
    answer: null,
  };

  it('counts delegated tasks once across retries and does not count question responders as delegation', () => {
    const p = projectionWith({
      executions: {
        parent,
        first: execution('first', {
          nodeId: 'helper',
          taskId: 'delegated',
          status: 'failed',
          parentExecutionId: 'parent',
        }),
        retry: execution('retry', {
          nodeId: 'helper',
          taskId: 'delegated',
          attemptNo: 2,
          status: 'active',
          parentExecutionId: 'parent',
        }),
        response: execution('response', {
          nodeId: 'respond',
          taskId: 'response',
          status: 'active',
          parentExecutionId: 'parent',
        }),
      },
      executionOrder: ['parent', 'first', 'retry', 'response'],
      questions: { question },
    });
    expect(observedRunRelations(p, definition)).toEqual([
      {
        kind: 'delegate',
        source: 'research',
        target: 'helper',
        targetHandle: 'callable',
        count: 1,
        activeCount: 1,
      },
      {
        kind: 'question',
        source: 'research',
        target: 'respond',
        targetHandle: 'callable',
        count: 1,
        activeCount: 1,
      },
    ]);
  });

  it('parent delivery targets the scheduled parent’s real in handle', () => {
    const p = projectionWith({
      executions: {
        parent,
        child: execution('child', {
          nodeId: 'helper',
          taskId: 'child',
          parentExecutionId: 'parent',
        }),
      },
      executionOrder: ['parent', 'child'],
      questions: {
        q: {
          ...question,
          delivery: 'parent',
          senderExecutionId: 'child',
          targetNodeId: 'research',
          taskId: 'parent',
          targetExecutionId: 'parent',
        },
      },
    });
    expect(observedRunRelations(p, definition)).toContainEqual({
      kind: 'question',
      source: 'helper',
      target: 'research',
      targetHandle: 'in',
      count: 1,
      activeCount: 1,
    });
  });

  it('ignores missing nodes and never infers calls from static capability links', () => {
    expect(observedRunRelations(projectionWith({}), definition)).toEqual([]);
    const p = projectionWith({
      executions: {
        parent,
        missing: execution('missing', { nodeId: 'removed', parentExecutionId: 'parent' }),
      },
      executionOrder: ['parent', 'missing'],
      questions: { q: { ...question, targetNodeId: 'removed' } },
    });
    expect(observedRunRelations(p, definition)).toEqual([]);
  });
});
