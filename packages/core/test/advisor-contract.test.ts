import type { AgentAdapter, AgentSettlement, RunEvent } from '@corral/contracts';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { applyEvent, Coordinator, InMemoryRunStore } from '../src/index.ts';

// The advice contract is in place before its handling (docs/specs/features/advisor.md): until
// the command handling exists, advice is refused out loud.

describe('advice before its handling', () => {
  function setup() {
    const exits: ((value: AgentSettlement) => void)[] = [];
    const agents: AgentAdapter = {
      async start() {
        const settled = new Promise<AgentSettlement>((resolve) => exits.push(resolve));
        return { cancel: async () => {}, waitForSettlement: () => settled };
      },
    };
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents,
    });
    const started = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition: linearCorral(['writer']),
    });
    if (!started.runId) throw new Error('the run did not start');
    return { coordinator, store, runId: started.runId };
  }

  const advice = (runId: string, note = 'The cited figure is from 2019, not 2024.') => ({
    schemaVersion: '0.1' as const,
    commandId: 'advice_1',
    runId,
    type: 'submit_advice' as const,
    payload: {
      observerExecutionId: 'exec_advisor',
      attemptNo: 1,
      targetExecutionId: 'exec_writer',
      severity: 'concern' as const,
      note,
    },
  });

  it('refuses submit_advice as not supported, records nothing, and repeats the refusal', () => {
    const { coordinator, store, runId } = setup();
    const before = store.readEvents(runId, 0).length;
    const receipt = coordinator.submit(advice(runId));
    expect(receipt).toMatchObject({
      status: 'rejected',
      error: { code: 'COMMAND_NOT_SUPPORTED' },
    });
    expect(store.readEvents(runId, 0)).toHaveLength(before);
    expect(coordinator.submit(advice(runId))).toEqual(receipt);
    expect(coordinator.submit(advice(runId, 'Another note.')).error?.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('the projection passes over advice events', () => {
    const { coordinator, runId } = setup();
    const projection = coordinator.getSnapshot(runId).projection;
    const base = {
      schemaVersion: '0.1' as const,
      runId,
      recordedAt: '2026-11-13T00:00:00.000Z',
      actor: { kind: 'runtime' as const, id: 'coordinator' },
      causedByEventIds: [],
    };
    const events: RunEvent[] = [
      {
        ...base,
        eventId: 'evt_advice_1',
        runSeq: projection.lastSeq + 1,
        type: 'advice.admitted',
        payload: {
          adviceId: 'adv_1',
          observerExecutionId: 'exec_advisor',
          targetExecutionId: 'exec_writer',
          severity: 'concern',
          delivery: 'preserve',
        },
      },
      {
        ...base,
        eventId: 'evt_advice_2',
        runSeq: projection.lastSeq + 2,
        type: 'advice.suppressed',
        payload: {
          observerExecutionId: 'exec_advisor',
          targetExecutionId: 'exec_writer',
          severity: 'nit',
          reason: 'noise',
        },
      },
    ];
    let next = projection;
    for (const event of events) next = applyEvent(next, event);
    expect({ ...next, lastSeq: projection.lastSeq }).toEqual(projection);
  });
});
