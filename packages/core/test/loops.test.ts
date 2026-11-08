import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
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
const output = (draft: string): CorralNode => ({
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

  it('asks with the reason when the budget is spent and exhausted is unconnected', async () => {
    const body = reviewedBody('loop', 'l');
    const definition = team(
      [
        research,
        loop('loop', { maxIterations: 5, budget: { maxModelCalls: 1 } }),
        ...body.nodes,
        output('l_write'),
      ],
      [edge('research', 'out', 'loop', 'enter'), ...body.edges, edge('loop', 'next', 'output')],
    );
    const transport = runtime(scripted({}));
    const { runId } = await run(transport, definition);
    const answer = async (decision: 'approve' | 'reject') => {
      const waiting = await waitForProjection(transport, runId, (p) => pendingApproval(p) !== null);
      const approval = pendingApproval(waiting);
      expect(approval).toMatchObject({ kind: 'loop_cap', loopStop: 'budget_exhausted' });
      await transport.sendCommand({
        schemaVersion: '0.1',
        commandId: `cmd_${++edgeNo}`,
        runId,
        type: 'resolve_approval',
        expectedControlRevision: waiting.controlRevision,
        payload: {
          approvalId: approval?.approvalId ?? '',
          decision,
          subjectVersionId: approval?.subjectVersionIds[0] ?? '',
        },
      });
    };
    await answer('approve');
    await answer('reject');
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('cancelled');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'budget_exhausted'],
    ]);
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
    expect(compiled.diagnostics.filter((d) => d.code === 'RUNTIME_UNSUPPORTED')).toEqual([]);
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
