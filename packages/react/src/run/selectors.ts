import { type CorralDefinition, TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import type { ExecutionView, RunProjection } from '@corral/core';

export type NodeRunStatus =
  | 'idle'
  | 'active'
  | 'mixed'
  | 'model'
  | 'tool'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'queued'
  | 'ready'
  | 'waiting_children'
  | 'waiting_message'
  | 'waiting_approval'
  | 'pausing'
  | 'paused'
  | 'cancelling';

export interface NodeRunSummary {
  status: NodeRunStatus;
  /** One current attempt per task; finished tasks remain visible beside live work. */
  counts: Partial<Record<NodeRunStatus, number>>;
  previousFailures: number;
}

function currentAttempts(projection: RunProjection, executions: ExecutionView[]): ExecutionView[] {
  const latest = new Map<string, ExecutionView>();
  for (const execution of executions) {
    const previous = latest.get(execution.taskId);
    if (!previous || previous.attemptNo <= execution.attemptNo)
      latest.set(execution.taskId, execution);
  }
  return [...latest.values()].map((last) => {
    const id = projection.tasks[last.taskId]?.activeExecutionId;
    const active = id ? projection.executions[id] : undefined;
    return active?.taskId === last.taskId && active.nodeId === last.nodeId ? active : last;
  });
}

/** Current work is separate from failed attempts it already replaced. */
export function nodeRunSummary(projection: RunProjection | null, nodeId: string): NodeRunSummary {
  const executions = (projection?.nodeExecutions[nodeId] ?? []).flatMap(
    (id) => projection?.executions[id] ?? [],
  );
  if (!projection || !executions.length) return { status: 'idle', counts: {}, previousFailures: 0 };
  const current = currentAttempts(projection, executions);
  const counts: NodeRunSummary['counts'] = {};
  for (const execution of current) {
    const approval = Object.values(projection.approvals).some(
      (a) => a.status === 'pending' && a.tool?.executionId === execution.executionId,
    );
    const status: NodeRunStatus =
      execution.status === 'succeeded'
        ? 'done'
        : approval && execution.status === 'active'
          ? 'waiting_approval'
          : execution.status === 'active'
            ? (execution.activity ?? 'active')
            : execution.status;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const ongoing = Object.keys(counts).filter(
    (status) => !['done', 'failed', 'cancelled'].includes(status),
  ) as NodeRunStatus[];
  const working = ongoing.filter((state) =>
    ['active', 'model', 'tool', 'finalizing'].includes(state),
  );
  const status =
    working.length === 1
      ? (working[0] ?? 'active')
      : working.length
        ? 'active'
        : ongoing.length === 1
          ? (ongoing[0] ?? 'mixed')
          : ongoing.length
            ? 'mixed'
            : counts.failed
              ? 'failed'
              : counts.cancelled
                ? 'cancelled'
                : 'done';
  const currentIds = new Set(current.map((execution) => execution.executionId));
  const previousFailures = executions.filter(
    (execution) => execution.status === 'failed' && !currentIds.has(execution.executionId),
  ).length;
  return { status, counts, previousFailures };
}

/** Aggregated status of current tasks at one design node. */
export function nodeRunStatus(projection: RunProjection | null, nodeId: string): NodeRunStatus {
  return nodeRunSummary(projection, nodeId).status;
}

/** How many executions one design node has had in this run. */
export function nodeExecutionCount(projection: RunProjection | null, nodeId: string): number {
  return projection?.nodeExecutions[nodeId]?.length ?? 0;
}

/** Decisions without a recorded node owner stay at Run level. */
export function decisionRunStatus(
  projection: RunProjection | null,
  node: {
    id: string;
    type: string;
    mode?: string;
    loopId?: string | null;
    requireApproval?: boolean;
  },
): { status: NodeRunStatus; count: number } {
  if (!projection) return { status: 'idle', count: 0 };
  if (node.type === 'decision' && node.mode === 'review' && node.loopId) {
    const decided = (projection.loopIterations[node.loopId] ?? []).filter((id) => {
      const outcome = projection.iterations[id]?.outcome;
      return outcome === 'pass' || outcome === 'revise' || outcome === 'inconclusive';
    }).length;
    return decided ? { status: 'done', count: decided } : { status: 'idle', count: 0 };
  }
  return {
    status: node.type === 'output' && projection.output?.nodeId === node.id ? 'done' : 'idle',
    count: 0,
  };
}

export interface ObservedRunRelation {
  kind: 'delegate' | 'question';
  source: string;
  target: string;
  targetHandle: 'callable' | 'in';
  count: number;
  activeCount: number;
}

/** Actual calls only: a question responder is not also a delegated task. */
export function observedRunRelations(
  projection: RunProjection | null,
  definition: CorralDefinition,
): ObservedRunRelation[] {
  if (!projection) return [];
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const relations = new Map<string, ObservedRunRelation>();
  const add = (
    kind: ObservedRunRelation['kind'],
    source: string,
    target: string,
    active: boolean,
  ) => {
    const from = nodes.get(source);
    const to = nodes.get(target);
    if (from?.type !== 'agent' || to?.type !== 'agent') return;
    const key = `${kind}:${source}:${target}`;
    const relation = relations.get(key) ?? {
      kind,
      source,
      target,
      targetHandle: to.invocation === 'callable' ? 'callable' : 'in',
      count: 0,
      activeCount: 0,
    };
    relation.count++;
    relation.activeCount += Number(active);
    relations.set(key, relation);
  };
  const questions = Object.values(projection.questions);
  const responding = new Set(questions.filter((q) => q.delivery !== 'parent').map((q) => q.taskId));
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  for (const child of currentAttempts(projection, executions)) {
    const parent = child.parentExecutionId
      ? projection.executions[child.parentExecutionId]
      : undefined;
    if (parent && !responding.has(child.taskId))
      add('delegate', parent.nodeId, child.nodeId, !TERMINAL_EXECUTION_STATUSES.has(child.status));
  }
  for (const question of questions) {
    const sender = projection.executions[question.senderExecutionId];
    if (sender) add('question', sender.nodeId, question.targetNodeId, question.status === 'open');
  }
  return [...relations.values()];
}
