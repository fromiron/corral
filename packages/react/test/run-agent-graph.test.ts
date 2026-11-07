import type {
  ArtifactVersionView,
  ExecutionView,
  ModelCallView,
  QuestionView,
  RunProjection,
} from '@corral/core';
import { describe, expect, it } from 'vitest';
import { buildRunAgentGraph } from '../src/run/agent-graph.ts';
import { projectionWith, researchTeamDraft } from '../src/stories/fixtures.tsx';

const definition = researchTeamDraft().definition;

function execution(
  executionId: string,
  nodeId: string,
  change: Partial<ExecutionView> = {},
): ExecutionView {
  return {
    executionId,
    nodeId,
    taskId: `task_${executionId}`,
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'succeeded',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
    ...change,
  };
}

function projection(
  executions: ExecutionView[],
  change: Partial<RunProjection> = {},
): RunProjection {
  const nodeExecutions: Record<string, string[]> = {};
  for (const value of executions) {
    const ids = nodeExecutions[value.nodeId] ?? [];
    ids.push(value.executionId);
    nodeExecutions[value.nodeId] = ids;
  }
  return projectionWith({
    executions: Object.fromEntries(executions.map((value) => [value.executionId, value])),
    executionOrder: executions.map((value) => value.executionId),
    nodeExecutions,
    ...change,
  });
}

function artifact(id: string, authorExecutionId: string): ArtifactVersionView {
  return {
    artifactVersionId: id,
    artifactId: 'artifact',
    version: 1,
    parentVersionId: null,
    name: id,
    contract: 'draft',
    contentHash: `hash-${id}`,
    byteLength: 10,
    authorExecutionId,
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
    bodyAvailable: false,
  };
}

function modelCall(id: string, executionId: string, inputs: string[]): ModelCallView {
  return {
    modelCallId: id,
    executionId,
    contextSnapshotId: `context_${id}`,
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: inputs,
    finished: true,
    usage: null,
    rawUsage: null,
    certainty: null,
  };
}

function question(id: string, change: Partial<QuestionView> = {}): QuestionView {
  return {
    questionId: id,
    taskId: `answer_${id}`,
    senderExecutionId: 'writer',
    targetNodeId: 'respond',
    targetRoleId: 'researcher',
    body: 'Private question body',
    artifactRefs: [],
    deadline: '2026-11-07T00:00:00.000Z',
    status: 'open',
    answer: null,
    ...change,
  };
}

const sorted = (values: string[]) => [...values].sort();

describe('run agent relationship graph', () => {
  it('is empty without observations, even when the definition contains paths and roles', () => {
    expect(buildRunAgentGraph(null, definition)).toEqual({ nodes: [], relations: [] });
    expect(buildRunAgentGraph(projection([]), definition)).toEqual({ nodes: [], relations: [] });
  });

  it('groups retries and rounds by node ID while keeping distinct nodes with the same role', () => {
    const p = projection([
      execution('root', 'research', { status: 'active' }),
      execution('first', 'write', {
        taskId: 'draft',
        parentExecutionId: 'root',
        status: 'failed',
        iterationId: 'round_1',
      }),
      execution('retry', 'write', {
        taskId: 'draft',
        parentExecutionId: 'root',
        previousExecutionId: 'first',
        attemptNo: 2,
        status: 'succeeded',
        iterationId: 'round_2',
      }),
      // research and respond share a role but are distinct actual nodes.
      execution('responder', 'respond', { parentExecutionId: 'root' }),
    ]);
    const graph = buildRunAgentGraph(p, definition);
    expect(sorted(graph.nodes.map((node) => node.id))).toEqual(['research', 'respond', 'write']);
    const writer = graph.nodes.find((node) => node.id === 'write');
    expect(writer).toMatchObject({
      label: definition.nodes.find((node) => node.id === 'write')?.label,
      summary: { status: 'done', counts: { done: 1 }, previousFailures: 1 },
      lead: false,
    });
    expect(sorted(writer?.executionIds ?? [])).toEqual(['first', 'retry']);
    expect(graph.nodes.find((node) => node.id === 'research')?.lead).toBe(true);
    expect(graph.nodes.find((node) => node.id === 'respond')?.executionIds).toEqual(['responder']);
    expect(graph.nodes.map((node) => node.id)).not.toContain('review_loop');
  });

  it('counts each delegation once across attempts, preserving every participating execution', () => {
    const p = projection([
      execution('root', 'research', { status: 'active' }),
      execution('first', 'helper', { taskId: 'work', parentExecutionId: 'root', status: 'failed' }),
      execution('retry', 'helper', {
        taskId: 'work',
        parentExecutionId: 'root',
        previousExecutionId: 'first',
        attemptNo: 2,
        status: 'active',
      }),
      execution('other', 'helper', {
        taskId: 'other',
        parentExecutionId: 'root',
        status: 'cancelled',
      }),
    ]);
    const relations = buildRunAgentGraph(p, definition).relations;
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      kind: 'delegate',
      source: 'research',
      target: 'helper',
      count: 2,
      activeCount: 1,
      artifactVersionIds: [],
    });
    expect(sorted(relations[0]?.executionIds ?? [])).toEqual(['first', 'other', 'retry', 'root']);
    expect(relations[0]?.id).toBeTruthy();
  });

  it('shows an unstarted question target as requested and does not fabricate an execution', () => {
    const p = projection([execution('writer', 'write', { status: 'waiting_message' })], {
      questions: { q: question('q') },
    });
    const graph = buildRunAgentGraph(p, definition);
    expect(sorted(graph.nodes.map((node) => node.id))).toEqual(['respond', 'write']);
    expect(graph.nodes.find((node) => node.id === 'respond')).toMatchObject({
      executionIds: [],
      summary: { status: 'idle', counts: {}, previousFailures: 0 },
      lead: false,
    });
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0]).toMatchObject({
      kind: 'question',
      source: 'write',
      target: 'respond',
      count: 1,
      activeCount: 1,
      executionIds: ['writer'],
      artifactVersionIds: [],
    });
  });

  it('counts questions and answers in opposite directions without counting answer tasks as delegation', () => {
    const p = projection(
      [
        execution('writer', 'write', { status: 'waiting_message' }),
        execution('reply_old', 'respond', {
          taskId: 'answer_q1',
          parentExecutionId: 'writer',
          status: 'failed',
        }),
        execution('reply', 'respond', {
          taskId: 'answer_q1',
          parentExecutionId: 'writer',
          previousExecutionId: 'reply_old',
          attemptNo: 2,
        }),
      ],
      {
        questions: {
          q1: question('q1', {
            status: 'answered',
            answer: { responderExecutionId: 'reply', body: 'Private answer', evidenceRefs: [] },
          }),
          q2: question('q2'),
        },
      },
    );
    const relations = buildRunAgentGraph(p, definition).relations;
    expect(relations).toHaveLength(2);
    const asked = relations.find((relation) => relation.kind === 'question');
    const answered = relations.find((relation) => relation.kind === 'answer');
    expect(asked).toMatchObject({ source: 'write', target: 'respond', count: 2, activeCount: 1 });
    expect(answered).toMatchObject({
      source: 'respond',
      target: 'write',
      count: 1,
      activeCount: 0,
    });
    expect(sorted(asked?.executionIds ?? [])).toEqual(['reply', 'reply_old', 'writer']);
    expect(sorted(answered?.executionIds ?? [])).toEqual(['reply', 'writer']);
    expect(new Set(relations.map((relation) => relation.id)).size).toBe(2);
  });

  it('keeps parent-directed questions and the actual parent answer without suppressing its delegation', () => {
    const p = projection(
      [
        execution('parent', 'research', { status: 'active' }),
        execution('child', 'helper', { parentExecutionId: 'parent', status: 'active' }),
      ],
      {
        questions: {
          parent_question: question('parent_question', {
            delivery: 'parent',
            senderExecutionId: 'child',
            targetNodeId: 'research',
            targetExecutionId: 'parent',
            taskId: 'task_parent',
            status: 'answered',
            answer: { responderExecutionId: 'parent', body: 'Answer', evidenceRefs: [] },
          }),
        },
      },
    );
    const relations = buildRunAgentGraph(p, definition).relations;
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'delegate',
          source: 'research',
          target: 'helper',
          count: 1,
        }),
        expect.objectContaining({
          kind: 'question',
          source: 'helper',
          target: 'research',
          count: 1,
        }),
        expect.objectContaining({ kind: 'answer', source: 'research', target: 'helper', count: 1 }),
      ]),
    );
    for (const relation of relations)
      expect(sorted(relation.executionIds)).toEqual(['child', 'parent']);
  });

  it('retains a recorded question but does not invent an answer endpoint for a missing execution', () => {
    const p = projection([execution('writer', 'write')], {
      questions: {
        q: question('q', {
          status: 'answered',
          answer: { responderExecutionId: 'missing', body: 'Answer', evidenceRefs: [] },
        }),
      },
    });
    const graph = buildRunAgentGraph(p, definition);
    expect(sorted(graph.nodes.map((node) => node.id))).toEqual(['respond', 'write']);
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0]).toMatchObject({
      kind: 'question',
      source: 'write',
      target: 'respond',
      count: 1,
      activeCount: 0,
      executionIds: ['writer'],
    });
  });

  it('deduplicates reads and model inputs separately per pair and artifact version, preserving participants', () => {
    const p = projection(
      [
        execution('author', 'research'),
        execution('reader1', 'write'),
        execution('reader2', 'write'),
      ],
      {
        artifacts: { v1: artifact('v1', 'author'), v2: artifact('v2', 'author') },
        artifactReads: { reader1: ['v1', 'v1', 'v2'], reader2: ['v1'] },
        modelCalls: {
          call1: modelCall('call1', 'reader1', ['v1', 'v1']),
          call2: modelCall('call2', 'reader2', ['v1', 'v2']),
        },
      },
    );
    const relations = buildRunAgentGraph(p, definition).relations;
    expect(relations).toHaveLength(2);
    for (const kind of ['read', 'input'] as const) {
      const relation = relations.find((value) => value.kind === kind);
      expect(relation).toMatchObject({
        source: 'research',
        target: 'write',
        count: 2,
        activeCount: 0,
      });
      expect(sorted(relation?.artifactVersionIds ?? [])).toEqual(['v1', 'v2']);
      expect(sorted(relation?.executionIds ?? [])).toEqual(['author', 'reader1', 'reader2']);
    }
    expect(new Set(relations.map((relation) => relation.id)).size).toBe(2);
  });

  it('retains recorded self-relations between different executions of one agent', () => {
    const p = projection(
      [
        execution('earlier', 'write'),
        execution('later', 'write', { parentExecutionId: 'earlier' }),
        execution('reply', 'write', { taskId: 'answer_self', parentExecutionId: 'earlier' }),
      ],
      {
        artifacts: { v1: artifact('v1', 'earlier') },
        artifactReads: { later: ['v1'] },
        modelCalls: { call: modelCall('call', 'later', ['v1']) },
        questions: {
          self: question('self', {
            taskId: 'answer_self',
            senderExecutionId: 'earlier',
            targetNodeId: 'write',
            status: 'answered',
            answer: { responderExecutionId: 'reply', body: 'Answer', evidenceRefs: [] },
          }),
        },
      },
    );
    const relations = buildRunAgentGraph(p, definition).relations;
    expect(relations.map((relation) => relation.kind).sort()).toEqual([
      'answer',
      'delegate',
      'input',
      'question',
      'read',
    ]);
    for (const relation of relations) {
      expect(relation).toMatchObject({ source: 'write', target: 'write', count: 1 });
      expect(sorted(relation.executionIds)).toEqual(
        relation.kind === 'answer' || relation.kind === 'question'
          ? ['earlier', 'reply']
          : ['earlier', 'later'],
      );
    }
  });

  it('does not infer delivery from artifact creation, success, definition paths, or missing endpoints', () => {
    const p = projection(
      [
        execution('author', 'research'),
        execution('writer', 'write'),
        execution('orphan_child', 'helper', { parentExecutionId: 'missing' }),
        execution('removed', 'removed_node', { parentExecutionId: 'author' }),
        execution('decision', 'review_decision', { parentExecutionId: 'author' }),
      ],
      {
        artifacts: {
          created: artifact('created', 'author'),
          orphan: artifact('orphan', 'missing'),
        },
        artifactReads: { writer: ['orphan', 'missing_artifact'], missing: ['created'] },
        modelCalls: { missing: modelCall('missing', 'missing', ['created']) },
        questions: {
          missing_sender: question('missing_sender', { senderExecutionId: 'missing' }),
          missing_target: question('missing_target', { targetNodeId: 'removed_node' }),
        },
      },
    );
    const graph = buildRunAgentGraph(p, definition);
    expect(sorted(graph.nodes.map((node) => node.id))).toEqual(['helper', 'research', 'write']);
    expect(graph.relations).toEqual([]);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'keeps unsettled relation metadata but clears progress when the run is %s',
    (status) => {
      const p = projection(
        [
          execution('root', 'research', { status: 'active' }),
          execution('helper', 'helper', { parentExecutionId: 'root', status: 'active' }),
        ],
        { status, questions: { q: question('q', { senderExecutionId: 'root' }) } },
      );
      const relations = buildRunAgentGraph(p, definition).relations;
      expect(relations).toHaveLength(2);
      expect(relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'delegate', count: 1, activeCount: 0 }),
          expect.objectContaining({ kind: 'question', count: 1, activeCount: 0 }),
        ]),
      );
      expect(relations.flatMap((relation) => relation.executionIds)).toContain('root');
    },
  );
});
