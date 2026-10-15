import { type RunEvent, RunEvent as RunEventSchema } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { definitionHash } from '../definition-hash.ts';
import { applyEvent, emptyProjection, type RunProjection } from '../projection.ts';
import type { RunStore, StoredRun } from '../store/run-store.ts';

/**
 * Behaviour every RunStore must share (C-011). The in-memory store and the SQLite store run
 * the same cases, so the coordinator's commit path means the same thing in both.
 */
export function describeRunStoreContract(name: string, makeStore: () => RunStore) {
  const definition = linearCorral(['writer'], 'store');

  function newRun(runId = 'run_store_1'): StoredRun {
    return {
      runId,
      snapshot: {
        definition,
        definitionHash: definitionHash(definition),
        source: null,
        criteriaVersionId: 'crit_0001',
        mode: 'mock',
        startedAt: '2026-10-15T00:00:00.000Z',
      },
      projection: emptyProjection(runId),
    };
  }

  function stateEvent(runId: string, runSeq: number, to: 'validating' | 'running'): RunEvent {
    return RunEventSchema.parse({
      schemaVersion: '0.1',
      eventId: `evt_${runId}_${runSeq}`,
      runId,
      runSeq,
      recordedAt: '2026-10-15T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'coordinator' },
      causedByEventIds: [],
      type: 'run.state_changed',
      payload: { from: runSeq === 1 ? 'created' : 'validating', to, reasonCode: 'test' },
    });
  }

  const project = (runId: string, events: RunEvent[]): RunProjection =>
    events.reduce(applyEvent, emptyProjection(runId));

  describe(`RunStore contract: ${name}`, () => {
    it('[TC-RACE-09] keeps nothing from a transaction that throws', () => {
      const store = makeStore();
      const run = newRun();
      const first = [stateEvent(run.runId, 1, 'validating')];
      store.transaction(() => {
        store.insertRun(run);
        store.appendEvents(run.runId, first);
        store.saveProjection(run.runId, project(run.runId, first));
      });

      expect(() =>
        store.transaction(() => {
          const next = [stateEvent(run.runId, 2, 'running')];
          store.appendEvents(run.runId, next);
          store.putArtifactText(run.runId, 'artv_1', 'body');
          store.putCommand({
            scope: run.runId,
            commandId: 'cmd_1',
            payloadHash: 'h',
            receipt: {
              commandId: 'cmd_1',
              runId: run.runId,
              status: 'applied',
              acceptedSeq: 2,
              target: `run:${run.runId}`,
              requestedBoundary: 'immediate',
              relatedEventIds: [],
            },
            runId: run.runId,
            directiveId: null,
          });
          throw new Error('projection update failed');
        }),
      ).toThrow('projection update failed');

      expect(store.readEvents(run.runId, 0).map((e) => e.runSeq)).toEqual([1]);
      expect(store.getArtifactText(run.runId, 'artv_1')).toBeNull();
      expect(store.getCommand(run.runId, 'cmd_1')).toBeNull();
      expect(store.getRun(run.runId)?.projection.status).toBe('validating');
    });

    it('rolls back a run that was inserted in the failed transaction', () => {
      const store = makeStore();
      expect(() =>
        store.transaction(() => {
          store.insertRun(newRun('run_gone'));
          throw new Error('stop');
        }),
      ).toThrow('stop');
      expect(store.getRun('run_gone')).toBeNull();
      expect(store.listRuns()).toEqual([]);
    });

    it('refuses an event that is not the next sequence number', () => {
      const store = makeStore();
      const run = newRun();
      store.transaction(() => store.insertRun(run));
      expect(() =>
        store.transaction(() =>
          store.appendEvents(run.runId, [stateEvent(run.runId, 2, 'running')]),
        ),
      ).toThrow();
      store.transaction(() =>
        store.appendEvents(run.runId, [stateEvent(run.runId, 1, 'validating')]),
      );
      expect(() =>
        store.transaction(() =>
          store.appendEvents(run.runId, [stateEvent(run.runId, 1, 'validating')]),
        ),
      ).toThrow();
      expect(store.readEvents(run.runId, 0)).toHaveLength(1);
    });

    it('records a command id once per scope and lists the newest run first', () => {
      const store = makeStore();
      const older = newRun('run_store_1');
      const newer = newRun('run_store_2');
      newer.snapshot = { ...newer.snapshot, startedAt: '2026-10-15T00:00:01.000Z' };
      const command = {
        scope: older.runId,
        commandId: 'cmd_1',
        payloadHash: 'h',
        receipt: {
          commandId: 'cmd_1',
          runId: older.runId,
          status: 'applied' as const,
          acceptedSeq: null,
          target: `run:${older.runId}`,
          requestedBoundary: 'immediate' as const,
          relatedEventIds: [],
        },
        runId: older.runId,
        directiveId: null,
      };
      store.transaction(() => {
        store.insertRun(older);
        store.insertRun(newer);
        store.putCommand(command);
      });
      expect(() => store.transaction(() => store.putCommand(command))).toThrow();
      expect(store.listRuns().map((r) => r.runId)).toEqual([newer.runId, older.runId]);
    });

    it('keeps artifact bodies immutable', () => {
      const store = makeStore();
      const run = newRun();
      store.transaction(() => {
        store.insertRun(run);
        store.putArtifactText(run.runId, 'artv_1', 'first');
      });
      expect(() =>
        store.transaction(() => store.putArtifactText(run.runId, 'artv_1', 'second')),
      ).toThrow();
      expect(store.getArtifactText(run.runId, 'artv_1')).toBe('first');
    });

    it('reads events in pages after a cursor, and keeps command scopes apart', () => {
      const store = makeStore();
      const run = newRun();
      const events = [stateEvent(run.runId, 1, 'validating'), stateEvent(run.runId, 2, 'running')];
      store.transaction(() => {
        store.insertRun(run);
        store.appendEvents(run.runId, events);
        store.saveProjection(run.runId, project(run.runId, events));
        store.putCommand({
          scope: '*',
          commandId: 'cmd_same',
          payloadHash: 'start',
          receipt: {
            commandId: 'cmd_same',
            runId: run.runId,
            status: 'applied',
            acceptedSeq: 1,
            target: `run:${run.runId}`,
            requestedBoundary: 'immediate',
            relatedEventIds: [],
          },
          runId: run.runId,
          directiveId: null,
        });
      });
      expect(store.readEvents(run.runId, 1).map((e) => e.runSeq)).toEqual([2]);
      expect(store.readEvents(run.runId, 0, 1).map((e) => e.runSeq)).toEqual([1]);
      expect(store.readEvents(run.runId, 2)).toEqual([]);
      expect(store.readEvents(run.runId, 0)).toEqual(events);
      expect(store.getCommand('*', 'cmd_same')?.payloadHash).toBe('start');
      expect(store.getCommand(run.runId, 'cmd_same')).toBeNull();
      expect(store.listRuns()).toEqual([
        {
          runId: run.runId,
          status: 'running',
          corralId: definition.id,
          startedAt: '2026-10-15T00:00:00.000Z',
        },
      ]);
      expect(store.getRun(run.runId)?.snapshot).toEqual(run.snapshot);
    });
  });
}
