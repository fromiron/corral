import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { DirectiveView, RunSummary, RuntimeTransport } from '@corral/core';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useServices } from '../../services.tsx';
import { forgetOnReset } from '../viewMemory.ts';
import type { RunRecord } from './entryMeta.ts';

// The records of the runs the conversation's instructions went to (features/composer-flow.md
// "계약"). A running run is followed through its live store, which WorkTab keeps open. An ended
// run's record does not change: it is read once, when a message about it is drawn, and kept
// while the app runs. Nothing polls.

/** How many ended runs' records are read at the same time; the rest wait their turn. */
export const RECORD_READS_AT_ONCE = 4;

type Transport = Pick<RuntimeTransport, 'getSnapshot' | 'getRunDefinition'>;
type Slot = { state: 'waiting' | 'reading' | 'failed' } | { state: 'read'; record: RunRecord };

/** One transport's ended-run records, read through a small queue. */
class RecordCache {
  private slots = new Map<string, Slot>();
  private queue: string[] = [];
  private reading = 0;
  private listeners = new Set<() => void>();
  private version = 0;

  private readonly transport: Transport;
  constructor(transport: Transport) {
    this.transport = transport;
  }

  get(runId: string): RunRecord | undefined {
    const slot = this.slots.get(runId);
    return slot?.state === 'read' ? slot.record : undefined;
  }

  /** Asks for a run's record unless it is read or on its way; a failed one is asked again. */
  request(runId: string) {
    const slot = this.slots.get(runId);
    if (slot && slot.state !== 'failed') return;
    this.slots.set(runId, { state: 'waiting' });
    this.queue.push(runId);
    this.pump();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.version;

  clear() {
    this.slots.clear();
    this.queue = [];
    this.changed();
  }

  private changed() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private pump() {
    while (this.reading < RECORD_READS_AT_ONCE && this.queue.length) {
      const runId = this.queue.shift() as string;
      if (this.slots.get(runId)?.state !== 'waiting') continue;
      this.slots.set(runId, { state: 'reading' });
      this.reading += 1;
      void Promise.all([
        this.transport.getSnapshot(runId),
        this.transport.getRunDefinition(runId),
      ]).then(
        ([{ projection }, definition]) => {
          if (this.slots.get(runId)?.state === 'reading')
            this.slots.set(runId, { state: 'read', record: { projection, definition } });
          this.settle();
        },
        () => {
          if (this.slots.get(runId)?.state === 'reading')
            this.slots.set(runId, { state: 'failed' });
          this.settle();
        },
      );
    }
  }

  private settle() {
    this.reading -= 1;
    this.changed();
    this.pump();
  }
}

const caches = new WeakMap<Transport, RecordCache>();
const all = new Set<RecordCache>();
function cacheFor(transport: Transport) {
  let cache = caches.get(transport);
  if (!cache) {
    cache = new RecordCache(transport);
    caches.set(transport, cache);
    all.add(cache);
  }
  return cache;
}
/** Forgets every kept record (a reset of the app's view memory, or a test). */
export function forgetRunRecords() {
  for (const cache of all) cache.clear();
}
forgetOnReset(forgetRunRecords);

/** A message about an ended run is drawn: its record is read, once. */
export function useRecordRead(runId: string | null, ended: boolean) {
  const { transport } = useServices();
  useEffect(() => {
    if (runId && ended && transport) cacheFor(transport).request(runId);
  }, [runId, ended, transport]);
}

/** An instruction this view saw expire: the session read count then, and its status before. */
export interface WatchedExpiry {
  at: number;
  before: DirectiveView['status'];
}

/**
 * The records known for these runs: live ones from their store, ended ones from what was read
 * (nothing is read here). An instruction seen to go from waiting to expired while its run is
 * live is `watched`: `started()` says which session read was the latest asked for then, and
 * `onWatchedExpiry` asks for another, since only the session says whether it was carried.
 */
export function useRunRecords(
  runIds: readonly string[],
  runs: readonly RunSummary[],
  options: { started: () => number; onWatchedExpiry: () => void },
): { records: ReadonlyMap<string, RunRecord>; watched: ReadonlyMap<string, WatchedExpiry> } {
  const { runFor, transport } = useServices();
  const cache = transport ? cacheFor(transport) : null;
  useSyncExternalStore(
    cache?.subscribe ?? noSubscribe,
    cache?.snapshot ?? zero,
    cache?.snapshot ?? zero,
  );
  const [live, setLive] = useState<ReadonlyMap<string, RunRecord>>(() => new Map());
  const [watched, setWatched] = useState<ReadonlyMap<string, WatchedExpiry>>(() => new Map());
  const seen = useRef(new Map<string, DirectiveView['status']>());
  const latest = useRef(options);
  latest.current = options;
  const running = (runId: string) => {
    const run = runs.find((item) => item.runId === runId);
    return run !== undefined && !TERMINAL_RUN_STATUSES.has(run.status);
  };
  const unique = [...new Set(runIds)];
  const liveIds = unique.filter(running).join(',');
  useEffect(() => {
    let current = true;
    const stops: (() => void)[] = [];
    for (const runId of liveIds ? liveIds.split(',') : []) {
      const store = runFor(runId);
      const take = () => {
        const state = store.getState();
        if (!current || state.runId !== runId || !state.projection) return;
        const record = { projection: state.projection, definition: state.definition };
        const expired: [string, WatchedExpiry][] = [];
        for (const directive of Object.values(record.projection.directives)) {
          const before = seen.current.get(directive.directiveId);
          seen.current.set(directive.directiveId, directive.status);
          if (directive.status === 'expired' && before !== undefined && before !== 'expired')
            expired.push([directive.directiveId, { at: latest.current.started(), before }]);
        }
        setLive((previous) =>
          previous.get(runId)?.projection === record.projection
            ? previous
            : new Map(previous).set(runId, record),
        );
        if (expired.length) {
          setWatched((previous) => new Map([...previous, ...expired]));
          latest.current.onWatchedExpiry();
        }
      };
      take();
      stops.push(store.subscribe(take));
    }
    return () => {
      current = false;
      for (const stop of stops) stop();
    };
  }, [liveIds, runFor]);
  const records = new Map<string, RunRecord>();
  for (const runId of unique) {
    // An ended run's read record; until it is read, what its live store last showed.
    const record = (!running(runId) && cache?.get(runId)) || live.get(runId);
    if (record) records.set(runId, record);
  }
  return { records, watched };
}

const noSubscribe = () => () => {};
const zero = () => 0;
