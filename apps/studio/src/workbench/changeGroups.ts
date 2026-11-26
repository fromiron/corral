import type { ChangeSetView, FileChangeView } from '@corral/client';

export interface ChangeGroup {
  runId: string | null;
  files: FileChangeView[];
}

export function changeGroups(
  changes: ChangeSetView | null,
  folded: (file: FileChangeView) => boolean,
): ChangeGroup[] | null {
  if (!changes?.runs || changes.unavailable) return null;
  const files = changes.files.filter((file) => !folded(file));
  if (files.some((file) => !file.runs?.length && !file.outsideRuns)) return null;
  const groups = [
    ...changes.runs.toReversed().map((runId) => ({
      runId,
      files: files.filter((file) => file.runs?.includes(runId)),
    })),
    { runId: null, files: files.filter((file) => file.outsideRuns) },
  ].filter((group) => group.files.length > 0);
  return groups.length > 1 ? groups : null;
}
