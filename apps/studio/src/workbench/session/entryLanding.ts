import type { RunSummary } from '@corral/core';
import { type SeenMemory, sawRun } from '../panel/memory.ts';

export function unseenAnswerRun(
  runs: readonly Pick<RunSummary, 'runId' | 'status'>[],
  seen: SeenMemory | null,
): string | null {
  const newest = runs.at(-1);
  return newest?.status === 'succeeded' && !sawRun(seen, newest.runId) ? newest.runId : null;
}
