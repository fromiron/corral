import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

it.each([1, 3, 6])(
  'new runs ignore legacy usage defaults with %i host model slots',
  async (maxModelConcurrency) => {
    const definition = linearCorral(['writer']);
    definition.limits = {
      ...definition.limits,
      maxModelCalls: 1,
      maxOutputTokens: 1,
      maxModelConcurrency: 6,
    };
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 105 }),
      policy: { ...SPEC_HARD_CAPS, maxModelConcurrency },
    });
    const result = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition,
    });
    expect(result.runId).not.toBeNull();
    // Legacy call and token limits do not stop it; six replies without progress pause it.
    const projection = await waitForProjection(
      new InProcessTransport(coordinator),
      result.runId!,
      (p) => ['succeeded', 'failed', 'awaiting_user'].includes(p.status),
    );
    expect(projection.status).toBe('awaiting_user');
    expect(projection.usageLimits).toBe('none');
    expect(Object.keys(projection.modelCalls)).toHaveLength(6);
    const events = store.readEvents(result.runId!, 0);
    expect(
      events.filter((e) => e.type === 'extension.ui_notified' && e.payload.key === 'no_progress'),
    ).toHaveLength(1);
    expect(
      events.some((e) => e.type === 'limit.reached' && e.payload.limitKind === 'no_progress'),
    ).toBe(true);
  },
);

it('an unlimited run continues past the no-progress pause only on approval', async () => {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 8 }),
  });
  const transport = new InProcessTransport(coordinator);
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_no_progress',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  const paused = await waitForProjection(transport, started.runId!, (p) =>
    ['awaiting_user', 'succeeded', 'failed'].includes(p.status),
  );
  expect(paused.status).toBe('awaiting_user');
  const approval = Object.values(paused.approvals).find((a) => a.status === 'pending');
  if (!approval) throw new Error('no-progress approval not created');
  const receipt = await coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'continue_no_progress',
    runId: started.runId!,
    type: 'resolve_approval',
    expectedControlRevision: paused.controlRevision,
    payload: {
      approvalId: approval.approvalId,
      decision: 'approve',
      subjectVersionId: approval.subjectVersionIds[0] ?? '',
    },
  });
  expect(receipt.status).toBe('applied');
  const final = await waitForProjection(transport, started.runId!, (p) =>
    ['succeeded', 'failed'].includes(p.status),
  );
  expect(final.status).toBe('succeeded');
  expect(Object.keys(final.modelCalls)).toHaveLength(8);
});

it('an explicit live budget patch enables only the chosen limit', async () => {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 5 }),
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_budget_patch',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  const receipt = await coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'budget_patch',
    runId: started.runId!,
    type: 'patch',
    expectedControlRevision: 0,
    payload: { kind: 'run_limits', changes: { maxModelCalls: 2 } },
  });
  expect(receipt.status).toBe('applied');
  const projection = await waitForProjection(
    new InProcessTransport(coordinator),
    started.runId!,
    (p) => ['succeeded', 'failed'].includes(p.status),
  );
  expect(projection.usageLimits).toBeUndefined();
  expect(projection.budget.modelCalls).toBe(2);
  expect(projection.limits?.maxOutputTokens).toBe(Number.MAX_SAFE_INTEGER);
});
