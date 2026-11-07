import type { QuestionView, RunProjection } from '@corral/core';

/** Something one execution handed on, as recorded: a version it wrote, or a question it sent. */
export type ExecutionHandoff =
  | { kind: 'artifact'; id: string; name: string; version: number; targets: string[] }
  | { kind: 'question'; id: string; targets: string[]; status: QuestionView['status'] };

/**
 * What an execution sent, named by the receiving agents' node ids. Only recorded reads, model
 * inputs and questions count; the receiver's own card never repeats them.
 */
export function executionHandoffs(
  projection: RunProjection,
  executionId: string,
): ExecutionHandoff[] {
  const nodeOf = (id: string) => projection.executions[id]?.nodeId;
  const unique = (ids: (string | undefined)[]) => [
    ...new Set(ids.filter((id): id is string => !!id)),
  ];
  const consumers = new Map<string, string[]>();
  const consume = (versionId: string, consumer: string) => {
    if (consumer === executionId) return;
    consumers.set(versionId, [...(consumers.get(versionId) ?? []), consumer]);
  };
  for (const [reader, versions] of Object.entries(projection.artifactReads))
    for (const versionId of versions) consume(versionId, reader);
  for (const call of Object.values(projection.modelCalls))
    for (const versionId of call.inputArtifactVersionIds) consume(versionId, call.executionId);
  const artifacts: ExecutionHandoff[] = Object.values(projection.artifacts)
    .filter((artifact) => artifact.authorExecutionId === executionId)
    .map((artifact) => ({
      kind: 'artifact',
      id: artifact.artifactVersionId,
      name: artifact.name,
      version: artifact.version,
      targets: unique((consumers.get(artifact.artifactVersionId) ?? []).map(nodeOf)),
    }));
  const questions: ExecutionHandoff[] = Object.values(projection.questions)
    .filter((question) => question.senderExecutionId === executionId)
    .map((question) => ({
      kind: 'question',
      id: question.questionId,
      targets: unique([
        question.targetExecutionId ? nodeOf(question.targetExecutionId) : question.targetNodeId,
      ]),
      status: question.status,
    }));
  return [...artifacts, ...questions];
}
