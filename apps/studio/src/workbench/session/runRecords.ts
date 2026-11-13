import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../services.tsx';
import type { RunRecord } from './entryMeta.ts';

/**
 * The records of the runs the conversation's instructions went to. A running run is followed
 * through its live store, which WorkTab keeps open; an ended run is read once. Nothing polls:
 * a running run's record changes as its events arrive, and an ended run's record does not.
 */
export function useRunRecords(
  runIds: readonly string[],
  runs: readonly RunSummary[],
): ReadonlyMap<string, RunRecord> {
  const { runFor, transport } = useServices();
  const [records, setRecords] = useState<ReadonlyMap<string, RunRecord>>(() => new Map());
  // Ended runs already read in this view; their record does not change.
  const ended = useRef(new Set<string>());
  const live = (runId: string) => {
    const run = runs.find((item) => item.runId === runId);
    return run !== undefined && !TERMINAL_RUN_STATUSES.has(run.status);
  };
  const key = [...new Set(runIds)].map((runId) => `${runId}:${live(runId) ? 'live' : 'ended'}`);
  const signature = key.join(',');
  useEffect(() => {
    let current = true;
    const put = (runId: string, record: RunRecord, fill = false) => {
      if (!current) return;
      setRecords((previous) => {
        const before = previous.get(runId);
        // A first read while the live store opens never replaces what the store already gave.
        if (fill && before) return previous;
        if (before?.projection === record.projection && before.definition === record.definition)
          return previous;
        return new Map(previous).set(runId, record);
      });
    };
    const read = (runId: string, fill = false) =>
      Promise.all([transport.getSnapshot(runId), transport.getRunDefinition(runId)]).then(
        ([{ projection }, definition]) => {
          put(runId, { projection, definition }, fill);
          return true;
        },
        () => false,
      );
    const stops: (() => void)[] = [];
    for (const item of signature ? signature.split(',') : []) {
      const [runId = '', mode] = item.split(':');
      if (mode === 'ended') {
        if (ended.current.has(runId)) continue;
        ended.current.add(runId);
        void read(runId).then((ok) => {
          if (!ok) ended.current.delete(runId);
        });
        continue;
      }
      // A running run: its live store, once WorkTab's open() has its record; read once until then.
      ended.current.delete(runId);
      const store = runFor(runId);
      const take = () => {
        const state = store.getState();
        if (state.runId !== runId || !state.projection) return false;
        put(runId, { projection: state.projection, definition: state.definition });
        return true;
      };
      if (!take()) void read(runId, true);
      stops.push(store.subscribe(() => void take()));
    }
    return () => {
      current = false;
      for (const stop of stops) stop();
    };
  }, [signature, runFor, transport]);
  return records;
}
