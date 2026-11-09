import { Coordinator, emptyProjection, usageTotals } from '@corral/core';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { actionCopy, actionRequired, effectAttention } from './selectors.ts';

const unreported = { inputTokens: null, outputTokens: null, costMicros: null };
const imageWithoutCost = {
  usageId: 'image',
  kind: 'image',
  profileId: 'images',
  ...unreported,
} as const;
const routeWithoutUsage = {
  usageId: 'route',
  kind: 'auto_route',
  profileId: null,
  ...unreported,
} as const;
const callWithoutUsage = {
  modelCallId: 'call',
  executionId: 'exec_one',
  finished: true,
  usage: null,
} as never;

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
  expect(usageTotals(projection).unknown).toBe(0);
  expect(
    actionRequired({
      pendingApprovals: 0,
      pendingQuestions: 0,
      runStatus: projection.status,
      ...effectAttention(projection),
    }),
  ).toMatchObject({ visible: false, count: 0, hasFailure: false });
});

it('cancellation does not hide unreported usage, real failure or unconfirmed termination', () => {
  const projection = emptyProjection('run_cancelled');
  projection.status = 'cancelled';
  projection.usage.image = imageWithoutCost;
  expect(effectAttention(projection).unclearEffects).toBe(1);
  delete projection.usage.image;
  projection.modelCalls.call = callWithoutUsage;
  expect(effectAttention(projection).unclearEffects).toBe(1);
  delete projection.modelCalls.call;
  projection.statusReason = 'service_termination_unconfirmed';
  expect(effectAttention(projection).unclearEffects).toBe(1);
  projection.statusReason = null;
  projection.effects.failed = {
    effectId: 'failed',
    kind: 'tool',
    scope: 'exec_one',
    epoch: 0,
    dispatched: true,
    modelCallId: null,
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
  projection.usage.route = routeWithoutUsage;
  expect(copy()).toEqual(['actionUsageUnknown']);
  delete projection.usage.route;
  projection.usage.image = imageWithoutCost;
  expect(copy()).toEqual(['actionUsageUnknown']);
  delete projection.usage.image;
  projection.statusReason = 'service_termination_unconfirmed';
  expect(copy()).toEqual(['actionStopUnconfirmed']);
  projection.statusReason = null;
  projection.effects.write = {
    effectId: 'write',
    kind: 'tool',
    scope: 'exec_one',
    epoch: 0,
    dispatched: true,
    modelCallId: null,
    status: 'settled',
    outcome: 'unknown',
  };
  expect(copy()).toEqual(['actionUnclear']);
  // Several causes are each named; nothing unclear shows nothing.
  projection.usage.route = routeWithoutUsage;
  expect(copy()).toEqual(['actionUnclear', 'actionUsageUnknown']);
  delete projection.effects.write;
  delete projection.usage.route;
  expect(copy()).toEqual([]);
});

it('a cancelled model request is not presented as an unconfirmed file operation', () => {
  const projection = emptyProjection('run_cancelled_model');
  projection.status = 'cancelled';
  projection.effects.model = {
    effectId: 'model',
    kind: 'model_request',
    scope: 'exec_one',
    epoch: 0,
    dispatched: true,
    modelCallId: null,
    status: 'settled',
    outcome: 'unknown',
  };
  const copy = () =>
    actionCopy(
      actionRequired({
        pendingApprovals: 0,
        pendingQuestions: 0,
        runStatus: projection.status,
        ...effectAttention(projection),
      }),
    );
  expect(copy()).toEqual(['actionModelUnknown']);
  projection.effects.tool = { ...projection.effects.model, effectId: 'tool', kind: 'tool' };
  expect(copy()).toEqual(['actionUnclear', 'actionModelUnknown']);
  projection.effects.model.outcome = 'cancelled';
  expect(copy()).toEqual(['actionUnclear']);
});
