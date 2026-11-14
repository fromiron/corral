import { emptyProjection, type RunProjection } from '@corral/core';
import { expect, it } from 'vitest';
import { conversationAction } from './selectors.ts';

// An advisor's own trouble is no attention of the conversation's (features/composer-flow.md "활동
// 바", features/advisor.md): its failure, its cancelled request and the usage that request never
// reported are said on its row. A role's trouble beside it is still said, and so is a failed run.

type Status = RunProjection['executions'][string]['status'];

function run(
  status: RunProjection['status'],
  executions: Record<string, { status: Status; advisor?: boolean }>,
) {
  const projection = emptyProjection('run_a');
  projection.status = status;
  projection.executionOrder = Object.keys(executions);
  for (const [id, item] of Object.entries(executions))
    projection.executions[id] = {
      executionId: id,
      nodeId: item.advisor ? 'reviewer' : 'writer',
      taskId: `task_${id}`,
      status: item.status,
      attemptNo: 1,
      modelCallIds: [],
      ...(item.advisor ? { advisor: true } : {}),
    } as unknown as RunProjection['executions'][string];
  return projection;
}

/** A model request of an execution, with its effect ended as `outcome`, its usage unreported. */
function request(
  projection: RunProjection,
  executionId: string,
  outcome: RunProjection['effects'][string]['outcome'],
) {
  const id = `call_${executionId}`;
  projection.effects[`effect_${id}`] = {
    effectId: `effect_${id}`,
    kind: 'model_request',
    scope: executionId,
    epoch: 1,
    dispatched: true,
    modelCallId: id,
    status: 'settled',
    outcome,
  };
  projection.modelCalls[id] = {
    modelCallId: id,
    executionId,
    finished: true,
    usage: null,
  } as unknown as RunProjection['modelCalls'][string];
}

const visible = (projection: RunProjection) =>
  conversationAction({ projection, approvals: 0, questions: 0 }).visible;

it('keeps a role’s unconfirmed result in view beside a failed advisor', () => {
  const projection = run('running', {
    exec_writer: { status: 'active' },
    exec_advisor: { status: 'failed', advisor: true },
  });
  request(projection, 'exec_advisor', 'failed');
  request(projection, 'exec_writer', 'unknown');
  const action = conversationAction({ projection, approvals: 0, questions: 0 });
  expect(action.visible).toBe(true);
  expect(action.unclearCauses).toEqual(['model', 'usage']);
});

it('raises nothing for an advisor that failed alone', () => {
  const projection = run('running', {
    exec_writer: { status: 'active' },
    exec_advisor: { status: 'failed', advisor: true },
  });
  request(projection, 'exec_advisor', 'failed');
  expect(visible(projection)).toBe(false);
});

it('raises nothing for an advisor’s cancelled request and the usage it never reported', () => {
  const projection = run('running', {
    exec_writer: { status: 'active' },
    exec_advisor: { status: 'cancelled', advisor: true },
  });
  request(projection, 'exec_advisor', 'unknown');
  expect(visible(projection)).toBe(false);
});

it('raises nothing after its last review was stopped: the run ended well without it', () => {
  const projection = run('succeeded', {
    exec_writer: { status: 'succeeded' },
    exec_advisor: { status: 'cancelled', advisor: true },
  });
  request(projection, 'exec_writer', 'succeeded');
  projection.modelCalls.call_exec_writer = {
    ...projection.modelCalls.call_exec_writer,
    usage: { outputTokens: 12 },
  } as unknown as RunProjection['modelCalls'][string];
  request(projection, 'exec_advisor', 'cancelled');
  expect(visible(projection)).toBe(false);
});

it('still says a failed run, whatever its advisor did', () => {
  const projection = run('failed', {
    exec_writer: { status: 'failed' },
    exec_advisor: { status: 'failed', advisor: true },
  });
  request(projection, 'exec_advisor', 'failed');
  expect(visible(projection)).toBe(true);
});
