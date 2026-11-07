import {
  type CorralDefinition,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { currentAttempts, type NodeRunSummary, nodeRunSummary } from './selectors.ts';

export interface RunAgentGraphNode {
  id: string;
  label: string;
  executionIds: string[];
  summary: NodeRunSummary;
  lead: boolean;
}

export interface RunAgentGraphRelation {
  id: string;
  source: string;
  target: string;
  kind: 'delegate' | 'question' | 'answer' | 'read' | 'input';
  count: number;
  activeCount: number;
  executionIds: string[];
  artifactVersionIds: string[];
}

export interface RunAgentGraph {
  nodes: RunAgentGraphNode[];
  relations: RunAgentGraphRelation[];
}

/** Observed agent relationships across the run; no definition paths or artifact bodies. */
export function buildRunAgentGraph(
  projection: RunProjection | null,
  definition: CorralDefinition,
): RunAgentGraph {
  if (!projection) return { nodes: [], relations: [] };
  const definitions = new Map(
    definition.nodes.filter((node) => node.type === 'agent').map((node) => [node.id, node]),
  );
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  const questions = Object.values(projection.questions);
  const responders = new Set(
    questions
      .filter((question) => question.delivery !== 'parent')
      .map((question) => question.taskId),
  );
  const running = !TERMINAL_RUN_STATUSES.has(projection.status);
  const nodes = new Map<string, RunAgentGraphNode>();
  const addNode = (id: string): string | null => {
    const node = definitions.get(id);
    if (!node) return null;
    if (!nodes.has(id)) {
      const instances = executions.filter((execution) => execution.nodeId === id);
      nodes.set(id, {
        id,
        label: node.label,
        executionIds: instances.map((execution) => execution.executionId),
        summary: nodeRunSummary(projection, id),
        lead: instances.some(
          (execution) => !execution.parentExecutionId && !responders.has(execution.taskId),
        ),
      });
    }
    return id;
  };
  const agent = (executionId: string): string | null => {
    const execution = projection.executions[executionId];
    return execution ? addNode(execution.nodeId) : null;
  };
  for (const execution of executions) addNode(execution.nodeId);
  const relations = new Map<string, RunAgentGraphRelation>();
  const counted = new Map<string, Set<string>>();
  const active = new Map<string, Set<string>>();
  const add = (
    kind: RunAgentGraphRelation['kind'],
    source: string | null,
    target: string | null,
    recordId: string,
    inProgress: boolean,
    executionIds: string[],
    artifactVersionIds: string[] = [],
  ) => {
    if (!source || !target) return;
    const id = JSON.stringify([kind, source, target]);
    const relation = relations.get(id) ?? {
      id,
      source,
      target,
      kind,
      count: 0,
      activeCount: 0,
      executionIds: [],
      artifactVersionIds: [],
    };
    const records = counted.get(id) ?? new Set<string>();
    records.add(recordId);
    counted.set(id, records);
    const progressing = active.get(id) ?? new Set<string>();
    if (running && inProgress) progressing.add(recordId);
    active.set(id, progressing);
    relation.count = records.size;
    relation.activeCount = progressing.size;
    relation.executionIds = [
      ...new Set([
        ...relation.executionIds,
        ...executionIds.filter((value) => projection.executions[value]),
      ]),
    ];
    relation.artifactVersionIds = [
      ...new Set([...relation.artifactVersionIds, ...artifactVersionIds]),
    ];
    relations.set(id, relation);
  };
  const current = new Set(
    currentAttempts(projection, executions).map((execution) => execution.executionId),
  );
  for (const execution of executions) {
    if (!execution.parentExecutionId || responders.has(execution.taskId)) continue;
    add(
      'delegate',
      agent(execution.parentExecutionId),
      agent(execution.executionId),
      execution.taskId,
      current.has(execution.executionId) && !TERMINAL_EXECUTION_STATUSES.has(execution.status),
      [execution.parentExecutionId, execution.executionId],
    );
  }
  for (const question of questions) {
    const source = agent(question.senderExecutionId);
    if (!source) continue;
    const target = question.targetExecutionId
      ? agent(question.targetExecutionId)
      : addNode(question.targetNodeId);
    add(
      'question',
      source,
      target,
      question.questionId,
      question.status === 'open',
      [
        question.senderExecutionId,
        ...(question.targetExecutionId ? [question.targetExecutionId] : []),
        ...executions
          .filter(
            (execution) => execution.taskId === question.taskId && execution.nodeId === target,
          )
          .map((execution) => execution.executionId),
      ],
      question.artifactRefs,
    );
    if (question.answer)
      add(
        'answer',
        agent(question.answer.responderExecutionId),
        source,
        question.questionId,
        false,
        [question.answer.responderExecutionId, question.senderExecutionId],
        question.answer.evidenceRefs,
      );
  }
  const delivery = (kind: 'read' | 'input', executionId: string, versionId: string) => {
    const artifact = projection.artifacts[versionId];
    if (!artifact) return;
    add(
      kind,
      agent(artifact.authorExecutionId),
      agent(executionId),
      versionId,
      false,
      [artifact.authorExecutionId, executionId],
      [versionId],
    );
  };
  for (const [executionId, versions] of Object.entries(projection.artifactReads))
    for (const versionId of versions) delivery('read', executionId, versionId);
  for (const call of Object.values(projection.modelCalls))
    for (const versionId of call.inputArtifactVersionIds)
      delivery('input', call.executionId, versionId);
  return { nodes: [...nodes.values()], relations: [...relations.values()] };
}
