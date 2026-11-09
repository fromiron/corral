import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from './projection.ts';

/** Shared reader/cache policy. Runtime storage keeps operational data until every owner settles. */
export function canReadArtifactBody(projection: RunProjection | null, id: string): boolean {
  if (!projection) return false;
  const artifact = projection.artifacts[id];
  if (artifact?.bodyAvailable === false) return false;
  if (TERMINAL_RUN_STATUSES.has(projection.status))
    return (
      (!!artifact && !!projection.output?.artifactVersionIds.includes(id)) ||
      stepResultIds(projection).includes(id)
    );
  if (!artifact) return true; // Caller validates operational refs (criteria, tool payloads, images).
  if (projection.output?.artifactVersionIds.includes(id)) return true;
  if (
    Object.values(projection.approvals).some(
      (a) =>
        a.status === 'pending' &&
        (a.subjectVersionIds.includes(id) || a.criteriaVersionId === id || a.tool?.bodyRef === id),
    )
  )
    return true;
  if (
    Object.values(projection.modelCalls).some(
      (call) =>
        call.inputArtifactVersionIds.includes(id) &&
        !TERMINAL_EXECUTION_STATUSES.has(
          projection.executions[call.executionId]?.status ?? 'succeeded',
        ),
    )
  )
    return true;
  if (
    Object.entries(projection.artifactReads).some(
      ([executionId, ids]) =>
        ids.includes(id) &&
        !TERMINAL_EXECUTION_STATUSES.has(projection.executions[executionId]?.status ?? 'succeeded'),
    )
  )
    return true;
  return !Object.values(projection.artifacts).some(
    (other) => other.artifactId === artifact.artifactId && other.version > artifact.version,
  );
}

export function canReleaseArtifactBodies(projection: RunProjection): boolean {
  return (
    TERMINAL_RUN_STATUSES.has(projection.status) &&
    Object.values(projection.executions).every((e) => TERMINAL_EXECUTION_STATUSES.has(e.status)) &&
    Object.values(projection.effects).every((e) => e.status === 'settled')
  );
}

/** A node's last completed submission in a run, or the result a fork copied for it. */
export function stepResult(projection: RunProjection, nodeId: string): string[] {
  const executions = projection.nodeExecutions[nodeId] ?? [];
  for (const id of [...executions].reverse()) {
    const task = projection.tasks[projection.executions[id]?.taskId ?? ''];
    if (task?.status === 'completed') return task.submittedArtifactVersionIds;
  }
  if (executions.length) return [];
  return projection.forkedFrom?.carried.find((c) => c.nodeId === nodeId)?.artifactVersionIds ?? [];
}

/**
 * The step results a finished run keeps with its final result, so it can be forked: each node's
 * last completed submission and every result its own fork copied.
 */
export function stepResultIds(projection: RunProjection): string[] {
  return [
    ...new Set([
      ...Object.keys(projection.nodeExecutions).flatMap((nodeId) => stepResult(projection, nodeId)),
      ...(projection.forkedFrom?.carried.flatMap((c) => c.artifactVersionIds) ?? []),
    ]),
  ];
}
