import { openRunArchive, type RuntimeTransport } from '@corral/core';
import type { RunSessionState } from '@corral/react';

/** Finished turns are read-only snapshots; opening their work log uses the existing archive reader. */
export async function readRunView(
  transport: Pick<RuntimeTransport, 'getSnapshot' | 'getRunDefinition'>,
  readHistory: (runId: string) => Promise<unknown>,
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
