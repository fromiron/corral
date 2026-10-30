import type { FileOperationView, IntegrationResultView } from '@corral/client';
import type { FileCheckpoint } from '@corral/contracts';

/** The persisted integration state also describes apply; outcomes identify a later revert. */
export function integrationDisplayState(integration: IntegrationResultView) {
  if (integration.files.some((file) => file.outcome === 'revert_conflict')) {
    return integration.files.some((file) => file.outcome === 'reverted')
      ? 'partlyReverted'
      : 'notReverted';
  }
  if (integration.files.some((file) => file.outcome === 'reverted')) {
    return integration.files.some((file) => file.outcome === 'applied')
      ? 'partlyReverted'
      : 'reverted';
  }
  return integration.state;
}

/** Repeated writes are separate effects even when their path and run match. */
export function uniqueFileOperations(operations: FileOperationView[]) {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    if (seen.has(operation.id)) return false;
    seen.add(operation.id);
    return true;
  });
}

export function unchangedCheckpoints(checkpoints: FileCheckpoint[]) {
  const previous = new Map<FileCheckpoint['target'], string | null>();
  const unchanged = new Set<string>();
  // The API orders newest first, including its row-order tie break for equal timestamps.
  for (const checkpoint of checkpoints
    .toReversed()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (checkpoint.state !== 'ready' || !checkpoint.tree) continue;
    if (previous.get(checkpoint.target) === checkpoint.tree) unchanged.add(checkpoint.checkpointId);
    previous.set(checkpoint.target, checkpoint.tree);
  }
  return unchanged;
}
