import { openRunArchive, type RuntimeTransport } from '@corral/core';
import type { RunSessionState } from '@corral/react';

type HistoryReader = (runId: string) => Promise<unknown>;
type ViewTransport = Pick<RuntimeTransport, 'getSnapshot' | 'getRunDefinition'>;
type RunView = Awaited<ReturnType<typeof loadRunView>>;
const pendingReads = new WeakMap<
  ViewTransport,
  WeakMap<HistoryReader, Map<string, Promise<RunView>>>
>();

/** Finished turns are read-only snapshots; opening their work log uses the existing archive reader. */
export function readRunView(
  transport: ViewTransport,
  readHistory: HistoryReader,
  runId: string,
  details: boolean,
) {
  let readers = pendingReads.get(transport);
  if (!readers) {
    readers = new WeakMap();
    pendingReads.set(transport, readers);
  }
  let reads = readers.get(readHistory);
  if (!reads) {
    reads = new Map();
    readers.set(readHistory, reads);
  }
  const key = `${details ? 'details' : 'summary'}:${runId}`;
  const prior = reads.get(key);
  if (prior) return prior;
  const cache = reads;
  const pending = loadRunView(transport, readHistory, runId, details).then(
    (view) => {
      // Settlement/usage can arrive after terminal status. Reopened history must read again.
      if (cache.get(key) === pending) cache.delete(key);
      return view;
    },
    (error: unknown) => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    },
  );
  cache.set(key, pending);
  return pending;
}

async function loadRunView(
  transport: ViewTransport,
  readHistory: HistoryReader,
  runId: string,
  details: boolean,
) {
  if (!details) {
    const [{ projection }, definition] = await Promise.all([
      transport.getSnapshot(runId),
      transport.getRunDefinition(runId),
    ]);
    if (!definition || projection.runId !== runId) throw new Error('The run is unavailable.');
    return {
      runId,
      projection,
      definition,
      events: [],
      streams: {},
      artifactTexts: {},
      streamError: null,
    };
  }
  const archive = openRunArchive(await readHistory(runId));
  if (archive.visibility !== 'private' || archive.runId !== runId)
    throw new Error('The run history does not match this turn.');
  const streams: RunSessionState['streams'] = {};
  for (const call of Object.values(archive.projection.modelCalls)) {
    const text = call.responseRef ? archive.artifacts[call.responseRef] : undefined;
    if (text !== undefined)
      streams[call.modelCallId] = { text, next: 0, broken: false, completed: true };
  }
  return {
    runId,
    projection: archive.projection,
    definition: archive.snapshot.definition,
    events: [...archive.events],
    streams,
    artifactTexts: archive.artifacts,
    streamError: null,
  };
}
