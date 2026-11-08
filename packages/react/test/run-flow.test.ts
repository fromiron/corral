import { type CorralDefinition, type EventOf, RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection, type RunProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  buildRunFlow,
  runFlowExecutionIterationId,
  selectRunFlowIterations,
} from '../src/run/flow.ts';

const RUN = 'flow_run';
function event<K extends RunEvent['type']>(
  seq: number,
  type: K,
  payload: EventOf<K>['payload'],
): EventOf<K> {
  return RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${seq}`,
    runId: RUN,
    runSeq: seq,
    recordedAt: new Date(Date.UTC(2026, 10, 6, 0, 0, seq)).toISOString(),
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type,
    payload,
  }) as EventOf<K>;
}
const created = (seq: number, id: string, nodeId: string) =>
  event(seq, 'execution.created', {
    executionId: id,
    nodeId,
    taskId: `task_${id}`,
    attemptNo: 1,
    parentExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
  });
const artifact = (seq: number, id: string, author: string) =>
  event(seq, 'artifact.version_created', {
    artifactId: `artifact_${id}`,
    artifactVersionId: id,
    name: id,
    version: 1,
    parentVersionId: null,
    authorExecutionId: author,
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 10,
    modelCallId: null,
    contextSnapshotId: null,
  });
const fixture = (): RunEvent[] => [
  created(1, 'research_1', 'research'),
  created(2, 'write_1', 'writer'),
  artifact(3, 'notes', 'research_1'),
  event(4, 'artifact.read', {
    requestedRef: 'notes',
    resolvedVersionId: 'notes',
    consumerExecutionId: 'write_1',
  }),
  event(5, 'model.request_prepared', {
    executionId: 'write_1',
    modelCallId: 'call_write',
    contextSnapshotId: 'context_write',
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: ['notes'],
  }),
  artifact(6, 'report', 'write_1'),
  event(7, 'output.finalized', {
    nodeId: 'output',
    artifactVersionIds: ['report'],
    approvalId: null,
  }),
];

function loopFixture(rounds: number) {
  const definition = linearCorral(['writer']);
  definition.nodes.push(
    { id: 'loop', type: 'loop', label: 'Review loop', maxIterations: 10 },
    {
      id: 'gate',
      type: 'decision',
      label: 'Review gate',
      mode: 'rule',
      rule: 'required_tasks_submitted',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
    },
  );
  definition.nodes = definition.nodes.map((node) =>
    node.id === 'writer' || node.id === 'gate' ? { ...node, parentId: 'loop' } : node,
  );
  let projection: RunProjection = emptyProjection(RUN);
  for (let no = 1; no <= rounds; no++) {
    const executionId = `writer_${no}`;
    const iterationId = `iteration_${no}`;
    const seq = projection.lastSeq;
    projection = applyEvent(projection, {
      ...created(seq + 1, executionId, 'writer'),
      payload: { ...created(seq + 1, executionId, 'writer').payload, iterationId },
    });
    projection = applyEvent(projection, artifact(seq + 2, `draft_${no}`, executionId));
    projection = applyEvent(
      projection,
      event(seq + 3, 'workflow.branch_selected', {
        nodeId: 'gate',
        mode: 'rule',
        iterationId,
        configRevision: 0,
        selectedPort: 'revise',
        targetNodeId: 'loop',
        targetPort: 'repeat',
        reasonCode: 'tasks_unfinished',
        evidenceRefs: [{ kind: 'artifact', id: `draft_${no}` }],
        executionRefs: [{ executionId, attemptNo: 1 }],
      }),
    );
    // Synthetic observation-volume stress data; the executable definition remains capped at 10.
    projection.iterations[iterationId] = {
      iterationId,
      loopNodeId: 'loop',
      no,
      criteriaVersionId: 'criteria',
      outcome: no === rounds ? null : 'revise',
    };
    projection.loopIterations.loop = [...(projection.loopIterations.loop ?? []), iterationId];
  }
  return { projection, definition };
}

describe('observed Run flow', () => {
  it('keeps 100 observed rounds in one loop group with only the selected round details', () => {
    const { projection, definition } = loopFixture(100);
    const flow = buildRunFlow(projection, [], definition);
    expect(flow.loops).toHaveLength(1);
    expect(flow.loops[0]).toMatchObject({
      nodeId: 'loop',
      maxIterations: 10,
      latestIterationId: 'iteration_100',
      selectedIterationId: 'iteration_100',
      status: 'active',
    });
    expect(flow.loops[0]?.iterations).toHaveLength(100);
    expect(flow.nodes.filter((node) => node.kind === 'loop')).toHaveLength(1);
    expect(
      flow.nodes.filter((node) => node.kind === 'artifact').map((node) => node.artifactVersionId),
    ).toEqual(['draft_100']);
    expect(flow.nodes.find((node) => node.id === 'agent:writer')?.executionIds).toEqual([
      'writer_100',
    ]);
    expect(flow.decisions.map((decision) => decision.iterationId)).toEqual(['iteration_100']);
    const previous = buildRunFlow(projection, [], definition, { loop: 'iteration_2' });
    expect(
      previous.nodes
        .filter((node) => node.kind === 'artifact')
        .map((node) => node.artifactVersionId),
    ).toEqual(['draft_2']);
    expect(previous.decisions.map((decision) => decision.iterationId)).toEqual(['iteration_2']);
    expect(previous.loops[0]?.status).toBe('active');
    expect(projection.executionOrder).toHaveLength(100);
  });

  it('keeps a selected round stable, follows latest by default, and never substitutes an invalid selection', () => {
    const { projection, definition } = loopFixture(3);
    expect(
      selectRunFlowIterations(projection, definition, { loop: 'iteration_1' })[0],
    ).toMatchObject({
      selectedIterationId: 'iteration_1',
      latestIterationId: 'iteration_3',
      status: 'active',
    });
    expect(selectRunFlowIterations(projection, definition)[0]?.selectedIterationId).toBe(
      'iteration_3',
    );
    const missing = buildRunFlow(projection, [], definition, { loop: 'missing' });
    expect(missing.loops[0]?.selectedIterationId).toBeNull();
    expect(missing.nodes.some((node) => node.kind === 'artifact')).toBe(false);
    expect(missing.decisions.some((decision) => decision.status === 'observed')).toBe(false);
  });

  it('does not reveal orphaned round details when selected iteration metadata becomes unavailable', () => {
    const { projection, definition } = loopFixture(3);
    const child = created(projection.lastSeq + 1, 'child_1', 'helper');
    let current = applyEvent(projection, {
      ...child,
      payload: { ...child.payload, parentExecutionId: 'writer_1', depth: 1 },
    });
    current = applyEvent(current, artifact(current.lastSeq + 1, 'child_note', 'child_1'));
    delete current.iterations.iteration_1;
    const missing = buildRunFlow(current, [], definition, { loop: 'iteration_1' });
    expect(missing.loops[0]?.selectedIterationId).toBeNull();
    expect(missing.nodes.filter((node) => ['agent', 'artifact'].includes(node.kind))).toEqual([]);
    expect(missing.decisions.some((decision) => decision.status === 'observed')).toBe(false);
    const latest = buildRunFlow(current, [], definition);
    expect(
      latest.nodes.filter((node) => node.kind === 'artifact').map((node) => node.artifactVersionId),
    ).toEqual(['draft_3']);
  });

  it('includes older carry metadata only for an explicit selected-round input and keeps current body access', () => {
    const { projection, definition } = loopFixture(3);
    const carry = event(projection.lastSeq + 1, 'loop.iteration_started', {
      loopNodeId: 'loop',
      iterationId: 'iteration_3',
      no: 3,
      criteriaVersionId: 'criteria',
      pinnedCarryInputs: ['draft_2'],
    });
    const previousArtifact = projection.artifacts.draft_2;
    if (!previousArtifact) throw new Error('Missing previous-round artifact');
    previousArtifact.bodyAvailable = false;
    const flow = buildRunFlow(projection, [carry], definition);
    expect(
      flow.nodes.filter((node) => node.kind === 'artifact').map((node) => node.artifactVersionId),
    ).toEqual(['draft_2', 'draft_3']);
    expect(flow.nodes.find((node) => node.id === 'artifact:draft_2')?.current).toBe(false);
    expect(flow.edges).toContainEqual(
      expect.objectContaining({
        kind: 'input',
        from: 'artifact:draft_2',
        to: 'loop:loop',
        eventIds: [carry.eventId],
      }),
    );
    expect(
      flow.edges.some((edge) => edge.kind === 'author' && edge.to === 'artifact:draft_2'),
    ).toBe(false);
  });

  it('scopes delegated children by recorded parent ancestry, including explicit older execution selection', () => {
    const { projection, definition } = loopFixture(3);
    for (const no of [1, 2, 3]) {
      for (const depth of [1, 2]) {
        const id = `helper_${no}_${depth}`;
        const base = created(projection.lastSeq + 1, id, 'helper');
        Object.assign(
          projection,
          applyEvent(projection, {
            ...base,
            payload: {
              ...base.payload,
              depth,
              parentExecutionId: depth === 1 ? `writer_${no}` : `helper_${no}_1`,
            },
          }),
        );
        Object.assign(
          projection,
          applyEvent(projection, artifact(projection.lastSeq + 1, `note_${no}_${depth}`, id)),
        );
      }
    }
    const latest = buildRunFlow(projection, [], definition);
    expect(latest.nodes.find((node) => node.id === 'agent:helper')?.executionIds).toEqual([
      'helper_3_1',
      'helper_3_2',
    ]);
    expect(
      latest.nodes.filter((node) => node.kind === 'artifact').map((node) => node.artifactVersionId),
    ).toEqual(['draft_3', 'note_3_1', 'note_3_2']);
    const selectedIteration = runFlowExecutionIterationId(projection, 'helper_1_2');
    expect(selectedIteration).toBe('iteration_1');
    if (!selectedIteration) throw new Error('Missing delegated iteration');
    const selected = buildRunFlow(projection, [], definition, {
      loop: selectedIteration,
    });
    expect(selected.nodes.find((node) => node.id === 'agent:helper')?.executionIds).toEqual([
      'helper_1_1',
      'helper_1_2',
    ]);
    expect(
      selected.edges
        .filter((edge) => edge.kind === 'delegate')
        .flatMap((edge) => edge.executionIds),
    ).not.toContain('helper_3_1');
  });

  it('reports the current loop bound and outcome when inspecting an earlier round', () => {
    const { projection, definition } = loopFixture(3);
    const latestIteration = projection.iterations.iteration_3;
    if (!latestIteration) throw new Error('Missing latest iteration');
    latestIteration.outcome = 'cap_reached';
    const patched = applyEvent(
      projection,
      event(projection.lastSeq + 1, 'patch.committed', {
        patchId: 'raise_bound',
        kind: 'loop_limit',
        scope: { nodeId: 'loop' },
        before: { maxIterations: 2 },
        after: { maxIterations: 5 },
        controlRevision: 2,
      }),
    );
    const group = selectRunFlowIterations(patched, definition, { loop: 'iteration_1' })[0];
    expect(group).toMatchObject({
      maxIterations: 5,
      status: 'cap_reached',
      selectedIterationId: 'iteration_1',
    });
    expect(group?.iterations[0]?.outcome).toBe('revise');
    expect(definition.nodes.find((node) => node.id === 'loop')).toMatchObject({
      maxIterations: 10,
    });
  });

  it('links author, artifact read, exact model input and output without loading bodies', () => {
    const events = fixture();
    const projection = events.reduce(applyEvent, emptyProjection(RUN));
    const flow = buildRunFlow(projection, events, linearCorral(['research', 'writer']));
    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'agent:research', to: 'artifact:notes', kind: 'author' }),
        expect.objectContaining({ from: 'artifact:notes', to: 'agent:writer', kind: 'read' }),
        expect.objectContaining({ from: 'artifact:notes', to: 'agent:writer', kind: 'input' }),
        expect.objectContaining({ from: 'artifact:report', to: 'output:output', kind: 'output' }),
      ]),
    );
    expect(flow.edges.every((edge) => edge.observed)).toBe(true);
  });

  it('does not turn definition edges, nearby timestamps or unknown references into observed handoffs', () => {
    const events = [
      created(1, 'research_1', 'research'),
      created(2, 'write_1', 'writer'),
      artifact(3, 'notes', 'research_1'),
      event(4, 'artifact.read', {
        requestedRef: 'missing',
        resolvedVersionId: 'missing',
        consumerExecutionId: 'write_1',
      }),
    ];
    const flow = buildRunFlow(
      events.reduce(applyEvent, emptyProjection(RUN)),
      events,
      linearCorral(['research', 'writer']),
    );
    expect(flow.edges.map((edge) => edge.kind)).toEqual(['author']);
  });

  it('keeps absent workflow decisions unrecorded instead of inventing a branch', () => {
    const d: CorralDefinition = linearCorral(['research', 'writer']);
    d.nodes.push({
      id: 'gate',
      type: 'decision',
      label: 'Review gate',
      mode: 'rule',
      rule: 'required_tasks_submitted',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
    });
    const events = fixture();
    const flow = buildRunFlow(events.reduce(applyEvent, emptyProjection(RUN)), events, d);
    expect(flow.decisions).toEqual([
      expect.objectContaining({
        nodeId: 'gate',
        status: 'unrecorded',
        selectedPort: null,
        reasonCode: null,
      }),
    ]);
    expect(flow.edges.some((edge) => edge.kind === 'branch')).toBe(false);
  });

  it('deduplicates repeated event delivery and ignores records owned by another Run', () => {
    const events = fixture();
    const p = events.reduce(applyEvent, emptyProjection(RUN));
    const def = linearCorral(['research', 'writer']);
    const original = buildRunFlow(p, events, def);
    const existing = events[3];
    if (!existing) throw new Error('missing fixture event');
    expect(
      buildRunFlow(
        p,
        [...events, ...events, { ...existing, runId: 'other_run', eventId: 'other' }],
        def,
      ),
    ).toEqual(original);
  });

  it('distinguishes question/answer references from delegation and excludes their message bodies', () => {
    const events = [
      created(1, 'research_1', 'research'),
      artifact(2, 'notes', 'research_1'),
      event(3, 'execution.created', {
        executionId: 'respond_1',
        nodeId: 'writer',
        taskId: 'reply_task',
        attemptNo: 1,
        parentExecutionId: 'research_1',
        depth: 1,
        iterationId: null,
        modelProfile: 'model-a',
      }),
      event(4, 'message.question_created', {
        questionId: 'question_1',
        taskId: 'reply_task',
        senderExecutionId: 'research_1',
        targetRoleId: 'writer_role',
        targetNodeId: 'writer',
        body: 'Private source text',
        artifactRefs: ['notes'],
        deadline: '2026-11-06T01:00:00.000Z',
      }),
      event(5, 'message.answer_committed', {
        questionId: 'question_1',
        responseTaskId: 'reply_task',
        responderExecutionId: 'respond_1',
        body: 'Private answer text',
        evidenceRefs: ['notes'],
      }),
    ];
    const flow = buildRunFlow(
      events.reduce(applyEvent, emptyProjection(RUN)),
      events,
      linearCorral(['research', 'writer']),
    );
    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'question',
          from: 'agent:research',
          to: 'agent:writer',
          artifactVersionIds: ['notes'],
        }),
        expect.objectContaining({
          kind: 'answer',
          from: 'agent:writer',
          to: 'agent:research',
          artifactVersionIds: ['notes'],
        }),
      ]),
    );
    expect(flow.edges.some((edge) => edge.kind === 'delegate')).toBe(false);
    expect(JSON.stringify(flow)).not.toContain('Private');
  });

  it('shows only the review cited by the recorded branch and its selected destination', () => {
    const d = linearCorral(['research', 'writer']);
    d.nodes.push({
      id: 'gate',
      type: 'decision',
      label: 'Review gate',
      mode: 'review',
      rule: 'review_verdict',
      inputBindings: [{ kind: 'task_output', sourceNodeId: 'writer', name: 'review' }],
    });
    const events = fixture().slice(0, 6);
    events.push(
      artifact(7, 'review', 'research_1'),
      event(8, 'review.recorded', {
        reviewVersionId: 'review',
        targetVersionId: 'report',
        criteriaVersionId: 'criteria',
        verdict: 'revise',
        issues: [
          {
            criterionId: 'sources',
            reason: 'Missing source',
            severity: 'required',
            evidenceRefs: [],
          },
        ],
      }),
      event(9, 'workflow.branch_selected', {
        nodeId: 'gate',
        mode: 'review',
        iterationId: null,
        configRevision: 2,
        selectedPort: 'revise',
        targetNodeId: 'writer',
        targetPort: 'in',
        reasonCode: 'review_verdict',
        evidenceRefs: [
          { kind: 'review', id: 'review' },
          { kind: 'artifact', id: 'report' },
        ],
        executionRefs: [{ executionId: 'research_1', attemptNo: 1 }],
      }),
    );
    const p = events.reduce(applyEvent, emptyProjection(RUN));
    const flow = buildRunFlow(p, events, d);
    expect(flow.decisions).toEqual([
      expect.objectContaining({
        selectedPort: 'revise',
        targetNodeId: 'writer',
        reviewVerdict: 'revise',
        issues: ['Missing source'],
        status: 'observed',
        configRevision: 2,
      }),
    ]);
    expect(flow.edges).toContainEqual(
      expect.objectContaining({ from: 'decision:gate', to: 'agent:writer', kind: 'branch' }),
    );
    const retainedMetadata = buildRunFlow(p, [], d);
    expect(retainedMetadata.decisions).toEqual(flow.decisions);
  });
});
