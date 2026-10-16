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

/** How many executions one design node has had in this run (Spec §4.3). */
export function nodeExecutionCount(projection: RunProjection | null, nodeId: string): number {
  return projection?.nodeExecutions[nodeId]?.length ?? 0;
}

/**
 * What a Decision or Output node shows (UX-A4). They have no executions: a review decision
 * reports the rounds it decided, an approval decision and an Output with final approval report
 * the person's decisions. Other nodes are `idle` here.
 */
export function decisionRunStatus(
  projection: RunProjection | null,
  node: {
    id: string;
    type: string;
    mode?: string;
    loopId?: string | null;
    requireApproval?: boolean;
  },
): { status: NodeRunStatus | 'waiting'; count: number } {
  if (!projection) return { status: 'idle', count: 0 };
  const approvalsOf = (kind: string) =>
    Object.values(projection.approvals).filter((a) => a.kind === kind);
  const fromApprovals = (kind: string) => {
    const list = approvalsOf(kind);
    if (list.some((a) => a.status === 'pending'))
      return { status: 'waiting' as const, count: list.length - 1 };
    if (list.some((a) => a.status === 'rejected'))
      return { status: 'failed' as const, count: list.length };
    return list.length
      ? { status: 'done' as const, count: list.length }
      : { status: 'idle' as const, count: 0 };
  };
  if (node.type === 'decision' && node.mode === 'review' && node.loopId) {
    const decided = (projection.loopIterations[node.loopId] ?? []).filter((id) => {
      const outcome = projection.iterations[id]?.outcome;
      return outcome === 'pass' || outcome === 'revise' || outcome === 'inconclusive';
    }).length;
    return decided ? { status: 'done', count: decided } : { status: 'idle', count: 0 };
  }
  if (node.type === 'decision' && node.mode === 'approval') return fromApprovals('user_action');
  if (node.type === 'output') {
    if (node.requireApproval) {
      const approval = fromApprovals('final_output');
      if (approval.status !== 'idle') return { ...approval, count: 0 };
    }
    return projection.output ? { status: 'done', count: 0 } : { status: 'idle', count: 0 };
  }
  return { status: 'idle', count: 0 };
}
