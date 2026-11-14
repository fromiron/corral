import { type CorralDefinition, type EventOf, RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection, type RunProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  runFlowDecisions,
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
      parentIterationId: null,
      outcome: no === rounds ? null : 'revise',
    };
    projection.loopIterations.loop = [...(projection.loopIterations.loop ?? []), iterationId];
  }
  return { projection, definition };
}

/** A review gate whose recorded branch cites a review of the report. */
function reviewFixture() {
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
  return { d, events, p: events.reduce(applyEvent, emptyProjection(RUN)) };
}

describe('observed Run flow', () => {
  it('keeps 100 observed rounds in one loop group with only the selected round’s decision', () => {
    const { projection, definition } = loopFixture(100);
    const loops = selectRunFlowIterations(projection, definition);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({
      nodeId: 'loop',
      maxIterations: 10,
      latestIterationId: 'iteration_100',
      selectedIterationId: 'iteration_100',
      status: 'active',
    });
    expect(loops[0]?.iterations).toHaveLength(100);
    expect(
      runFlowDecisions(projection, [], definition).map((decision) => decision.iterationId),
    ).toEqual(['iteration_100']);
    expect(
      runFlowDecisions(projection, [], definition, { loop: 'iteration_2' }).map(
        (decision) => decision.iterationId,
      ),
    ).toEqual(['iteration_2']);
    expect(
      selectRunFlowIterations(projection, definition, { loop: 'iteration_2' })[0]?.status,
    ).toBe('active');
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
    const missing = { loop: 'missing' };
    expect(
      selectRunFlowIterations(projection, definition, missing)[0]?.selectedIterationId,
    ).toBeNull();
    expect(
      runFlowDecisions(projection, [], definition, missing).some(
        (decision) => decision.status === 'observed',
      ),
    ).toBe(false);
  });

  it('does not reveal a round’s decision when its iteration metadata becomes unavailable', () => {
    const { projection, definition } = loopFixture(3);
    delete projection.iterations.iteration_1;
    const selected = { loop: 'iteration_1' };
    expect(
      selectRunFlowIterations(projection, definition, selected)[0]?.selectedIterationId,
    ).toBeNull();
    expect(
      runFlowDecisions(projection, [], definition, selected).some(
        (decision) => decision.status === 'observed',
      ),
    ).toBe(false);
  });

  it('places a delegated child in its round by recorded parent ancestry', () => {
    const { projection } = loopFixture(3);
    for (const depth of [1, 2]) {
      const id = `helper_1_${depth}`;
      const base = created(projection.lastSeq + 1, id, 'helper');
      Object.assign(
        projection,
        applyEvent(projection, {
          ...base,
          payload: {
            ...base.payload,
            depth,
            parentExecutionId: depth === 1 ? 'writer_1' : 'helper_1_1',
          },
        }),
      );
    }
    expect(runFlowExecutionIterationId(projection, 'helper_1_2')).toBe('iteration_1');
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
    expect(runFlowDecisions(events.reduce(applyEvent, emptyProjection(RUN)), events, d)).toEqual([
      expect.objectContaining({
        nodeId: 'gate',
        status: 'unrecorded',
        selectedPort: null,
        reasonCode: null,
      }),
    ]);
  });

  it('deduplicates repeated event delivery and ignores records owned by another Run', () => {
    const { d, events, p } = reviewFixture();
    const original = runFlowDecisions(p, events, d);
    const branch = events.at(-1);
    if (!branch) throw new Error('missing fixture event');
    expect(
      runFlowDecisions(
        p,
        [...events, ...events, { ...branch, runId: 'other_run', eventId: 'other' }],
        d,
      ),
    ).toEqual(original);
  });

  it('carries the review cited by the recorded branch and its selected destination', () => {
    const { d, events, p } = reviewFixture();
    const decisions = runFlowDecisions(p, events, d);
    expect(decisions).toEqual([
      expect.objectContaining({
        selectedPort: 'revise',
        targetNodeId: 'writer',
        reviewVerdict: 'revise',
        issues: ['Missing source'],
        status: 'observed',
        configRevision: 2,
      }),
    ]);
    expect(runFlowDecisions(p, [], d)).toEqual(decisions);
  });
});
