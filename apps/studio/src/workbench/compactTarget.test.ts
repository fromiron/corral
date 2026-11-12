import { emptyProjection } from '@corral/core';
import { expect, it } from 'vitest';
import { compactTarget } from './compactTarget.ts';

function running(mode: 'live' | 'mock' = 'live') {
  const projection = emptyProjection('run_compact');
  projection.mode = mode;
  projection.status = 'running';
  projection.controlRevision = 4;
  projection.executionOrder = ['exec_writer'];
  projection.executions.exec_writer = {
    executionId: 'exec_writer',
    nodeId: 'writer',
    taskId: 'task_writer',
    attemptNo: 2,
    status: 'active',
  } as never;
  return projection;
}

it('accepts the current attempt of the one live execution', () => {
  expect(compactTarget(running(), null)).toEqual({
    ok: true,
    executionId: 'exec_writer',
    attemptNo: 2,
    expectedControlRevision: 4,
    pending: false,
  });
});

it('refuses a finished execution and a simulated run', () => {
  const finished = running();
  finished.status = 'succeeded';
  const writer = finished.executions.exec_writer;
  if (!writer) throw new Error('missing execution');
  writer.status = 'succeeded';
  expect(compactTarget(finished, 'exec_writer')).toEqual({
    ok: false,
    reason: 'compactNoExecution',
  });
  const simulated = running('mock');
  expect(compactTarget(simulated, 'exec_writer')).toEqual({ ok: false, reason: 'compactNotLive' });
});

it('refuses a cancelling run and several unnamed executions', () => {
  const cancelling = running();
  cancelling.status = 'cancelling';
  expect(compactTarget(cancelling, 'exec_writer')).toEqual({
    ok: false,
    reason: 'compactCancelling',
  });
  const many = running();
  many.executionOrder = ['exec_writer', 'exec_reviewer'];
  many.executions.exec_reviewer = {
    executionId: 'exec_reviewer',
    nodeId: 'reviewer',
    taskId: 'task_reviewer',
    attemptNo: 1,
    status: 'active',
  } as never;
  expect(compactTarget(many, null)).toEqual({ ok: false, reason: 'compactAmbiguous' });
  expect(compactTarget(many, 'exec_reviewer')).toMatchObject({
    ok: true,
    executionId: 'exec_reviewer',
    attemptNo: 1,
  });
});

it('marks a compaction that is already queued so another command is not sent', () => {
  const projection = running();
  projection.compactions = {
    compact_1: {
      commandId: 'compact_1',
      executionId: 'exec_writer',
      attemptNo: 2,
      phase: 'queued',
      modelCallIds: [],
    },
  };
  expect(compactTarget(projection, 'exec_writer')).toMatchObject({ ok: true, pending: true });
});
