import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type OutputNode,
  type RunEvent,
} from '@corral/contracts';
import {
  FakeClock,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  compileDefinition,
  type DecisionPolicy,
  type GraphRunner,
  InProcessTransport,
  planRun,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// Running several and nested Loops (docs/specs/features/team-graph.md, "루프 실행").

const base = Definition.parse(researchTeam);
const research = base.nodes.find((n) => n.id === 'research') as CorralNode;

const writer = (id: string, parentId?: string): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'writer',
  invocation: 'scheduled',
  inputBindings: [
    { kind: 'run_input', name: 'brief' },
    { kind: 'previous_iteration_output', name: 'draft', sourceNodeId: id, optional: true },
  ],
  outputName: 'draft',
  ...(parentId ? { parentId } : {}),
});
/** An agent outside any Loop: it reads only the brief. */
const plain = (id: string): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'writer',
  invocation: 'scheduled',
  inputBindings: [{ kind: 'run_input', name: 'brief' }],
  outputName: 'draft',
});
const reviewer = (id: string, draft: string, parentId?: string): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'reviewer',
  invocation: 'scheduled',
  inputBindings: [
    { kind: 'task_output', name: 'draft', sourceNodeId: draft },
    { kind: 'run_input', name: 'criteria' },
  ],
  outputName: 'review',
  ...(parentId ? { parentId } : {}),
});
const decision = (id: string, review: string, parentId?: string): CorralNode => ({
  id,
  type: 'decision',
  label: id,
  mode: 'review',
  rule: 'review_verdict',
  inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: review }],
  ...(parentId ? { parentId } : {}),
});
const loop = (id: string, extra: Partial<CorralNode> = {}, parentId?: string): CorralNode =>
  ({
    id,
    type: 'loop',
    label: id,
    maxIterations: 3,
    ...(parentId ? { parentId } : {}),
    ...extra,
  }) as CorralNode;
const output = (draft: string): OutputNode => ({
  id: 'output',
  type: 'output',
  label: 'output',
  inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: draft }],
  requireApproval: false,
});

let edgeNo = 0;
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') =>
  ({ id: `e${++edgeNo}`, source, sourcePort, target, targetPort }) as ControlEdge;

/** write → review → decision inside `loopId`, pass to exit and revise to repeat. */
function reviewedBody(
  loopId: string,
  prefix: string,
): { nodes: CorralNode[]; edges: ControlEdge[] } {
  const w = `${prefix}_write`;
  const r = `${prefix}_review`;
  const d = `${prefix}_decision`;
  return {
    nodes: [writer(w, loopId), reviewer(r, w, loopId), decision(d, r, loopId)],
    edges: [
      edge(loopId, 'body', w),
      edge(w, 'out', r),
      edge(r, 'out', d),
      edge(d, 'pass', loopId, 'exit'),
      edge(d, 'revise', loopId, 'repeat'),
    ],
  };
}

function team(
  nodes: CorralNode[],
  edges: ControlEdge[],
  entryNodeId = 'research',
): CorralDefinition {
  return Definition.parse({
    ...base,
    entryNodeId,
    nodes,
    controlEdges: edges,
    capabilityLinks: [],
  });
}

/** Decisions answer from a script per node; a missing answer is `revise`. */
function scripted(script: Record<string, string[]>): DecisionPolicy {
  return { decide: async ({ nodeId }) => script[nodeId]?.shift() ?? 'revise' };
}

/** Without `decisions`, the Coordinator decides from the recorded reviews itself. */
function runtime(
  decisions: DecisionPolicy | undefined,
  agents: Partial<ScriptedAgentOptions> = {},
) {
  const clock = new FakeClock();
  return new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      ...(decisions ? { decisions } : {}),
      agents: new ScriptedAgentAdapter({ turns: 1, ...agents }),
    }),
  );
}

const finished = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const pendingApproval = (p: RunProjection) =>
  p.status === 'awaiting_user'
    ? (Object.values(p.approvals).find((a) => a.status === 'pending') ?? null)
    : null;

async function run(transport: InProcessTransport, definition: CorralDefinition) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: `cmd_${++edgeNo}`,
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
  return { runId, events };
}

const rounds = (p: RunProjection, loopId: string) =>
  (p.loopIterations[loopId] ?? []).map((id) => {
    const round = p.iterations[id];
    return [round?.no, round?.outcome];
  });

/**
 * Loop A holds Loop B (write → review → decision) and A's own review of B's draft. With
 * `outer`, B's decision sends pass straight to A's exit and revise to a second decision that
 * owns B's own exit and repeat.
 */
function nested(innerPass: 'inner' | 'outer') {
  const inner = reviewedBody('loop_b', 'b');
  const edges =
    innerPass === 'inner'
      ? inner.edges
      : inner.edges.flatMap((e) =>
          e.source !== 'b_decision'
            ? [e]
            : e.sourcePort === 'pass'
              ? [{ ...e, target: 'loop_a', targetPort: 'exit' as const }]
              : [
                  { ...e, target: 'b_gate', targetPort: 'in' as const },
                  edge('b_gate', 'pass', 'loop_b', 'exit'),
                  edge('b_gate', 'revise', 'loop_b', 'repeat'),
                ],
        );
  return team(
    [
      research,
      loop('loop_a'),
      loop('loop_b', {}, 'loop_a'),
      ...inner.nodes,
      ...(innerPass === 'outer' ? [decision('b_gate', 'b_review', 'loop_b')] : []),
      reviewer('a_review', 'b_write', 'loop_a'),
      decision('a_decision', 'a_review', 'loop_a'),
      output('b_write'),
    ],
    [
      edge('research', 'out', 'loop_a', 'enter'),
      edge('loop_a', 'body', 'loop_b', 'enter'),
      ...edges,
      edge('loop_b', 'next', 'a_review'),
      edge('a_review', 'out', 'a_decision'),
      edge('a_decision', 'pass', 'loop_a', 'exit'),
      edge('a_decision', 'revise', 'loop_a', 'repeat'),
      edge('loop_a', 'next', 'output'),
    ],
  );
}

describe('loop execution', () => {
  it('runs two Loops one after the other', async () => {
    const a = reviewedBody('loop_a', 'a');
    const b = reviewedBody('loop_b', 'b');
    const definition = team(
      [research, loop('loop_a'), ...a.nodes, loop('loop_b'), ...b.nodes, output('b_write')],
      [
        edge('research', 'out', 'loop_a', 'enter'),
        ...a.edges,
        edge('loop_a', 'next', 'loop_b', 'enter'),
        ...b.edges,
        edge('loop_b', 'next', 'output'),
      ],
    );
    expect(planRun(definition).ok).toBe(true);
    const transport = runtime(
      scripted({ a_decision: ['revise', 'pass'], b_decision: ['revise', 'pass'] }),
    );
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop_a')).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
    expect(rounds(final, 'loop_b')).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
  });

  it('finalizes the reviewed draft after the shared Outrider question budget is spent', async () => {
    const definition = nested('inner');
    definition.sharedOutrider = {
      modelProfile: 'model-a',
      principles: 'Check the evidence.',
      targets: { kind: 'all' },
    };
    const result = definition.nodes.find((node) => node.type === 'output');
    if (!result) throw new Error('expected an output');
    result.requiredReviews = [
      {
        bindingName: 'final',
        sourceNodeId: 'b_write',
        loopNodeId: 'loop_b',
        reviewerNodeId: 'b_review',
        decisionNodeId: 'b_decision',
      },
    ];
    const transport = runtime(undefined);
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(
      events.filter((e) => e.type === 'message.question_created' && e.payload.sharedOutrider),
    ).toHaveLength(6);
    const asks = new Set(
      events.flatMap((e) =>
        e.type === 'tool.requested' && e.payload.name === 'ask' ? [e.payload.toolCallId] : [],
      ),
    );
    expect(
      events.some(
        (e) =>
          e.type === 'tool.blocked' &&
          asks.has(e.payload.toolCallId) &&
          e.payload.reason.startsWith('LIMIT_REACHED:'),
      ),
    ).toBe(true);
    expect(final.status).toBe('succeeded');
    expect(Object.values(final.executions).some((e) => e.status === 'failed')).toBe(false);
    expect(events.filter((e) => e.type === 'output.finalized')).toHaveLength(1);
    const [version] = final.output?.artifactVersionIds ?? [];
    if (!version) throw new Error('expected the reviewed draft');
    expect(await transport.getArtifactText(runId, version)).toContain(
      'no answer (question limit reached)',
    );
  });

  it('starts an inner Loop at round 1 in every outer round, under that round', async () => {
    const transport = runtime(
      scripted({ a_decision: ['revise', 'pass'], b_decision: ['pass', 'pass'] }),
    );
    const { runId, events } = await run(transport, nested('inner'));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop_a')).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
    expect(rounds(final, 'loop_b')).toEqual([
      [1, 'pass'],
      [1, 'pass'],
    ]);
    const [outer1, outer2] = final.loopIterations.loop_a ?? [];
    const [inner1, inner2] = (final.loopIterations.loop_b ?? []).map((id) => final.iterations[id]);
    expect(inner1?.parentIterationId).toBe(outer1);
    expect(inner2?.parentIterationId).toBe(outer2);
    // The same step in two outer rounds is two Tasks, not a replay of the first.
    const writes = (final.nodeExecutions.b_write ?? []).map((id) => final.executions[id]);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.taskId).not.toBe(writes[1]?.taskId);
    // Round 1 of the second entry is not handed the first entry's draft.
    const started = events.filter(
      (e) => e.type === 'loop.iteration_started' && e.payload.loopNodeId === 'loop_b',
    );
    expect(
      started.map((e) => e.type === 'loop.iteration_started' && e.payload.pinnedCarryInputs),
    ).toEqual([[], []]);
  });

  it('closes the inner round when a decision leaves through the outer exit', async () => {
    const transport = runtime(scripted({ b_decision: ['pass'] }));
    const { runId } = await run(transport, nested('outer'));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop_b')).toEqual([[1, 'pass']]);
    expect(rounds(final, 'loop_a')).toEqual([[1, 'pass']]);
    expect(final.nodeExecutions.a_review).toBeUndefined();
  });

  it('decides in the outer Loop from a review made inside the inner Loop', async () => {
    const inner = reviewedBody('loop_b', 'b');
    const definition = team(
      [
        research,
        loop('loop_a'),
        loop('loop_b', {}, 'loop_a'),
        ...inner.nodes,
        decision('a_decision', 'b_review', 'loop_a'),
        output('b_write'),
      ],
      [
        edge('research', 'out', 'loop_a', 'enter'),
        edge('loop_a', 'body', 'loop_b', 'enter'),
        ...inner.edges,
        edge('loop_b', 'next', 'a_decision'),
        edge('a_decision', 'pass', 'loop_a', 'exit'),
        edge('a_decision', 'revise', 'loop_a', 'repeat'),
        edge('loop_a', 'next', 'output'),
      ],
    );
    const transport = runtime(undefined, { review: () => 'pass' });
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop_a')).toEqual([[1, 'pass']]);
  });

  it('leaves through exhausted at the round cap without asking', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      [
        research,
        loop('loop', { maxIterations: 2 }),
        ...body.nodes,
        plain('fallback'),
        output('fallback'),
      ],
      [
        edge('research', 'out', 'loop', 'enter'),
        ...body.edges,
        edge('loop', 'next', 'output'),
        edge('loop', 'exhausted', 'fallback'),
        edge('fallback', 'out', 'output'),
      ],
    );
    expect(planRun(definition).ok).toBe(true);
    const transport = runtime(scripted({}));
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'cap_reached'],
    ]);
    expect(Object.keys(final.approvals)).toEqual([]);
    expect(final.nodeExecutions.fallback).toHaveLength(1);
  });

  it('fails the run without asking when the cap is reached and exhausted is unconnected', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      [research, loop('loop', { maxIterations: 1 }), ...body.nodes, output('l_write')],
      [edge('research', 'out', 'loop', 'enter'), ...body.edges, edge('loop', 'next', 'output')],
    );
    const transport = runtime(scripted({}));
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('loop_exhausted: loop cap_reached');
    expect(rounds(final, 'loop')).toEqual([[1, 'cap_reached']]);
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
    expect(pendingApproval(final)).toBeNull();
  });

  it('fails without finalizing output when the required reviewer requests revision in both allowed rounds', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      [
        loop('loop', { maxIterations: 2 }),
        ...body.nodes,
        {
          ...output('l_write'),
          requiredReviews: [
            {
              bindingName: 'final',
              sourceNodeId: 'l_write',
              loopNodeId: 'loop',
              reviewerNodeId: 'l_review',
              decisionNodeId: 'l_decision',
            },
          ],
        },
      ],
      [...body.edges, edge('loop', 'next', 'output')],
      'loop',
    );
    const transport = runtime(undefined, { review: () => 'revise' });
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);

    const verdicts = Object.values(final.reviews).map((review) => review.verdict);
    expect(verdicts).toEqual(['revise', 'revise']);
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'cap_reached'],
    ]);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('loop_exhausted: loop cap_reached');
    expect(final.output).toBeNull();
    expect(events.filter((event) => event.type === 'output.finalized')).toHaveLength(0);
  });

  it('an exhausted Loop ends the run without waiting for an advisor’s review', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = Definition.parse({
      ...team(
        [research, loop('loop', { maxIterations: 1 }), ...body.nodes, output('l_write')],
        [edge('research', 'out', 'loop', 'enter'), ...body.edges, edge('loop', 'next', 'output')],
      ),
      roles: [
        ...base.roles,
        {
          id: 'advisor_role',
          name: 'Reviewer',
          prompt: 'Watch.',
          modelProfile: base.roles[0]?.modelProfile ?? 'model-a',
          allowedWorkTools: [],
          allowedCollaborationTools: [],
          outputContract: 'notes',
        },
      ],
      capabilityLinks: [
        { id: 'watch', kind: 'advise', sourceNodeId: 'advisor', targetNodeId: 'l_write' },
      ],
    });
    definition.nodes.push({
      id: 'advisor',
      type: 'agent',
      label: 'advisor',
      roleId: 'advisor_role',
      invocation: 'observer',
      outputName: 'notes',
      review: { interval: 1, maxRequestsPerReview: 8 },
    } as CorralNode);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = runtime(scripted({}), {
      beforeReply: async (_turn, input) => {
        if (input.assignment.kind === 'advisor') await held;
      },
      advise: () => [{ severity: 'concern', note: 'The draft cites no source.' }],
    });
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('loop_exhausted: loop cap_reached');
    release();
    for (let i = 0; i < 300; i++) await Promise.resolve();
    const end = events.find((e) => e.type === 'run.state_changed' && e.payload.to === 'failed');
    const advisor = Object.values(final.executions).find((e) => e.nodeId === 'advisor');
    // Its review was under way when the run failed: the advisor stops with the run.
    const stopped = await waitForProjection(
      transport,
      runId,
      (p) => p.executions[advisor?.executionId ?? '']?.status === 'cancelled',
    );
    expect(stopped.status).toBe('failed');
    const later = events.filter((e) => end && e.runSeq > end.runSeq);
    expect(
      later.filter(
        (e) => e.type === 'model.request_prepared' && e.executionId === advisor?.executionId,
      ),
    ).toEqual([]);
    expect(later.filter((e) => e.type.startsWith('advice.'))).toEqual([]);
    expect(events.some((e) => e.type.startsWith('advice.'))).toBe(false);
  });

  it('counts a round that resubmits the same work as stalled', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      [
        research,
        loop('loop', { maxIterations: 5, stallDetection: true }),
        ...body.nodes,
        plain('fallback'),
        output('fallback'),
      ],
      [
        edge('research', 'out', 'loop', 'enter'),
        ...body.edges,
        edge('loop', 'next', 'output'),
        edge('loop', 'exhausted', 'fallback'),
        edge('fallback', 'out', 'output'),
      ],
    );
    const transport = runtime(scripted({}), {
      reply: (_turn, input) => (input.nodeId === 'l_write' ? 'The same draft.' : `${input.nodeId}`),
    });
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'stalled'],
    ]);
    expect(final.nodeExecutions.fallback).toHaveLength(1);
  });

  it('runs more rounds than the old installation cap, and starts at a Loop', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      [loop('loop', { maxIterations: 25 }), ...body.nodes, output('l_write')],
      [...body.edges, edge('loop', 'next', 'output')],
      'loop',
    );
    const compiled = compileDefinition(definition);
    expect(compiled.ok).toBe(true);
    const transport = runtime(scripted({ l_decision: Array(11).fill('revise').concat('pass') }));
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toHaveLength(12);
    expect(rounds(final, 'loop').at(-1)).toEqual([12, 'pass']);
  });

  it('runs through an inline Team, and a Team that starts the run', async () => {
    const definition = team(
      [
        research,
        { id: 'team', type: 'team', label: 'team', source: { kind: 'inline' } } as CorralNode,
        { ...plain('a'), parentId: 'team' },
        plain('b'),
        output('b'),
      ],
      [
        edge('research', 'out', 'team', 'enter'),
        edge('team', 'body', 'a'),
        edge('a', 'out', 'team', 'exit'),
        edge('team', 'next', 'b'),
        edge('b', 'out', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const transport = runtime(undefined);
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(final.executionOrder.map((id) => final.executions[id]?.nodeId)).toEqual([
      'research',
      'a',
      'b',
    ]);

    const fromTeam = team(
      definition.nodes.filter((n) => n.id !== 'research'),
      definition.controlEdges.filter((e) => e.source !== 'research'),
      'team',
    );
    const started = await run(transport, fromTeam);
    const second = await waitForProjection(transport, started.runId, finished);
    expect(second.status).toBe('succeeded');
    expect(second.executionOrder.map((id) => second.executions[id]?.nodeId)).toEqual(['a', 'b']);
  });

  it('runs an inline Team inside a Loop afresh each round, leaving through the Loop from inside it', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      [
        research,
        loop('loop'),
        {
          id: 'c',
          type: 'team',
          label: 'c',
          parentId: 'loop',
          source: { kind: 'inline' },
        } as CorralNode,
        ...body.nodes.map((n) => ({ ...n, parentId: 'c' })),
        output('l_write'),
      ],
      [
        edge('research', 'out', 'loop', 'enter'),
        edge('loop', 'body', 'c', 'enter'),
        edge('c', 'body', 'l_write'),
        ...body.edges.filter((e) => e.source !== 'loop'),
        edge('loop', 'next', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics.filter((d) => d.severity === 'error')).toEqual(
      [],
    );
    const transport = runtime(scripted({ l_decision: ['revise', 'pass'] }));
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
    const writes = (final.nodeExecutions.l_write ?? []).map((id) => final.executions[id]);
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map((e) => e?.taskId)).size).toBe(2);
  });
});

// docs/specs/technical-design.md §9.2: a task_output reads the named preceding task's submitted
// completion. A reader in a Loop round reads a looped source's latest completion in the same pass
// through every Loop the two share; sharing none, its latest completion.
describe('reading a step of another Loop', () => {
  /** The versions an execution was given, as its model request records them. */
  const given = (events: RunEvent[], executionId: string | undefined) =>
    events.flatMap((e) =>
      e.type === 'model.request_prepared' && e.payload.executionId === executionId
        ? e.payload.inputArtifactVersionIds
        : [],
    );
  /** Each execution of a node and the versions it submitted, oldest first. */
  const submitted = (p: RunProjection, nodeId: string) =>
    (p.nodeExecutions[nodeId] ?? []).map((id) => ({
      id,
      versions: p.tasks[p.executions[id]?.taskId ?? '']?.submittedArtifactVersionIds ?? [],
    }));
  /** Each reader execution was given its own round's source version and not the other's. */
  const readsInStep = (
    events: RunEvent[],
    readers: { id: string }[],
    sources: { versions: string[] }[],
    pick: (i: number) => number,
  ) => {
    for (const [i, read] of readers.entries()) {
      const mine = sources[pick(i)]?.versions ?? [];
      expect(mine.length).toBeGreaterThan(0);
      expect(given(events, read.id)).toEqual(expect.arrayContaining(mine));
      for (const [j, other] of sources.entries())
        if (j !== pick(i))
          for (const version of other.versions)
            expect(given(events, read.id)).not.toContain(version);
    }
  };
  /** `reader` also reads `source` as a task output. */
  const reading = (nodes: CorralNode[], reader: string, source: string, optional = false) =>
    nodes.map((node) =>
      node.id === reader && node.type === 'agent' && 'inputBindings' in node
        ? {
            ...node,
            inputBindings: [
              ...node.inputBindings,
              {
                kind: 'task_output' as const,
                name: 'earlier',
                sourceNodeId: source,
                ...(optional ? { optional } : {}),
              },
            ],
          }
        : node,
    );

  it('a step in a later Loop reads the earlier Loop’s last completed round', async () => {
    const a = reviewedBody('loop_a', 'a');
    const b = reviewedBody('loop_b', 'b');
    const definition = team(
      reading(
        [research, loop('loop_a'), ...a.nodes, loop('loop_b'), ...b.nodes, output('b_write')],
        'b_write',
        'a_write',
      ),
      [
        edge('research', 'out', 'loop_a', 'enter'),
        ...a.edges,
        edge('loop_a', 'next', 'loop_b', 'enter'),
        ...b.edges,
        edge('loop_b', 'next', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const transport = runtime(
      scripted({ a_decision: ['revise', 'pass'], b_decision: ['revise', 'pass'] }),
    );
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const writes = submitted(final, 'a_write');
    expect(writes).toHaveLength(2);
    // Both rounds of the later Loop read the earlier Loop's second round.
    readsInStep(events, submitted(final, 'b_write'), writes, () => 1);
  });

  it('two Loops inside one outer Loop read each other within the same outer round', async () => {
    const x = reviewedBody('loop_x', 'x');
    const y = reviewedBody('loop_y', 'y');
    const definition = team(
      reading(
        [
          research,
          loop('loop_o'),
          loop('loop_x', {}, 'loop_o'),
          ...x.nodes,
          loop('loop_y', {}, 'loop_o'),
          ...y.nodes,
          reviewer('o_review', 'y_write', 'loop_o'),
          decision('o_decision', 'o_review', 'loop_o'),
          output('y_write'),
        ],
        'y_write',
        'x_write',
      ),
      [
        edge('research', 'out', 'loop_o', 'enter'),
        edge('loop_o', 'body', 'loop_x', 'enter'),
        ...x.edges,
        edge('loop_x', 'next', 'loop_y', 'enter'),
        ...y.edges,
        edge('loop_y', 'next', 'o_review'),
        edge('o_review', 'out', 'o_decision'),
        edge('o_decision', 'pass', 'loop_o', 'exit'),
        edge('o_decision', 'revise', 'loop_o', 'repeat'),
        edge('loop_o', 'next', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const transport = runtime(
      scripted({
        x_decision: ['pass', 'pass'],
        y_decision: ['pass', 'pass'],
        o_decision: ['revise', 'pass'],
      }),
    );
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const xs = submitted(final, 'x_write');
    const ys = submitted(final, 'y_write');
    expect([xs.length, ys.length]).toEqual([2, 2]);
    // Outer round 2 reads x from outer round 2, not from round 1.
    readsInStep(events, ys, xs, (i) => i);
  });

  it('a step reads its own round, an enclosing Loop’s round and a nested Loop’s, as before', async () => {
    const inner = reviewedBody('loop_b', 'b');
    const definition = team(
      reading(
        [
          research,
          loop('loop_a'),
          writer('a_write', 'loop_a'),
          loop('loop_b', {}, 'loop_a'),
          ...inner.nodes,
          reviewer('a_review', 'b_write', 'loop_a'),
          decision('a_decision', 'a_review', 'loop_a'),
          output('b_write'),
        ],
        'b_write',
        'a_write',
      ),
      [
        edge('research', 'out', 'loop_a', 'enter'),
        edge('loop_a', 'body', 'a_write'),
        edge('a_write', 'out', 'loop_b', 'enter'),
        ...inner.edges,
        edge('loop_b', 'next', 'a_review'),
        edge('a_review', 'out', 'a_decision'),
        edge('a_decision', 'pass', 'loop_a', 'exit'),
        edge('a_decision', 'revise', 'loop_a', 'repeat'),
        edge('loop_a', 'next', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const transport = runtime(
      scripted({ a_decision: ['revise', 'pass'], b_decision: ['revise', 'pass', 'pass'] }),
    );
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    // Outer round 1 runs the inner Loop twice, outer round 2 once.
    const outer = submitted(final, 'a_write');
    const inner3 = submitted(final, 'b_write');
    expect([outer.length, inner3.length]).toEqual([2, 3]);
    // The enclosing Loop's step, from the reader's own outer round.
    readsInStep(events, inner3, outer, (i) => (i < 2 ? 0 : 1));
    // The same inner round's draft goes to its reviewer.
    readsInStep(events, submitted(final, 'b_review'), inner3, (i) => i);
    // A nested Loop's step, from the newest inner round of the reader's own outer round.
    readsInStep(events, submitted(final, 'a_review'), inner3, (i) => (i === 0 ? 1 : 2));
  });

  // A rule Decision whose answer comes from the script.
  const gate = (id: string, read: string, parentId: string): CorralNode => ({
    id,
    type: 'decision',
    label: id,
    mode: 'rule',
    rule: 'required_tasks_submitted',
    inputBindings: [{ kind: 'task_output', name: 'work', sourceNodeId: read }],
    parentId,
  });
  /**
   * Loop O runs Loop X and then Loop Y in round 1; in round 2 the gate skips X. Y's writer reads
   * X's writer: in round 2 there is nothing of that round to read.
   */
  const skipped = (optional: boolean) => {
    const x = reviewedBody('loop_x', 'x');
    const y = reviewedBody('loop_y', 'y');
    return team(
      reading(
        [
          research,
          loop('loop_o'),
          gate('o_gate', 'research', 'loop_o'),
          loop('loop_x', {}, 'loop_o'),
          ...x.nodes,
          loop('loop_y', {}, 'loop_o'),
          ...y.nodes,
          reviewer('o_review', 'y_write', 'loop_o'),
          decision('o_decision', 'o_review', 'loop_o'),
          output('y_write'),
        ],
        'y_write',
        'x_write',
        optional,
      ),
      [
        edge('research', 'out', 'loop_o', 'enter'),
        edge('loop_o', 'body', 'o_gate'),
        edge('o_gate', 'yes', 'loop_x', 'enter'),
        edge('o_gate', 'no', 'loop_y', 'enter'),
        ...x.edges,
        edge('loop_x', 'next', 'loop_y', 'enter'),
        ...y.edges,
        edge('loop_y', 'next', 'o_review'),
        edge('o_review', 'out', 'o_decision'),
        edge('o_decision', 'pass', 'loop_o', 'exit'),
        edge('o_decision', 'revise', 'loop_o', 'repeat'),
        edge('loop_o', 'next', 'output'),
      ],
    );
  };
  const skipping = () =>
    runtime(
      scripted({
        o_gate: ['yes', 'no'],
        x_decision: ['pass'],
        y_decision: ['pass', 'pass'],
        o_decision: ['revise', 'pass'],
      }),
    );

  // Pins the rule's boundary; it held before this rule as well.
  it('a step skipped in this outer round is not read from an earlier outer round', async () => {
    const required = skipped(false);
    expect(compileDefinition(required).diagnostics.filter((d) => d.severity === 'error')).toEqual(
      [],
    );
    const failing = skipping();
    const first = await run(failing, required);
    const failed = await waitForProjection(failing, first.runId, finished);
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(first.events)).toContain('has no submitted version');

    const transport = skipping();
    const { runId, events } = await run(transport, skipped(true));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const xs = submitted(final, 'x_write');
    const ys = submitted(final, 'y_write');
    expect([xs.length, ys.length]).toEqual([1, 2]);
    expect(given(events, ys[0]?.id)).toEqual(expect.arrayContaining(xs[0]?.versions ?? ['?']));
    for (const version of xs[0]?.versions ?? [])
      expect(given(events, ys[1]?.id)).not.toContain(version);
  });
});

// docs/specs/technical-design.md §9.2: a previous_iteration_output reads its source's latest
// completed submission in the round before, in the same entry, of the innermost Loop the reader
// and the source share; runs in Loops nested in that round belong to it. Values carried from a
// Loop's round before are pinned when its round starts (features/team-graph.md, "회차 기록").
describe('a previous round’s output across nested Loops', () => {
  /** Runs with scripted decisions and records the versions each execution got, by input name. */
  const recording = (script: Record<string, string[]>) => {
    const inputs = new Map<string, Record<string, string[]>>();
    const transport = runtime(scripted(script), {
      beforeReply: async (turn, input) => {
        if (turn !== 1) return;
        const named: Record<string, string[]> = {};
        for (const { name, artifactVersionId } of input.inputs)
          if (artifactVersionId) named[name] = [...(named[name] ?? []), artifactVersionId];
        inputs.set(input.executionId, named);
      },
    });
    return { transport, inputs };
  };
  /** Each execution of a node, oldest first, and the versions it submitted. */
  const runsOf = (p: RunProjection, nodeId: string) =>
    (p.nodeExecutions[nodeId] ?? []).map((id) => ({
      id,
      versions: p.tasks[p.executions[id]?.taskId ?? '']?.submittedArtifactVersionIds ?? [],
    }));
  /** The carry pins of each round of a Loop, in order. */
  const pins = (events: RunEvent[], loopId: string) =>
    events.flatMap((e) =>
      e.type === 'loop.iteration_started' && e.payload.loopNodeId === loopId
        ? [e.payload.pinnedCarryInputs]
        : [],
    );
  /** `reader` also reads `source`'s previous round under `name`. */
  const reads = (
    nodes: CorralNode[],
    reader: string,
    source: string,
    name: string,
    optional = true,
  ) =>
    nodes.map((node) =>
      node.id === reader && node.type === 'agent' && 'inputBindings' in node
        ? {
            ...node,
            inputBindings: [
              ...node.inputBindings,
              { kind: 'previous_iteration_output' as const, name, sourceNodeId: source, optional },
            ],
          }
        : node,
    );
  const ruleGate = (id: string, read: string, parentId: string): CorralNode => ({
    id,
    type: 'decision',
    label: id,
    mode: 'rule',
    rule: 'required_tasks_submitted',
    inputBindings: [{ kind: 'task_output', name: 'work', sourceNodeId: read }],
    parentId,
  });

  it('a single Loop hands round 2 its round-1 draft and review, pinned when round 2 starts', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      reads(
        [research, loop('loop'), ...body.nodes, output('l_write')],
        'l_write',
        'l_review',
        'review',
      ),
      [edge('research', 'out', 'loop', 'enter'), ...body.edges, edge('loop', 'next', 'output')],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const { transport, inputs } = recording({ l_decision: ['revise', 'pass'] });
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [w1, w2] = runsOf(final, 'l_write');
    const [r1] = runsOf(final, 'l_review');
    expect(inputs.get(w1?.id ?? '')).toEqual({});
    expect(inputs.get(w2?.id ?? '')).toEqual({ draft: w1?.versions, review: r1?.versions });
    expect(pins(events, 'loop')).toEqual([[], [...(w1?.versions ?? []), ...(r1?.versions ?? [])]]);
  });

  it('an inner Loop entered again gives its own steps nothing from the earlier entry', async () => {
    const { transport, inputs } = recording({
      a_decision: ['revise', 'pass'],
      b_decision: ['pass', 'pass'],
    });
    const { runId, events } = await run(transport, nested('inner'));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [b1, b2] = runsOf(final, 'b_write');
    expect(inputs.get(b1?.id ?? '')).toEqual({});
    expect(inputs.get(b2?.id ?? '')).toEqual({});
    // The second entry's draft starts a new artifact rather than revising the first entry's.
    const [v1, v2] = [b1?.versions[0], b2?.versions[0]].map((id) => final.artifacts[id ?? '']);
    expect(v2?.artifactId).not.toBe(v1?.artifactId);
    expect([v2?.version, v2?.parentVersionId]).toEqual([1, null]);
    expect(pins(events, 'loop_b')).toEqual([[], []]);
    expect(pins(events, 'loop_a')).toEqual([[], []]);
  });

  it('a step in an inner Loop gets the outer review of the outer round before', async () => {
    const drawn = nested('inner');
    const outerReview = Definition.parse({
      ...drawn,
      nodes: reads(drawn.nodes, 'b_write', 'a_review', 'outer'),
    });
    expect(compileDefinition(outerReview).diagnostics).toEqual([]);
    const { transport, inputs } = recording({
      a_decision: ['revise', 'pass'],
      b_decision: ['pass', 'pass'],
    });
    const { runId, events } = await run(transport, outerReview);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [b1, b2] = runsOf(final, 'b_write');
    const [a1] = runsOf(final, 'a_review');
    expect(inputs.get(b1?.id ?? '')).toEqual({});
    // Outer round 2 runs the inner Loop's round 1: the outer review comes, its own draft does not.
    expect(inputs.get(b2?.id ?? '')).toEqual({ outer: a1?.versions });
    expect(pins(events, 'loop_a')).toEqual([[], a1?.versions]);
    expect(pins(events, 'loop_b')).toEqual([[], []]);
  });

  it('a step of the outer Loop gets the inner writer’s last draft of the outer round before', async () => {
    const inner = reviewedBody('loop_b', 'b');
    const definition = team(
      reads(
        [
          research,
          loop('loop_a'),
          writer('a_write', 'loop_a'),
          loop('loop_b', {}, 'loop_a'),
          ...inner.nodes,
          reviewer('a_review', 'b_write', 'loop_a'),
          decision('a_decision', 'a_review', 'loop_a'),
          output('b_write'),
        ],
        'a_write',
        'b_write',
        'inner',
      ),
      [
        edge('research', 'out', 'loop_a', 'enter'),
        edge('loop_a', 'body', 'a_write'),
        edge('a_write', 'out', 'loop_b', 'enter'),
        ...inner.edges,
        edge('loop_b', 'next', 'a_review'),
        edge('a_review', 'out', 'a_decision'),
        edge('a_decision', 'pass', 'loop_a', 'exit'),
        edge('a_decision', 'revise', 'loop_a', 'repeat'),
        edge('loop_a', 'next', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const { transport, inputs } = recording({
      a_decision: ['revise', 'pass'],
      b_decision: ['revise', 'pass', 'pass'],
    });
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    // Outer round 1 runs the inner Loop twice, outer round 2 once.
    const [a1, a2] = runsOf(final, 'a_write');
    const [, b2, b3] = runsOf(final, 'b_write');
    expect(b3).toBeDefined();
    expect(inputs.get(a1?.id ?? '')).toEqual({});
    expect(inputs.get(a2?.id ?? '')).toEqual({ draft: a1?.versions, inner: b2?.versions });
    expect(pins(events, 'loop_a')).toEqual([
      [],
      [...(a1?.versions ?? []), ...(b2?.versions ?? [])],
    ]);
    // The outer writer's round 2 revises its round-1 draft.
    const [v1, v2] = [a1?.versions[0], a2?.versions[0]].map((id) => final.artifacts[id ?? '']);
    expect(v2?.artifactId).toBe(v1?.artifactId);
    expect([v2?.version, v2?.parentVersionId]).toEqual([2, a1?.versions[0]]);
  });

  /**
   * Loop O runs Loop X and then Loop Y in round 1; in rounds 2 and 3 the gate skips X. Y's writer
   * reads X's writer of the outer round before.
   */
  const skippedBefore = (optional: boolean) => {
    const x = reviewedBody('loop_x', 'x');
    const y = reviewedBody('loop_y', 'y');
    return team(
      reads(
        [
          research,
          loop('loop_o'),
          ruleGate('o_gate', 'research', 'loop_o'),
          loop('loop_x', {}, 'loop_o'),
          ...x.nodes,
          loop('loop_y', {}, 'loop_o'),
          ...y.nodes,
          reviewer('o_review', 'y_write', 'loop_o'),
          decision('o_decision', 'o_review', 'loop_o'),
          output('y_write'),
        ],
        'y_write',
        'x_write',
        'earlier',
        optional,
      ),
      [
        edge('research', 'out', 'loop_o', 'enter'),
        edge('loop_o', 'body', 'o_gate'),
        edge('o_gate', 'yes', 'loop_x', 'enter'),
        edge('o_gate', 'no', 'loop_y', 'enter'),
        ...x.edges,
        edge('loop_x', 'next', 'loop_y', 'enter'),
        ...y.edges,
        edge('loop_y', 'next', 'o_review'),
        edge('o_review', 'out', 'o_decision'),
        edge('o_decision', 'pass', 'loop_o', 'exit'),
        edge('o_decision', 'revise', 'loop_o', 'repeat'),
        edge('loop_o', 'next', 'output'),
      ],
    );
  };

  it('a source that did not run in the round before gives nothing; a required binding does not compile', async () => {
    expect(compileDefinition(skippedBefore(false)).diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'BINDING_SOURCE',
        nodeId: 'y_write',
        message: expect.stringContaining('must be optional'),
      }),
    );
    const definition = skippedBefore(true);
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const { transport, inputs } = recording({
      o_gate: ['yes', 'no', 'no'],
      x_decision: ['pass'],
      y_decision: ['pass', 'pass', 'pass'],
      o_decision: ['revise', 'revise', 'pass'],
    });
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [x1, ...more] = runsOf(final, 'x_write');
    expect(more).toEqual([]);
    const [y1, y2, y3] = runsOf(final, 'y_write');
    expect(inputs.get(y1?.id ?? '')).toEqual({});
    expect(inputs.get(y2?.id ?? '')).toEqual({ earlier: x1?.versions });
    // X did not run in outer round 2, so outer round 3 is not handed round 1's draft.
    expect(inputs.get(y3?.id ?? '')).toEqual({});
    expect(pins(events, 'loop_o')).toEqual([[], x1?.versions, []]);
  });

  it('two Loops side by side in one outer Loop: one reads the other’s last draft of the outer round before', async () => {
    const x = reviewedBody('loop_x', 'x');
    const y = reviewedBody('loop_y', 'y');
    const definition = team(
      reads(
        [
          research,
          loop('loop_o'),
          loop('loop_x', {}, 'loop_o'),
          ...x.nodes,
          loop('loop_y', {}, 'loop_o'),
          ...y.nodes,
          { id: 'o_join', type: 'join', label: 'o_join', policy: 'all', parentId: 'loop_o' },
          reviewer('o_review', 'y_write', 'loop_o'),
          decision('o_decision', 'o_review', 'loop_o'),
          output('y_write'),
        ],
        'y_write',
        'x_write',
        'beside',
      ),
      [
        edge('research', 'out', 'loop_o', 'enter'),
        edge('loop_o', 'body', 'loop_x', 'enter'),
        edge('loop_o', 'body', 'loop_y', 'enter'),
        ...x.edges,
        ...y.edges,
        edge('loop_x', 'next', 'o_join'),
        edge('loop_y', 'next', 'o_join'),
        edge('o_join', 'out', 'o_review'),
        edge('o_review', 'out', 'o_decision'),
        edge('o_decision', 'pass', 'loop_o', 'exit'),
        edge('o_decision', 'revise', 'loop_o', 'repeat'),
        edge('loop_o', 'next', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics.filter((d) => d.severity === 'error')).toEqual(
      [],
    );
    const { transport, inputs } = recording({
      x_decision: ['revise', 'pass', 'pass'],
      y_decision: ['pass', 'pass'],
      o_decision: ['revise', 'pass'],
    });
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [, x2, x3] = runsOf(final, 'x_write');
    expect(x3).toBeDefined();
    const [y1, y2] = runsOf(final, 'y_write');
    expect(inputs.get(y1?.id ?? '')).toEqual({});
    expect(inputs.get(y2?.id ?? '')).toEqual({ beside: x2?.versions });
    expect(pins(events, 'loop_o')).toEqual([[], x2?.versions]);
  });
});

// docs/specs/technical-design.md §9.2: an Output inside a Loop reads each source in the round that
// reached it, as a task_output of that round would; a source that did not submit there adds
// nothing. Required-review candidates are read in that round too, at the first check and at the
// check after a person's approval.
describe('an Output inside a Loop', () => {
  const rule = (id: string, read: string, parentId: string): CorralNode => ({
    id,
    type: 'decision',
    label: id,
    mode: 'rule',
    rule: 'required_tasks_submitted',
    inputBindings: [{ kind: 'task_output', name: 'work', sourceNodeId: read }],
    parentId,
  });
  /** Each version a node submitted, one list per execution, oldest first. */
  const versionsOf = (p: RunProjection, nodeId: string) =>
    (p.nodeExecutions[nodeId] ?? []).map(
      (id) => p.tasks[p.executions[id]?.taskId ?? '']?.submittedArtifactVersionIds ?? [],
    );
  /**
   * Loop O: the gate runs Loop X then Loop Y (`withY`), or skips X; `o_end` then reaches the
   * Output inside O or goes round again. The Output reads `sources` in order.
   */
  const skipping = (sources: string[], withY: boolean) => {
    const x = reviewedBody('loop_x', 'x');
    const y = reviewedBody('loop_y', 'y');
    const after = withY ? 'loop_y' : 'o_end';
    const afterPort = withY ? 'enter' : 'in';
    return team(
      [
        research,
        loop('loop_o'),
        rule('o_gate', 'research', 'loop_o'),
        loop('loop_x', {}, 'loop_o'),
        ...x.nodes,
        ...(withY ? [loop('loop_y', {}, 'loop_o'), ...y.nodes] : []),
        rule('o_end', 'research', 'loop_o'),
        rule('o_leave', 'research', 'loop_o'),
        {
          id: 'after',
          type: 'output',
          label: 'after',
          inputBindings: [{ kind: 'task_output', name: 'after', sourceNodeId: 'research' }],
          requireApproval: false,
        },
        {
          id: 'output',
          type: 'output',
          label: 'output',
          parentId: 'loop_o',
          inputBindings: sources.map((sourceNodeId) => ({
            kind: 'task_output' as const,
            name: sourceNodeId,
            sourceNodeId,
          })),
          requireApproval: false,
        },
      ],
      [
        edge('research', 'out', 'loop_o', 'enter'),
        edge('loop_o', 'body', 'o_gate'),
        edge('o_gate', 'yes', 'loop_x', 'enter'),
        edge('o_gate', 'no', after, afterPort),
        ...x.edges,
        edge('loop_x', 'next', after, afterPort),
        ...(withY ? [...y.edges, edge('loop_y', 'next', 'o_end')] : []),
        edge('o_end', 'yes', 'output'),
        edge('o_end', 'no', 'o_leave'),
        edge('o_leave', 'yes', 'loop_o', 'exit'),
        edge('o_leave', 'no', 'loop_o', 'repeat'),
        edge('loop_o', 'next', 'after'),
      ],
    );
  };

  it('fails without finalizing when its only source did not run in the round that reached it', async () => {
    const definition = skipping(['x_write'], false);
    expect(compileDefinition(definition).diagnostics.filter((d) => d.severity === 'error')).toEqual(
      [],
    );
    const transport = runtime(
      scripted({
        o_gate: ['yes', 'no'],
        x_decision: ['pass'],
        o_end: ['no', 'yes'],
        o_leave: ['no'],
      }),
    );
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(versionsOf(final, 'x_write')).toHaveLength(1);
    expect(rounds(final, 'loop_o').map(([no]) => no)).toEqual([1, 2]);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toContain('output has no submitted version');
    expect(final.output).toBeNull();
    expect(events.filter((e) => e.type === 'output.finalized')).toEqual([]);
  });

  it('publishes, in binding order, only what its sources submitted in the round that reached it', async () => {
    const definition = skipping(['research', 'x_write', 'y_write'], true);
    expect(compileDefinition(definition).diagnostics.filter((d) => d.severity === 'error')).toEqual(
      [],
    );
    const transport = runtime(
      scripted({
        o_gate: ['yes', 'no'],
        x_decision: ['pass'],
        y_decision: ['pass', 'pass'],
        o_end: ['no', 'yes'],
        o_leave: ['no'],
      }),
    );
    const { runId } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [notes] = versionsOf(final, 'research');
    const [, y2] = versionsOf(final, 'y_write');
    expect(versionsOf(final, 'x_write')).toHaveLength(1);
    // research is outside every Loop: its last submission. X did not run in round 2.
    expect(final.output?.artifactVersionIds).toEqual([...(notes ?? []), ...(y2 ?? [])]);
  });

  /** Loop O holds a required-review gate around `p` and the Output that publishes `p`. */
  const gated = (requireApproval: boolean) =>
    team(
      [
        loop('loop_o'),
        loop('gate', {}, 'loop_o'),
        writer('p', 'gate'),
        reviewer('r', 'p', 'gate'),
        decision('d', 'r', 'gate'),
        rule('o_end', 'p', 'loop_o'),
        rule('o_leave', 'p', 'loop_o'),
        {
          id: 'after',
          type: 'output',
          label: 'after',
          inputBindings: [{ kind: 'task_output', name: 'after', sourceNodeId: 'p' }],
          requireApproval: false,
        },
        {
          ...output('p'),
          parentId: 'loop_o',
          requireApproval,
          requiredReviews: [
            {
              bindingName: 'final',
              sourceNodeId: 'p',
              loopNodeId: 'gate',
              reviewerNodeId: 'r',
              decisionNodeId: 'd',
            },
          ],
        },
      ],
      [
        edge('loop_o', 'body', 'gate', 'enter'),
        edge('gate', 'body', 'p'),
        edge('p', 'out', 'r'),
        edge('r', 'out', 'd'),
        edge('d', 'pass', 'gate', 'exit'),
        edge('d', 'revise', 'gate', 'repeat'),
        edge('gate', 'next', 'o_end'),
        edge('o_end', 'yes', 'output'),
        edge('o_end', 'no', 'o_leave'),
        edge('o_leave', 'yes', 'loop_o', 'exit'),
        edge('o_leave', 'no', 'loop_o', 'repeat'),
        edge('loop_o', 'next', 'after'),
      ],
      'loop_o',
    );
  /** A Coordinator whose run follows `script` instead of walking the plan. */
  const scriptedRun = (
    definition: CorralDefinition,
    review: ScriptedAgentOptions['review'],
    script: (c: Parameters<GraphRunner['run']>[1]) => Promise<void>,
  ) => {
    const clock = new FakeClock();
    const transport = new InProcessTransport(
      new Coordinator({
        clock,
        ids: new SequentialIdFactory(),
        timers: clock,
        agents: new ScriptedAgentAdapter({ turns: 1, collaborate: false, review }),
        runner: {
          run: async (_plan, c) => {
            await script(c);
            return { kind: 'finished', outputNodeId: 'output' };
          },
        },
      }),
    );
    return transport;
  };
  const g1 = { loopId: 'gate', no: 1 };
  /** Round `no` of Loop O: the gate's first round writes, reviews and, with a verdict, decides. */
  const outerRound = async (c: Parameters<GraphRunner['run']>[1], no: number, decides: boolean) => {
    await c.loopEntered('loop_o', no);
    await c.loopEntered('gate', 1);
    await c.activate('p', g1);
    if (!decides) return;
    await c.activate('r', g1);
    await c.decide('d', g1);
  };

  it('a gate that passed round 1’s candidate does not admit round 2’s new one', async () => {
    const definition = gated(false);
    expect(compileDefinition(definition).diagnostics.filter((d) => d.severity === 'error')).toEqual(
      [],
    );
    const transport = scriptedRun(
      definition,
      () => 'pass',
      async (c) => {
        await outerRound(c, 1, true);
        await c.loopLeft('gate', 1, 'pass');
        await c.loopLeft('loop_o', 1, 'revise');
        // Round 2 writes a new candidate and reaches the Output without the gate deciding on it.
        await outerRound(c, 2, false);
        await c.finalize('output');
      },
    );
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(versionsOf(final, 'p')).toHaveLength(2);
    expect(Object.values(final.reviews).map((r) => r.verdict)).toEqual(['pass']);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toContain(
      'required_output_review: no passing review for the submitted candidate version',
    );
    expect(events.filter((e) => e.type === 'output.finalized')).toEqual([]);
  });

  /**
   * Round 1 passes the gate and reaches the Output, which asks the person. While it waits, round 2
   * writes a new candidate and, with `decides`, the gate revises it. Then the person approves.
   */
  const approvedThenRound2 = async (decides: boolean) => {
    const definition = gated(true);
    let asked = () => {};
    const approvalAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let ready = () => {};
    const readyToApprove = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let reviews = 0;
    const transport = scriptedRun(
      definition,
      () => (++reviews === 1 ? 'pass' : 'revise'),
      async (c) => {
        await outerRound(c, 1, true);
        await c.loopLeft('gate', 1, 'pass');
        const finalizing = c.finalize('output');
        await approvalAsked;
        await c.loopLeft('loop_o', 1, 'revise');
        await outerRound(c, 2, decides);
        ready();
        await finalizing;
      },
    );
    const { runId, events } = await run(transport, definition);
    const waiting = await waitForProjection(transport, runId, (p) =>
      Object.values(p.approvals).some((a) => a.kind === 'final_output' && a.status === 'pending'),
    );
    const approval = Object.values(waiting.approvals).find((a) => a.kind === 'final_output');
    const [[first] = []] = versionsOf(waiting, 'p');
    expect(approval?.subjectVersionIds[0]).toBe(first);
    asked();
    await readyToApprove;
    const now = (await transport.getSnapshot(runId)).projection;
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cmd_approve_round_1',
      runId,
      type: 'resolve_approval',
      expectedControlRevision: now.controlRevision,
      payload: {
        approvalId: approval?.approvalId ?? '',
        decision: 'approve',
        subjectVersionId: first ?? '',
      },
    });
    const final = await waitForProjection(transport, runId, finished);
    expect(versionsOf(final, 'p')).toHaveLength(2);
    return { final, events, first };
  };

  it('after the person approves round 1’s candidate, a gate that revised round 2’s new one refuses it', async () => {
    const { final, events } = await approvedThenRound2(true);
    expect(Object.values(final.reviews).map((r) => r.verdict)).toEqual(['pass', 'revise']);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toContain(
      'required_output_review: no passing review for the submitted candidate version',
    );
    expect(events.filter((e) => e.type === 'output.finalized')).toEqual([]);
  });

  it('after the person approves round 1’s candidate, the check reads round 1 again and finalises it', async () => {
    const { final, first } = await approvedThenRound2(false);
    expect(Object.values(final.reviews).map((r) => r.verdict)).toEqual(['pass']);
    expect(final.status).toBe('succeeded');
    expect(final.output?.artifactVersionIds).toEqual([first]);
  });
});

// The built-in verdict: a review Decision reads the verdict from the review it is bound to, never
// from another bound output (docs/specs/features/team-graph.md).
describe('a review Decision bound to more than the review', () => {
  const settled = (p: RunProjection) => finished(p) || p.status === 'awaiting_user';
  /** `decisionId` reads `extra` first and its own review second. */
  const boundFirst = (nodes: CorralNode[], decisionId: string, extra: string) =>
    nodes.map((node) =>
      node.id === decisionId && node.type === 'decision'
        ? {
            ...node,
            inputBindings: [
              { kind: 'task_output' as const, name: 'context', sourceNodeId: extra },
              ...node.inputBindings,
            ],
          }
        : node,
    );

  it('follows the review when it also reads a step of an earlier Loop', async () => {
    const a = reviewedBody('loop_a', 'a');
    const b = reviewedBody('loop_b', 'b');
    const definition = team(
      boundFirst(
        [research, loop('loop_a'), ...a.nodes, loop('loop_b'), ...b.nodes, output('b_write')],
        'b_decision',
        'a_write',
      ),
      [
        edge('research', 'out', 'loop_a', 'enter'),
        ...a.edges,
        edge('loop_a', 'next', 'loop_b', 'enter'),
        ...b.edges,
        edge('loop_b', 'next', 'output'),
      ],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const transport = runtime(undefined);
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop_b')).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
  });

  it('follows the review when it also reads a step outside every Loop', async () => {
    const b = reviewedBody('loop_b', 'b');
    const definition = team(
      boundFirst(
        [research, loop('loop_b'), ...b.nodes, output('b_write')],
        'b_decision',
        'research',
      ),
      [edge('research', 'out', 'loop_b', 'enter'), ...b.edges, edge('loop_b', 'next', 'output')],
    );
    expect(compileDefinition(definition).diagnostics).toEqual([]);
    const transport = runtime(undefined);
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop_b')).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
  });
});
