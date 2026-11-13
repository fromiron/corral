import {
  type CorralDefinition,
  type EventPayload,
  ReasoningLevel,
  type RunEvent,
} from '@corral/contracts';
import { canReadArtifactBody, type RunProjection } from '@corral/core';
import { nodeRunSummary } from './selectors.ts';

export type FlowEvidenceRef = EventPayload<'workflow.branch_selected'>['evidenceRefs'][number];
export interface RunFlowNode {
  id: string;
  kind: 'agent' | 'artifact' | 'decision' | 'output' | 'loop' | 'team' | 'join';
  label: string;
  nodeId?: string;
  executionIds: string[];
  artifactVersionId?: string;
  status: string;
  recordedAt: string | null;
  /** Only current bodies are openable; old artifact nodes retain metadata alone. */
  current: boolean;
}
export interface RunFlowEdge {
  id: string;
  from: string;
  to: string;
  kind:
    | 'author'
    | 'read'
    | 'input'
    | 'question'
    | 'answer'
    | 'delegate'
    | 'review'
    | 'branch'
    | 'output';
  eventIds: string[];
  executionIds: string[];
  artifactVersionIds: string[];
  recordedAt: string | null;
  observed: true;
}
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
  iterations: RunFlowIteration[];
  selectedIterationId: string | null;
  latestIterationId: string | null;
  /** Always the latest observed round, independent of the inspected round. */
  status: NonNullable<RunFlowIteration['outcome']> | 'active' | 'unrecorded';
}
export interface RunFlow {
  nodes: RunFlowNode[];
  edges: RunFlowEdge[];
  decisions: RunFlowDecision[];
  loops: RunFlowLoop[];
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
    const latest = iterations.at(-1);
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
    // The current entry: its rounds from the last first round on, in the order they opened.
    const order = projection?.loopIterations[node.id] ?? [];
    const first = order.findLastIndex((id) => projection?.iterations[id]?.no === 1);
    const entry = new Set(first < 0 ? [] : order.slice(first));
    const applied = (projection?.loopEscalations?.[node.id] ?? []).findLast((e) =>
      entry.has(e.iterationId),
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
        selectedIterationId: selected?.iterationId ?? null,
        latestIterationId: latest?.iterationId ?? null,
        status: latest ? (latest.outcome ?? 'active') : 'unrecorded',
      },
    ];
  });
}

/** Committed data paths only. No body lookup, timestamp matching or definition-edge inference. */
export function buildRunFlow(
  projection: RunProjection | null,
  events: readonly RunEvent[],
  definition: CorralDefinition,
  selectedIterations: Readonly<Record<string, string>> = {},
): RunFlow {
  const loops = selectRunFlowIterations(projection, definition, selectedIterations, events);
  if (!projection) return { nodes: [], edges: [], decisions: [], loops };
  const records = [
    ...new Map(
      events
        .filter((event) => event.runId === projection.runId)
        .map((event) => [event.eventId, event]),
    ).values(),
  ].sort((a, b) => a.runSeq - b.runSeq);
  const firstRecords = new Map<string, RunEvent>();
  const remember = (key: string, event: RunEvent) => {
    if (!firstRecords.has(key)) firstRecords.set(key, event);
  };
  for (const event of records) {
    switch (event.type) {
      case 'execution.created':
        remember(`node:${event.payload.nodeId}`, event);
        remember(`execution:${event.payload.executionId}`, event);
        break;
      case 'artifact.version_created':
        remember(`artifact:${event.payload.artifactVersionId}`, event);
        break;
      case 'artifact.read':
        remember(
          `read:${event.payload.consumerExecutionId}:${event.payload.resolvedVersionId}`,
          event,
        );
        break;
      case 'model.request_prepared':
        remember(`input:${event.payload.modelCallId}`, event);
        break;
      case 'message.question_created':
        remember(`question:${event.payload.questionId}`, event);
        break;
      case 'message.answer_committed':
        remember(`answer:${event.payload.questionId}`, event);
        break;
      case 'review.recorded':
        remember(`review:${event.payload.reviewVersionId}`, event);
        break;
      case 'output.finalized':
        remember(`output:${event.payload.nodeId}`, event);
        break;
      case 'loop.iteration_started':
        remember(`iteration:${event.payload.iterationId}`, event);
        break;
      case 'loop.iteration_finished':
        remember(`iteration-finished:${event.payload.iterationId}`, event);
        break;
    }
  }
  const selectedByLoop = new Map(loops.map((loop) => [loop.nodeId, loop.selectedIterationId]));
  const includesIteration = (
    iterationId: string | null,
    definedLoopId?: string | null,
  ): boolean => {
    if (!iterationId) return true;
    const loopId = projection.iterations[iterationId]?.loopNodeId ?? definedLoopId;
    return !loopId || !selectedByLoop.has(loopId) || selectedByLoop.get(loopId) === iterationId;
  };
  const includesExecution = (executionId: string): boolean => {
    const execution = projection.executions[executionId];
    return (
      !!execution &&
      includesIteration(
        runFlowExecutionIterationId(projection, executionId),
        runFlowExecutionLoopId(projection, definition, executionId),
      )
    );
  };
  const branches = new Map(Object.entries(projection.workflowBranches ?? {}));
  for (const event of records) {
    if (event.type === 'workflow.branch_selected')
      branches.set(event.eventId, {
        ...event.payload,
        eventId: event.eventId,
        recordedAt: event.recordedAt,
        runSeq: event.runSeq,
      });
  }
  const visibleBranches = [...branches.values()]
    .filter((branch) => {
      const node = definition.nodes.find((node) => node.id === branch.nodeId);
      return includesIteration(branch.iterationId, node?.parentId ?? null);
    })
    .sort((a, b) => a.runSeq - b.runSeq);
  const artifactIds = new Set(
    Object.values(projection.artifacts)
      .filter(
        (value) =>
          !projection.executions[value.authorExecutionId] ||
          includesExecution(value.authorExecutionId),
      )
      .map((value) => value.artifactVersionId),
  );
  // Include only directly observed inputs from other rounds, not their entire history.
  for (const [executionId, ids] of Object.entries(projection.artifactReads))
    if (includesExecution(executionId)) for (const id of ids) artifactIds.add(id);
  for (const call of Object.values(projection.modelCalls))
    if (includesExecution(call.executionId))
      for (const id of call.inputArtifactVersionIds) artifactIds.add(id);
  for (const question of Object.values(projection.questions)) {
    if (!includesExecution(question.senderExecutionId)) continue;
    for (const id of question.artifactRefs) artifactIds.add(id);
    if (question.answer && includesExecution(question.answer.responderExecutionId))
      for (const id of question.answer.evidenceRefs) artifactIds.add(id);
  }
  for (const branch of visibleBranches)
    for (const ref of branch.evidenceRefs)
      if (ref.kind === 'artifact' || ref.kind === 'review') artifactIds.add(ref.id);
  for (const review of Object.values(projection.reviews))
    if (artifactIds.has(review.reviewVersionId)) artifactIds.add(review.targetVersionId);
  for (const loop of loops) {
    const started = firstRecords.get(`iteration:${loop.selectedIterationId}`);
    if (started?.type === 'loop.iteration_started')
      for (const id of started.payload.pinnedCarryInputs) artifactIds.add(id);
  }
  for (const id of projection.output?.artifactVersionIds ?? []) artifactIds.add(id);
  const definitions = new Map(definition.nodes.map((node) => [node.id, node]));
  const nodes = new Map<string, RunFlowNode>();
  const edges = new Map<string, RunFlowEdge>();
  const decisions: RunFlowDecision[] = [];
  const nodeKey = (id: string) => `${definitions.get(id)?.type ?? 'agent'}:${id}`;
  const addNode = (id: string): string => {
    const key = nodeKey(id);
    if (!nodes.has(key)) {
      const node = definitions.get(id);
      const executions = projection.executionOrder.filter(
        (executionId) =>
          projection.executions[executionId]?.nodeId === id && includesExecution(executionId),
      );
      nodes.set(key, {
        id: key,
        kind: node?.type ?? 'agent',
        label: node?.label ?? id,
        nodeId: id,
        executionIds: executions,
        status: executions.length ? nodeRunSummary(projection, id).status : 'unrecorded',
        recordedAt:
          executions
            .map((executionId) => firstRecords.get(`execution:${executionId}`)?.recordedAt)
            .find((recordedAt) => recordedAt !== undefined) ?? null,
        current: false,
      });
    }
    return key;
  };
  const agent = (executionId: string): string | null => {
    const execution = projection.executions[executionId];
    return execution && includesExecution(executionId) ? addNode(execution.nodeId) : null;
  };
  const artifact = (id: string): string | null =>
    projection.artifacts[id] ? `artifact:${id}` : null;
  const addEdge = (
    kind: RunFlowEdge['kind'],
    from: string | null,
    to: string | null,
    event: Pick<RunEvent, 'eventId' | 'recordedAt'> | undefined,
    executionIds: string[] = [],
    artifactVersionIds: string[] = [],
  ) => {
    if (!from || !to || !nodes.has(from) || !nodes.has(to)) return;
    const id = `${kind}:${from}:${to}`;
    const old = edges.get(id);
    edges.set(id, {
      id,
      kind,
      from,
      to,
      observed: true,
      eventIds: [...new Set([...(old?.eventIds ?? []), ...(event ? [event.eventId] : [])])],
      recordedAt: old?.recordedAt ?? event?.recordedAt ?? null,
      executionIds: [...new Set([...(old?.executionIds ?? []), ...executionIds])],
      artifactVersionIds: [...new Set([...(old?.artifactVersionIds ?? []), ...artifactVersionIds])],
    });
  };

  for (const id of projection.executionOrder) agent(id);
  for (const value of Object.values(projection.artifacts)) {
    if (!artifactIds.has(value.artifactVersionId)) continue;
    const created = firstRecords.get(`artifact:${value.artifactVersionId}`);
    nodes.set(`artifact:${value.artifactVersionId}`, {
      id: `artifact:${value.artifactVersionId}`,
      kind: 'artifact',
      label: value.name,
      artifactVersionId: value.artifactVersionId,
      executionIds: [value.authorExecutionId],
      status: projection.output?.artifactVersionIds.includes(value.artifactVersionId)
        ? 'final'
        : value.submitted
          ? 'submitted'
          : 'created',
      recordedAt: created?.recordedAt ?? null,
      current: canReadArtifactBody(projection, value.artifactVersionId),
    });
    addEdge(
      'author',
      agent(value.authorExecutionId),
      artifact(value.artifactVersionId),
      created,
      [value.authorExecutionId],
      [value.artifactVersionId],
    );
  }

  for (const [executionId, ids] of Object.entries(projection.artifactReads)) {
    for (const id of ids) {
      const read = firstRecords.get(`read:${executionId}:${id}`);
      addEdge('read', artifact(id), agent(executionId), read, [executionId], [id]);
    }
  }
  for (const call of Object.values(projection.modelCalls)) {
    const prepared = firstRecords.get(`input:${call.modelCallId}`);
    for (const id of call.inputArtifactVersionIds)
      addEdge('input', artifact(id), agent(call.executionId), prepared, [call.executionId], [id]);
  }
  const responseTasks = new Set(
    Object.values(projection.questions)
      .filter((q) => q.delivery !== 'parent')
      .map((q) => q.taskId),
  );
  for (const execution of Object.values(projection.executions)) {
    if (!execution.parentExecutionId || responseTasks.has(execution.taskId)) continue;
    const created = firstRecords.get(`execution:${execution.executionId}`);
    addEdge('delegate', agent(execution.parentExecutionId), agent(execution.executionId), created, [
      execution.parentExecutionId,
      execution.executionId,
    ]);
  }
  for (const question of Object.values(projection.questions)) {
    if (!includesExecution(question.senderExecutionId)) continue;
    const created = firstRecords.get(`question:${question.questionId}`);
    const target = question.targetExecutionId
      ? agent(question.targetExecutionId)
      : definitions.has(question.targetNodeId)
        ? addNode(question.targetNodeId)
        : null;
    addEdge(
      'question',
      agent(question.senderExecutionId),
      target,
      created,
      [
        question.senderExecutionId,
        ...(question.targetExecutionId ? [question.targetExecutionId] : []),
      ],
      question.artifactRefs,
    );
    if (question.answer) {
      const answered = firstRecords.get(`answer:${question.questionId}`);
      addEdge(
        'answer',
        agent(question.answer.responderExecutionId),
        agent(question.senderExecutionId),
        answered,
        [question.answer.responderExecutionId, question.senderExecutionId],
        question.answer.evidenceRefs,
      );
    }
  }
  for (const review of Object.values(projection.reviews)) {
    const recorded = firstRecords.get(`review:${review.reviewVersionId}`);
    addEdge(
      'review',
      artifact(review.targetVersionId),
      artifact(review.reviewVersionId),
      recorded,
      [],
      [review.targetVersionId, review.reviewVersionId],
    );
  }
  for (const loop of loops) {
    const key = addNode(loop.nodeId);
    const node = nodes.get(key);
    const started = firstRecords.get(`iteration:${loop.selectedIterationId}`);
    const latest = loop.iterations.at(-1);
    if (node) {
      node.status = loop.status;
      node.recordedAt = latest?.finishedAt ?? latest?.startedAt ?? null;
      node.executionIds = projection.executionOrder.filter(
        (id) =>
          loop.selectedIterationId !== null &&
          runFlowExecutionIterationId(projection, id) === loop.selectedIterationId,
      );
    }
    if (started?.type === 'loop.iteration_started')
      for (const id of started.payload.pinnedCarryInputs)
        addEdge('input', artifact(id), key, started, node?.executionIds, [id]);
  }
  for (const branch of visibleBranches) {
    const key = addNode(branch.nodeId);
    const node = nodes.get(key);
    if (node) {
      node.status = branch.selectedPort;
      node.recordedAt = branch.recordedAt;
    }
    const review = branch.evidenceRefs
      .flatMap((ref) => (ref.kind === 'review' ? (projection.reviews[ref.id] ?? []) : []))
      .at(-1);
    decisions.push({
      id: branch.eventId,
      nodeId: branch.nodeId,
      iterationId: branch.iterationId,
      selectedPort: branch.selectedPort,
      targetNodeId: branch.targetNodeId,
      targetPort: branch.targetPort,
      reasonCode: branch.reasonCode,
      evidenceRefs: branch.evidenceRefs,
      status: 'observed',
      recordedAt: branch.recordedAt,
      configRevision: branch.configRevision,
      ...(review ? { reviewVerdict: review.verdict } : {}),
      issues: review?.issues.map((issue) => issue.reason) ?? [],
    });
    for (const ref of branch.evidenceRefs) {
      if (ref.kind === 'artifact' || ref.kind === 'review')
        addEdge(
          ref.kind === 'review' ? 'review' : 'input',
          artifact(ref.id),
          key,
          branch,
          branch.executionRefs.map((ref) => ref.executionId),
          [ref.id],
        );
    }
    if (branch.targetNodeId && definitions.has(branch.targetNodeId))
      addEdge(
        'branch',
        key,
        addNode(branch.targetNodeId),
        branch,
        branch.executionRefs.map((ref) => ref.executionId),
      );
  }
  for (const node of definition.nodes) {
    if (node.type !== 'decision' || decisions.some((decision) => decision.nodeId === node.id))
      continue;
    addNode(node.id);
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
  if (projection.output) {
    const output = addNode(projection.output.nodeId);
    const node = nodes.get(output);
    if (node) node.status = 'final';
    const finalized = firstRecords.get(`output:${projection.output.nodeId}`);
    for (const id of projection.output.artifactVersionIds)
      addEdge('output', artifact(id), output, finalized, [], [id]);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], decisions, loops };
}
