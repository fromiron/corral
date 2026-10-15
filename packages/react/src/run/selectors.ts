import type { RunProjection } from '@corral/core';

export type NodeRunStatus = 'idle' | 'active' | 'done' | 'failed';

/** Aggregated status of every execution of one design node (a node is not one execution). */
export function nodeRunStatus(projection: RunProjection | null, nodeId: string): NodeRunStatus {
  const ids = projection?.nodeExecutions[nodeId] ?? [];
  if (ids.length === 0) return 'idle';
  const statuses = ids.map((id) => projection?.executions[id]?.status);
  if (statuses.some((s) => s === 'failed' || s === 'cancelled')) return 'failed';
  if (statuses.every((s) => s === 'succeeded')) return 'done';
  return 'active';
}
