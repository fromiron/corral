import type { FileChangeView, FileOperationView } from '@corral/client';

/**
 * The working-copy files a run made, each with that run. A file counts only when the session's
 * changes say its current content is exactly Corral's last applied write (`managed_agent`), and
 * the run is the one that recorded that write. Files changed afterwards by anything else, shell
 * output, writes whose outcome is unknown and deleted files are never attributed.
 */
export function runResultFiles(
  operations: readonly FileOperationView[],
  changes: readonly FileChangeView[],
): Map<string, string> {
  // Newest first, as the server lists them: the first applied operation on a path is its last.
  const last = new Map<string, string | null>();
  const record = (path: string, runId: string | null) => {
    if (!last.has(path)) last.set(path, runId);
  };
  for (const operation of operations) {
    if (operation.state !== 'applied') continue;
    if (operation.kind === 'move') {
      if (operation.to_path) record(operation.to_path, operation.run_id);
      record(operation.path, null);
    } else record(operation.path, operation.kind === 'delete' ? null : operation.run_id);
  }
  const made = new Map<string, string>();
  for (const change of changes) {
    if (change.status === 'deleted' || change.provenance !== 'managed_agent') continue;
    const runId = last.get(change.path);
    if (runId) made.set(change.path, runId);
  }
  return made;
}
