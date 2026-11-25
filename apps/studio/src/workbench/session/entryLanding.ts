import type { RunSummary } from '@corral/core';

export function unseenAnswerRun(
  runs: readonly Pick<RunSummary, 'runId' | 'status'>[],
  seenRun: string | null,
): string | null {
  const newest = runs.at(-1);
  return newest?.status === 'succeeded' && newest.runId !== seenRun ? newest.runId : null;
}
