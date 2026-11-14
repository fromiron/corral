import {
  type CorralDefinition,
  type EventPayload,
  ReasoningLevel,
  type RunEvent,
} from '@corral/contracts';
import type { RunProjection } from '@corral/core';

export type FlowEvidenceRef = EventPayload<'workflow.branch_selected'>['evidenceRefs'][number];
export interface RunFlowDecision {
  id: string;
  nodeId: string;
  iterationId: string | null;
  selectedPort: string | null;
  targetNodeId: string | null;
  targetPort: string | null;
  reasonCode: string | null;
  evidenceRefs: FlowEvidenceRef[];
  status: 'observed' | 'unrecorded';
  recordedAt: string | null;
  configRevision: number | null;
  reviewVerdict?: 'pass' | 'revise' | 'inconclusive';
  issues: string[];
}
export interface RunFlowIteration {
  iterationId: string;
  no: number;
  outcome: RunProjection['iterations'][string]['outcome'];
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RunFlowLoop {
  nodeId: string;
  label: string;
  /**
   * The rounds the current entry may run; null for a Loop without a cap. Once its limit policy
   * applied, the rounds ended before it plus the cap.
   */
  maxIterations: number | null;
  /** What the limit policy changed in the current entry, if it applied. */
  escalation:
    | { policy: 'raise_reasoning'; level: ReasoningLevel }
    | { policy: 'upper_model'; modelProfile: string }
    | null;
  /** Every observed round of every entry, for the round picker. */
  iterations: RunFlowIteration[];
  /** The rounds observed in the latest entry; the count, cap and status are that entry's. */
  rounds: number;
  selectedIterationId: string | null;
  /** The last round of the latest entry. */
  latestIterationId: string | null;
  /** Always the latest entry's last round, independent of the inspected round. */
  status: NonNullable<RunFlowIteration['outcome']> | 'active' | 'unrecorded';
}
/** Delegation inherits only recorded parent ownership, never nearby activity or node layout. */
export function runFlowExecutionIterationId(
  projection: RunProjection | null,
  executionId: string,
): string | null {
  const visited = new Set<string>();
  let execution = projection?.executions[executionId];
  while (execution && !visited.has(execution.executionId)) {
    if (execution.iterationId) return execution.iterationId;
    visited.add(execution.executionId);
    execution = execution.parentExecutionId
      ? projection?.executions[execution.parentExecutionId]
      : undefined;
  }
  return null;
}

/** Definition membership keeps a missing round record from becoming an unscoped execution. */
export function runFlowExecutionLoopId(
  projection: RunProjection | null,
  definition: CorralDefinition,
  executionId: string,
): string | null {
  const iterationId = runFlowExecutionIterationId(projection, executionId);
  const recordedLoop = iterationId ? projection?.iterations[iterationId]?.loopNodeId : null;
  if (recordedLoop) return recordedLoop;
  const visited = new Set<string>();
  let execution = projection?.executions[executionId];
  while (execution && !visited.has(execution.executionId)) {
    const node = definition.nodes.find((node) => node.id === execution?.nodeId);
    if (node?.parentId) return node.parentId;
    visited.add(execution.executionId);
    execution = execution.parentExecutionId
      ? projection?.executions[execution.parentExecutionId]
      : undefined;
  }
  return null;
}

/** Round selection limits displayed detail; it never rewinds the live projection. */
export function selectRunFlowIterations(
  projection: RunProjection | null,
  definition: CorralDefinition,
  selectedIterations: Readonly<Record<string, string>> = {},
  events: readonly RunEvent[] = [],
): RunFlowLoop[] {
  const started = new Map<string, string>();
  const finished = new Map<string, string>();
  for (const event of events) {
    if (event.runId !== projection?.runId) continue;
    if (event.type === 'loop.iteration_started')
      started.set(event.payload.iterationId, event.recordedAt);
    if (event.type === 'loop.iteration_finished')
      finished.set(event.payload.iterationId, event.recordedAt);
  }
  return definition.nodes.flatMap((node) => {
    if (node.type !== 'loop') return [];
    const iterations = Object.values(projection?.iterations ?? {})
      .filter((iteration) => iteration.loopNodeId === node.id)
      .sort((a, b) => a.no - b.no || a.iterationId.localeCompare(b.iterationId))
      .map(
        (iteration): RunFlowIteration => ({
          iterationId: iteration.iterationId,
          no: iteration.no,
          outcome: iteration.outcome,
          startedAt: started.get(iteration.iterationId) ?? null,
          finishedAt: finished.get(iteration.iterationId) ?? null,
        }),
      );
    // The latest entry: its rounds from the last first round on, in the order they opened.
    const order = projection?.loopIterations[node.id] ?? [];
    const first = order.findLastIndex((id) => projection?.iterations[id]?.no === 1);
    const entry = first < 0 ? [] : order.slice(first);
    const latest = entry.length
      ? iterations.find((iteration) => iteration.iterationId === entry.at(-1))
      : iterations.at(-1);
    const selected = Object.hasOwn(selectedIterations, node.id)
      ? iterations.find((iteration) => iteration.iterationId === selectedIterations[node.id])
      : latest;
    let maxIterations = node.maxIterations ?? null;
    let revision = -1;
    for (const patch of Object.values(projection?.patches ?? {})) {
      if (
        patch.kind === 'loop_limit' &&
        patch.scope.nodeId === node.id &&
        patch.controlRevision > revision &&
        typeof patch.after.maxIterations === 'number'
      ) {
        revision = patch.controlRevision;
        maxIterations = patch.after.maxIterations;
      }
    }
    const applied = (projection?.loopEscalations?.[node.id] ?? []).findLast((e) =>
      entry.includes(e.iterationId),
    );
    const before = applied ? (projection?.iterations[applied.iterationId]?.no ?? 0) : 0;
    const levels = applied?.policy === 'raise_reasoning' ? Object.values(applied.levels) : [];
    const raised = levels.reduce<ReasoningLevel | undefined>(
      (top, level) =>
        !top || ReasoningLevel.options.indexOf(level) > ReasoningLevel.options.indexOf(top)
          ? level
          : top,
      undefined,
    );
    return [
      {
        nodeId: node.id,
        label: node.label,
        maxIterations: maxIterations === null ? null : before + maxIterations,
        escalation:
          applied?.policy === 'upper_model'
            ? { policy: 'upper_model', modelProfile: applied.modelProfile }
            : raised
              ? { policy: 'raise_reasoning', level: raised }
              : null,
        iterations,
        rounds: entry.length || iterations.length,
        selectedIterationId: selected?.iterationId ?? null,
        latestIterationId: latest?.iterationId ?? null,
        status: latest ? (latest.outcome ?? 'active') : 'unrecorded',
      },
    ];
  });
}

/**
 * The recorded workflow decisions of the inspected rounds, oldest first, then each decision node
 * the run has not recorded a branch for. Committed records only: no body lookup, timestamp
 * matching or definition-edge inference.
 */
export function runFlowDecisions(
  projection: RunProjection | null,
  events: readonly RunEvent[],
  definition: CorralDefinition,
  selectedIterations: Readonly<Record<string, string>> = {},
): RunFlowDecision[] {
  if (!projection) return [];
  const loops = selectRunFlowIterations(projection, definition, selectedIterations, events);
  const selectedByLoop = new Map(loops.map((loop) => [loop.nodeId, loop.selectedIterationId]));
  const includesIteration = (
    iterationId: string | null,
    definedLoopId?: string | null,
  ): boolean => {
    if (!iterationId) return true;
    const loopId = projection.iterations[iterationId]?.loopNodeId ?? definedLoopId;
    return !loopId || !selectedByLoop.has(loopId) || selectedByLoop.get(loopId) === iterationId;
  };
  const branches = new Map(Object.entries(projection.workflowBranches ?? {}));
  for (const event of events) {
    if (event.runId === projection.runId && event.type === 'workflow.branch_selected')
      branches.set(event.eventId, {
        ...event.payload,
        eventId: event.eventId,
        recordedAt: event.recordedAt,
        runSeq: event.runSeq,
      });
  }
  const decisions: RunFlowDecision[] = [...branches.values()]
    .filter((branch) => {
      const node = definition.nodes.find((node) => node.id === branch.nodeId);
      return includesIteration(branch.iterationId, node?.parentId ?? null);
    })
    .sort((a, b) => a.runSeq - b.runSeq)
    .map((branch) => {
      const review = branch.evidenceRefs
        .flatMap((ref) => (ref.kind === 'review' ? (projection.reviews[ref.id] ?? []) : []))
        .at(-1);
      return {
        id: branch.eventId,
        nodeId: branch.nodeId,
        iterationId: branch.iterationId,
        selectedPort: branch.selectedPort,
        targetNodeId: branch.targetNodeId,
        targetPort: branch.targetPort,
        reasonCode: branch.reasonCode,
        evidenceRefs: branch.evidenceRefs,
        status: 'observed' as const,
        recordedAt: branch.recordedAt,
        configRevision: branch.configRevision,
        ...(review ? { reviewVerdict: review.verdict } : {}),
        issues: review?.issues.map((issue) => issue.reason) ?? [],
      };
    });
  for (const node of definition.nodes) {
    if (node.type !== 'decision' || decisions.some((decision) => decision.nodeId === node.id))
      continue;
    decisions.push({
      id: `unrecorded:${node.id}`,
      nodeId: node.id,
      iterationId: null,
      selectedPort: null,
      targetNodeId: null,
      targetPort: null,
      reasonCode: null,
      evidenceRefs: [],
      status: 'unrecorded',
      recordedAt: null,
      configRevision: null,
      issues: [],
    });
  }
  return decisions;
}
