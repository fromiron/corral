import { RunEvent } from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, InMemoryRunStore, type RunProjection, type StoredRun } from '../src/index.ts';
import ultraRuns from './fixtures/ultra-runs.json' with { type: 'json' };

// Ultra is removed and its records are no longer read. These runs were written by the
// Ultra code before its removal (a version 2 tournament that applied its winner, and a version 1
// comparison waiting for a person's choice), with the projections the old reducer saved. A store
// holding them must still start.
type Recorded = {
  status: string;
  snapshot: StoredRun['snapshot'];
  projection: RunProjection;
  events: RunEvent[];
};
const recorded = ultraRuns as unknown as { tournament: Recorded; comparison: Recorded };
const runIdOf = (record: Recorded) => record.events[0]!.runId;

function seeded() {
  const store = new InMemoryRunStore();
  for (const record of [recorded.tournament, recorded.comparison]) {
    // As the old code left them: the projection it saved, and the raw events.
    store.insertRun({
      runId: runIdOf(record),
      snapshot: record.snapshot,
      projection: record.projection,
      sessionId: 'session',
    });
    store.appendEvents(runIdOf(record), record.events);
  }
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  return { store, coordinator };
}

describe('stored Ultra records', () => {
  it('a store with Ultra runs starts; the unfinished one is interrupted', () => {
    // The event schema no longer reads them, so clients are never sent these runs.
    for (const record of [recorded.tournament, recorded.comparison])
      expect(record.events.some((event) => !RunEvent.safeParse(event).success)).toBe(true);
    const { coordinator, store } = seeded();
    expect(coordinator.findSnapshot(runIdOf(recorded.tournament))?.projection.status).toBe(
      'succeeded',
    );
    const comparison = runIdOf(recorded.comparison);
    expect(coordinator.findSnapshot(comparison)?.projection.status).toBe('interrupted');
    const added = store.readEvents(comparison, recorded.comparison.events.length);
    expect(added.map((event) => event.type)).toEqual(['run.interrupted', 'run.state_changed']);
    for (const event of added) expect(RunEvent.safeParse(event).success).toBe(true);
  });

  it('no command or start path accepts Ultra any more', () => {
    const { coordinator, store } = seeded();
    const runId = runIdOf(recorded.comparison);
    const before = store.readEvents(runId, 0).length;
    for (const [type, payload] of [
      ['select_candidate', { candidateId: 'candidate_1', tree: 'a'.repeat(40) }],
      ['cancel_candidate', { candidateId: 'candidate_1' }],
    ] as const) {
      const receipt = coordinator.submit({
        schemaVersion: '0.1',
        commandId: `${type}_1`,
        runId,
        type,
        payload,
      } as never);
      expect(receipt.error?.code).toBe('SCHEMA_INVALID');
    }
    expect(store.readEvents(runId, 0)).toHaveLength(before);
    const snapshot = recorded.tournament.snapshot;
    const started = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'ultra_again',
      definition: snapshot.definition,
      mode: 'mock',
      autoRoute: snapshot.autoRoute,
    } as never);
    expect(started.runId).toBeNull();
    expect(started.receipt.error?.code).toBe('SCHEMA_INVALID');
  });

  it('repeating the whole request of an Ultra run is refused', () => {
    const { coordinator } = seeded();
    expect(() =>
      coordinator.branchPreview({
        sourceRunId: runIdOf(recorded.tournament),
        requestStart: true,
      }),
    ).toThrow(/Ultra/);
  });
});
