import { Coordinator, emptyProjection } from '@corral/core';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { actionCopy, actionRequired, effectAttention } from './selectors.ts';

it('confirmed user cancellation is not an unresolved external effect', async () => {
  const entered = new Gate();
  const stopped = new Gate();
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: {
      start: async () => {
        entered.open();
        return {
          cancel: async () => stopped.open(),
          waitForSettlement: async () => {
            await stopped.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const start = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  if (!start.runId) throw new Error('run did not start');
  const runId = start.runId;
  await entered.wait();
  const cancel = coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'stop',
    type: 'cancel',
    runId: start.runId,
    payload: { scope: { kind: 'run' }, reason: 'User cancelled before external work' },
  });
  expect(cancel.status).not.toBe('rejected');
  await vi.waitFor(() =>
    expect(coordinator.getSnapshot(runId).projection.status).toBe('cancelled'),
  );
  const projection = coordinator.getSnapshot(start.runId).projection;
  expect(Object.values(projection.effects).some((effect) => effect.outcome === 'cancelled')).toBe(
    true,
  );
  expect(projection.budget.unknownOutstanding).toBe(0);
  expect(
    actionRequired({
      pendingApprovals: 0,
      pendingQuestions: 0,
      runStatus: projection.status,
      ...effectAttention(projection),
    }),
  ).toMatchObject({ visible: false, count: 0, hasFailure: false });
});

it('cancellation does not hide unknown billing, real failure or unconfirmed termination', () => {
  const projection = emptyProjection('run_cancelled');
  projection.status = 'cancelled';
  projection.budget.imageUnknownOutstandingMicros = 125000;
  expect(effectAttention(projection).unclearEffects).toBe(1);
  projection.budget.imageUnknownOutstandingMicros = 0;
  projection.budget.unknownOutstanding = 100;
  expect(effectAttention(projection).unclearEffects).toBe(1);
  projection.budget.unknownOutstanding = 0;
  projection.statusReason = 'service_termination_unconfirmed';
  expect(effectAttention(projection).unclearEffects).toBe(1);
  projection.statusReason = null;
  projection.effects.failed = {
    effectId: 'failed',
    kind: 'tool',
    scope: 'exec_one',
    epoch: 0,
    dispatched: true,
    reservationId: null,
    status: 'settled',
    outcome: 'failed',
  };
  expect(effectAttention(projection).failedEffects).toBe(1);
});

it('the attention banner names why an outcome is unclear', () => {
  const projection = emptyProjection('run_unclear');
  projection.status = 'succeeded';
  const copy = () =>
    actionCopy(
      actionRequired({
        pendingApprovals: 0,
        pendingQuestions: 0,
        runStatus: projection.status,
        ...effectAttention(projection),
      }),
    );
  // A finished turn whose routing usage was never reported: usage, not a file effect.
  projection.budget.unknownOutstanding = 256;
  expect(copy()).toEqual(['actionUsageUnknown']);
  projection.budget.unknownOutstanding = 0;
  projection.budget.imageUnknownOutstandingMicros = 125000;
  expect(copy()).toEqual(['actionUsageUnknown']);
  projection.budget.imageUnknownOutstandingMicros = 0;
  projection.statusReason = 'service_termination_unconfirmed';
  expect(copy()).toEqual(['actionStopUnconfirmed']);
  projection.statusReason = null;
  projection.effects.write = {
    effectId: 'write',
    kind: 'tool',
    scope: 'exec_one',
    epoch: 0,
    dispatched: true,
    reservationId: null,
    status: 'settled',
    outcome: 'unknown',
  };
  expect(copy()).toEqual(['actionUnclear']);
  // Several causes are each named; nothing unclear shows nothing.
  projection.budget.unknownOutstanding = 256;
  expect(copy()).toEqual(['actionUnclear', 'actionUsageUnknown']);
  delete projection.effects.write;
  projection.budget.unknownOutstanding = 0;
  expect(copy()).toEqual([]);
});
