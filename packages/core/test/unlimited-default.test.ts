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
  '[TC-LLM-005-H] new runs ignore legacy usage defaults with %i host model slots',
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
    const projection = await waitForProjection(
      new InProcessTransport(coordinator),
      result.runId!,
      (p) => ['succeeded', 'failed'].includes(p.status),
    );
    expect(projection.status).toBe('succeeded');
    expect(Object.keys(projection.modelCalls)).toHaveLength(105);
    expect(
      store
        .readEvents(result.runId!, 0)
        .filter((e) => e.type === 'extension.ui_notified' && e.payload.key === 'no_progress'),
    ).toHaveLength(1);
  },
);

it('[TC-LLM-005-N] an explicit live budget patch enables only the chosen limit', async () => {
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
