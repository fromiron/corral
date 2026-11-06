import { type ExecutionView, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { sessionStore } from './fixtures.tsx';

export function loopFlowFixture(count = 100, loadArtifact: () => Promise<void> = async () => {}) {
  const definition = linearCorral(['writer']);
  definition.nodes = definition.nodes.map((node) =>
    node.id === 'writer' ? { ...node, loopId: 'review_loop' } : node,
  );
  definition.nodes.push(
    { id: 'review_loop', type: 'loop', label: 'Review', maxIterations: 3 },
    {
      id: 'gate',
      type: 'decision',
      label: 'Review gate',
      loopId: 'review_loop',
      mode: 'rule',
      rule: 'required_tasks_submitted',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
    },
  );
  definition.controlEdges.push(
    { id: 'again', source: 'gate', sourcePort: 'no', target: 'review_loop', targetPort: 'repeat' },
    {
      id: 'finished',
      source: 'gate',
      sourcePort: 'yes',
      target: 'review_loop',
      targetPort: 'exit',
    },
  );
  const projection = emptyProjection('run_loop');
  projection.status = 'succeeded';
  projection.loopIterations.review_loop = [];
  projection.nodeExecutions.writer = [];
  projection.workflowBranches = {};
  // Stress old/externally supplied metadata; this does not raise the engine's maxIterations.
  for (let no = 1; no <= count; no++) {
    const iterationId = `round_${no}`,
      executionId = `writer_${no}`,
      artifactVersionId = `draft_${no}`;
    projection.loopIterations.review_loop.push(iterationId);
    projection.iterations[iterationId] = {
      iterationId,
      loopNodeId: 'review_loop',
      no,
      criteriaVersionId: 'criteria',
      outcome: no === count ? 'pass' : 'revise',
    };
    const execution: ExecutionView = {
      executionId,
      nodeId: 'writer',
      taskId: `task_${no}`,
      attemptNo: 1,
      parentExecutionId: null,
      previousExecutionId: null,
      depth: 0,
      iterationId,
      modelProfile: 'model-a',
      configRevision: 0,
      criteriaVersionId: 'criteria',
      status: 'succeeded',
      activity: null,
      waitingOn: null,
      modelCallIds: [],
      error: null,
    };
    projection.executions[executionId] = execution;
    projection.executionOrder.push(executionId);
    projection.nodeExecutions.writer.push(executionId);
    projection.artifacts[artifactVersionId] = {
      artifactVersionId,
      artifactId: 'draft',
      name: `Draft round ${no}`,
      version: no,
      parentVersionId: no > 1 ? `draft_${no - 1}` : null,
      contract: 'text',
      contentHash: `hash${no}`,
      byteLength: 20,
      authorExecutionId: executionId,
      modelCallId: null,
      contextSnapshotId: null,
      submitted: true,
      configRevision: 0,
      criteriaVersionId: 'criteria',
      inputArtifactVersionIds: [],
    };
    projection.workflowBranches[`branch_${no}`] = {
      eventId: `branch_${no}`,
      recordedAt: '2026-11-06T10:00:00.000Z',
      runSeq: no,
      nodeId: 'gate',
      mode: 'rule',
      iterationId,
      configRevision: 0,
      selectedPort: no === count ? 'yes' : 'no',
      targetNodeId: 'review_loop',
      targetPort: no === count ? 'exit' : 'repeat',
      reasonCode: no === count ? 'required_tasks_completed' : 'tasks_unfinished',
      evidenceRefs: [{ kind: 'artifact', id: artifactVersionId }],
      executionRefs: [{ executionId, attemptNo: 1 }],
    };
  }
  projection.output = { nodeId: 'output', artifactVersionIds: [`draft_${count}`] };
  return {
    definition,
    projection,
    loadArtifact,
    session: sessionStore({ definition, projection, runId: projection.runId, loadArtifact }),
  };
}
