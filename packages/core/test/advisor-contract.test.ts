import { type AgentAdapter, type AgentSettlement, RunEvent } from '@corral/contracts';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { applyEvent, Coordinator, InMemoryRunStore } from '../src/index.ts';

// The advice contract (docs/specs/features/advisor.md, 계약; api-contract.md, the event table).

describe('the advice contract', () => {
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

  it('refuses submit_advice from outside an advisor, records nothing and keeps no refusal', () => {
    const { coordinator, store, runId } = setup();
    const before = store.readEvents(runId, 0).length;
    const receipt = coordinator.submit(advice(runId));
    expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'CAPABILITY_DENIED' } });
    expect(store.readEvents(runId, 0)).toHaveLength(before);
    // Not stored: the command id stays free for an advisor's own advice.
    expect(store.getCommand(runId, 'advice_1')).toBeNull();
    expect(coordinator.submit(advice(runId, 'Another note.')).error?.code).toBe(
      'CAPABILITY_DENIED',
    );
  });

  const base = (runId: string) => ({
    schemaVersion: '0.1' as const,
    runId,
    recordedAt: '2026-11-13T00:00:00.000Z',
    actor: { kind: 'runtime' as const, id: 'coordinator' },
    causedByEventIds: [],
  });

  it('a preserved advice carries its note, and only a preserved one does', () => {
    const at = { ...base('run_1'), eventId: 'evt_1', runSeq: 1, type: 'advice.admitted' as const };
    const fields = {
      adviceId: 'adv_1',
      observerExecutionId: 'exec_advisor',
      targetExecutionId: 'exec_writer',
      severity: 'concern' as const,
    };
    const parse = (payload: Record<string, unknown>) =>
      RunEvent.safeParse({ ...at, payload: { ...fields, ...payload } }).success;
    expect(parse({ delivery: 'preserve', note: 'Check the 2019 figure.' })).toBe(true);
    expect(parse({ delivery: 'preserve' })).toBe(false);
    expect(parse({ delivery: 'preserve', note: 'x', directiveId: 'dir_1' })).toBe(false);
    expect(parse({ delivery: 'next_request', directiveId: 'dir_1' })).toBe(true);
    expect(parse({ delivery: 'interrupt' })).toBe(false);
    expect(parse({ delivery: 'next_request', directiveId: 'dir_1', note: 'x' })).toBe(false);
  });

  it('the projection keeps admitted advice and the reason of dropped advice, not its text', () => {
    const { coordinator, runId } = setup();
    const projection = coordinator.getSnapshot(runId).projection;
    const events: RunEvent[] = [
      {
        ...base(runId),
        eventId: 'evt_advice_1',
        runSeq: projection.lastSeq + 1,
        type: 'advice.admitted',
        payload: {
          adviceId: 'adv_1',
          observerExecutionId: 'exec_advisor',
          targetExecutionId: 'exec_writer',
          severity: 'concern',
          delivery: 'preserve',
          note: 'Check the 2019 figure.',
        },
      },
      {
        ...base(runId),
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
    expect(next.advice?.adv_1).toMatchObject({
      delivery: 'preserve',
      directiveId: null,
      note: 'Check the 2019 figure.',
    });
    expect(next.suppressedAdvice).toEqual([
      {
        observerExecutionId: 'exec_advisor',
        targetExecutionId: 'exec_writer',
        severity: 'nit',
        reason: 'noise',
        runSeq: projection.lastSeq + 2,
      },
    ]);
  });
});
