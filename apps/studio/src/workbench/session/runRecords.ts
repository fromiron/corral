import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import {
  type DirectiveView,
  emptyProjection,
  type RunProjection,
  type RunSummary,
  type RuntimeTransport,
} from '@corral/core';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useServices } from '../../services.tsx';
import { forgetOnReset } from '../viewMemory.ts';
import type { RunRecord } from './entryMeta.ts';

// The records of the runs the conversation's instructions went to (features/composer-flow.md
// "계약"). A running run is followed through its live store, which WorkTab keeps open. An ended
// run's record does not change: it is read once, when a message about it is drawn, and kept
// while the app runs, as far as a meta line reads it. A run not yet known to have ended (the run
// list not read yet) is not read as ended. A failed read is asked again, a few times, while its
// message is drawn. Nothing polls.

/** How many ended runs' records are read at the same time; the rest wait their turn. */
export const RECORD_READS_AT_ONCE = 4;
/** A failed read is asked again after `firstMs`, twice as long each time, `attempts` times. */
export const RECORD_RETRY = { firstMs: 1000, attempts: 5 };
/** The wait before asking a failed read again; a test puts its own clock here. */
export const recordRetry = {
  later: (ms: number, run: () => void): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

type Transport = Pick<RuntimeTransport, 'getSnapshot' | 'getRunDefinition'>;
type Slot = { state: 'waiting' | 'reading' | 'failed' } | { state: 'read'; record: RunRecord };

/**
 * What a meta line reads of an ended run: its instructions, the executions they went to, those
 * executions' model calls (an interrupt's cut) and role names. The rest is not kept.
 */
export function keptRecord(
  projection: RunProjection,
  definition: RunRecord['definition'],
): RunRecord {
  const kept = emptyProjection(projection.runId);
  kept.status = projection.status;
  kept.lastSeq = projection.lastSeq;
  kept.directives = projection.directives;
  kept.directiveOrder = projection.directiveOrder;
  const targets = new Set(
    Object.values(projection.directives).map((directive) => directive.targetExecutionId),
  );
  kept.executionOrder = projection.executionOrder.filter((id) => targets.has(id));
  for (const id of targets) {
    const execution = projection.executions[id];
    if (execution) kept.executions[id] = execution;
  }
  for (const [id, call] of Object.entries(projection.modelCalls))
    if (targets.has(call.executionId)) kept.modelCalls[id] = call;
  const nodes = new Set(Object.values(kept.executions).map((execution) => execution.nodeId));
  return {
    projection: kept,
    definition: definition
      ? {
          nodes: definition.nodes
            .filter((node) => nodes.has(node.id))
            .map((node) => {
              const { id, type, label } = node;
              const mode = 'mode' in node ? node.mode : undefined;
              return { id, type, label, ...(mode ? { mode } : {}) } as typeof node;
            }),
        }
      : null,
  };
}

/** One transport's ended-run records, read through a small queue. */
class RecordCache {
  private slots = new Map<string, Slot>();
  private failed = new Map<string, number>();
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

  /** How many times this run's read has failed, while its last one did; 0 otherwise. */
  failures(runId: string): number {
    return this.slots.get(runId)?.state === 'failed' ? (this.failed.get(runId) ?? 0) : 0;
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
    this.failed.clear();
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
          // Read as ended only once it has: a run still going is followed live instead.
          if (!TERMINAL_RUN_STATUSES.has(projection.status)) this.fail(runId);
          else if (this.slots.get(runId)?.state === 'reading')
            this.slots.set(runId, { state: 'read', record: keptRecord(projection, definition) });
          this.settle();
        },
        () => {
          this.fail(runId);
          this.settle();
        },
      );
    }
  }

  private fail(runId: string) {
    if (this.slots.get(runId)?.state !== 'reading') return;
    this.slots.set(runId, { state: 'failed' });
    this.failed.set(runId, (this.failed.get(runId) ?? 0) + 1);
  }

  private settle() {
    this.reading -= 1;
    this.changed();
    this.pump();
  }
}

const caches = new WeakMap<Transport, RecordCache>();
// Weakly: a transport let go takes its records with it.
const all = new Set<WeakRef<RecordCache>>();
function cacheFor(transport: Transport) {
  let cache = caches.get(transport);
  if (!cache) {
    cache = new RecordCache(transport);
    caches.set(transport, cache);
    all.add(new WeakRef(cache));
  }
  return cache;
}
/** Forgets every kept record (a reset of the app's view memory, or a test). */
export function forgetRunRecords() {
  for (const ref of all) {
    const cache = ref.deref();
    if (cache) cache.clear();
    else all.delete(ref);
  }
}
forgetOnReset(forgetRunRecords);

/**
 * A message about a run is drawn: once the run is known to have ended (ended in the run list, or
 * gone from a list that was read), its record is read, once. A failed read is asked again while
 * the message stays drawn, later each time, a few times.
 */
export function useRecordRead(runId: string | null, runs: readonly RunSummary[], listed: boolean) {
  const { transport } = useServices();
  const cache = transport ? cacheFor(transport) : null;
  const run = runId ? runs.find((item) => item.runId === runId) : undefined;
  const ended = run ? TERMINAL_RUN_STATUSES.has(run.status) : listed;
  const failures = useSyncExternalStore(cache?.subscribe ?? noSubscribe, () =>
    runId && cache ? cache.failures(runId) : 0,
  );
  const retries = useRef(0);
  useEffect(() => {
    if (runId && ended && cache) cache.request(runId);
  }, [runId, ended, cache]);
  useEffect(() => {
    if (!runId || !ended || !cache || failures === 0) return;
    if (retries.current >= RECORD_RETRY.attempts) return;
    return recordRetry.later(RECORD_RETRY.firstMs * 2 ** retries.current, () => {
      retries.current += 1;
      cache.request(runId);
    });
  }, [runId, ended, cache, failures]);
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
    // An ended run's read record; until it is read, what its live store last showed. The read
    // one does not stand in front of a later live one.
    const read = running(runId) ? undefined : cache?.get(runId);
    const last = live.get(runId);
    const record =
      read && (!last || read.projection.lastSeq >= last.projection.lastSeq) ? read : last;
    if (record) records.set(runId, record);
  }
  return { records, watched };
}

const noSubscribe = () => () => {};
const zero = () => 0;
