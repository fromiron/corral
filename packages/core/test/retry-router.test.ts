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

// Agent retry, error paths and the router (docs/specs/features/team-graph.md, "재시도와 실패
// 경로" and "router 실행").

const base = Definition.parse(researchTeam);

const agent = (id: string, extra: Partial<Extract<CorralNode, { type: 'agent' }>> = {}) =>
  ({
    id,
    type: 'agent',
    label: `Step ${id}`,
    roleId: 'writer',
    invocation: 'scheduled',
    inputBindings: [{ kind: 'run_input', name: 'brief' }],
    outputName: 'draft',
    ...extra,
  }) as CorralNode;
const reads = (source: string) => [
  { kind: 'task_output' as const, name: 'draft', sourceNodeId: source },
];
const output = (...sources: string[]): CorralNode => ({
  id: 'output',
  type: 'output',
  label: 'output',
  inputBindings: sources.map((sourceNodeId) => ({
    kind: 'task_output' as const,
    name: `final_${sourceNodeId}`,
    sourceNodeId,
    ...(sources.length > 1 ? { optional: true } : {}),
  })),
  requireApproval: false,
});
const router = (extra: Record<string, unknown> = {}): CorralNode =>
  ({
    id: 'router',
    type: 'decision',
    label: 'router',
    mode: 'router',
    routes: [
      { id: 'fix', label: 'Fix it', description: 'The draft needs work.' },
      { id: 'ship', label: 'Ship it' },
    ],
    inputBindings: reads('w'),
    ...extra,
  }) as CorralNode;

let edgeNo = 0;
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') =>
  ({ id: `e${++edgeNo}`, source, sourcePort, target, targetPort }) as ControlEdge;

function team(nodes: CorralNode[], edges: ControlEdge[], entryNodeId = 'w'): CorralDefinition {
  return Definition.parse({
    ...base,
    entryNodeId,
    nodes,
    controlEdges: edges,
    capabilityLinks: [],
  });
}

/** Every agent start, by node and attempt, with the inputs it was given. */
type Started = {
  nodeId: string;
  attemptNo: number;
  inputs: { name: string; text: string; version: string | null }[];
};

function runtime(
  agents: Partial<ScriptedAgentOptions> & {
    fail?: (nodeId: string, attemptNo: number) => boolean;
  } = {},
  decisions?: DecisionPolicy,
) {
  const clock = new FakeClock();
  const started: Started[] = [];
  const { fail, script, ...options } = agents;
  const transport = new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      ...(decisions ? { decisions } : {}),
      agents: new ScriptedAgentAdapter({
        turns: 1,
        appendNotes: false,
        ...options,
        script: async (input, host) => {
          started.push({
            nodeId: input.nodeId,
            attemptNo: input.attemptNo,
            inputs: input.inputs.map((i) => ({
              name: i.name,
              text: i.text,
              version: i.artifactVersionId ?? null,
            })),
          });
          if (fail?.(input.nodeId, input.attemptNo))
            return { outcome: 'failed', error: `boom ${input.attemptNo}` };
          return (await script?.(input, host)) ?? null;
        },
      }),
    }),
  );
  return { transport, started };
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

const attempts = (p: RunProjection, nodeId: string) =>
  (p.nodeExecutions[nodeId] ?? []).map((id) => p.executions[id]!);

describe('agent retry', () => {
  /** w (retry) → next → output */
  const retrying = (maxAttempts: number, error?: string) =>
    team(
      [
        agent('w', { retry: { maxAttempts } }),
        agent('next', { inputBindings: reads('w') }),
        ...(error ? [agent(error, { inputBindings: [{ kind: 'run_input', name: 'brief' }] })] : []),
        output(...(error ? ['next', error] : ['next'])),
      ],
      [
        edge('w', 'out', 'next'),
        edge('next', 'out', 'output'),
        ...(error ? [edge('w', 'error', error), edge(error, 'out', 'output')] : []),
      ],
    );

  it('compiles retry and error connections as runnable', () => {
    const compiled = compileDefinition(retrying(2, 'fallback'));
    expect(compiled.diagnostics.filter((d) => d.code === 'RUNTIME_UNSUPPORTED')).toEqual([]);
    expect(planRun(retrying(2, 'fallback')).ok).toBe(true);
  });

  it('starts the next attempt of the same Task with the same inputs and the last error', async () => {
    const { transport, started } = runtime({ fail: (node, no) => node === 'w' && no === 1 });
    const { runId } = await run(transport, retrying(2));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [first, second] = attempts(final, 'w');
    expect([first?.attemptNo, second?.attemptNo]).toEqual([1, 2]);
    expect([first?.status, second?.status]).toEqual(['failed', 'succeeded']);
    expect(second?.taskId).toBe(first?.taskId);
    expect(second?.previousExecutionId).toBe(first?.executionId);
    const [one, two] = started.filter((s) => s.nodeId === 'w');
    expect(two?.inputs.slice(0, -1)).toEqual(one?.inputs);
    expect(two?.inputs.at(-1)).toMatchObject({ name: 'previous_attempt_error', text: 'boom 1' });
    expect(attempts(final, 'next')).toHaveLength(1);
  });

  it('takes the error port after the last attempt and tells that agent what failed', async () => {
    const { transport, started } = runtime({ fail: (node) => node === 'w' });
    const { runId } = await run(transport, retrying(1, 'fallback'));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(attempts(final, 'w').map((e) => e.status)).toEqual(['failed', 'failed']);
    expect(attempts(final, 'next')).toHaveLength(0);
    const fallback = started.find((s) => s.nodeId === 'fallback');
    const told = fallback?.inputs.find((i) => i.name === 'step_error')?.text ?? '';
    expect(told).toContain('Step w');
    expect(told).toContain('2');
    expect(told).toContain('boom 2');
  });

  it('fails the run when the error port is not connected', async () => {
    const { transport } = runtime({ fail: (node) => node === 'w' });
    const { runId } = await run(transport, retrying(1));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('execution_failed: w');
    expect(attempts(final, 'w')).toHaveLength(2);
  });

  it('does not retry a cancelled execution', async () => {
    const { transport } = runtime({
      script: async (input) => (input.nodeId === 'w' ? { outcome: 'cancelled' } : null),
    });
    const { runId } = await run(transport, retrying(2, 'fallback'));
    const final = await waitForProjection(transport, runId, finished);
    expect(attempts(final, 'w')).toHaveLength(1);
  });
});

describe('router', () => {
  /** w → router → fix → output, or → ship → output */
  const routed = (extra: Record<string, unknown> = {}) =>
    team(
      [
        agent('w'),
        router(extra),
        agent('fix', { inputBindings: reads('w') }),
        agent('ship', { inputBindings: reads('w') }),
        output('fix', 'ship'),
      ],
      [
        edge('w', 'out', 'router'),
        edge('router', 'fix', 'fix'),
        edge('router', 'ship', 'ship'),
        edge('fix', 'out', 'output'),
        edge('ship', 'out', 'output'),
      ],
    );
  const answering = (answer: string) => ({
    reply: (_turn: number, input: { nodeId: string }) =>
      input.nodeId === 'router' ? answer : `work of ${input.nodeId}`,
  });
  const branch = (events: RunEvent[]) =>
    events.flatMap((e) =>
      e.type === 'workflow.branch_selected' && e.payload.nodeId === 'router' ? [e.payload] : [],
    );

  it('compiles a router as runnable and checks its model profile', () => {
    expect(
      compileDefinition(routed()).diagnostics.filter((d) => d.code === 'RUNTIME_UNSUPPORTED'),
    ).toEqual([]);
    const unknown = compileDefinition(routed({ modelProfile: 'nowhere' }), {
      knownModelProfiles: base.roles.map((r) => r.modelProfile),
    });
    expect(unknown.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_MODEL_PROFILE', nodeId: 'router' }),
    );
  });

  it('follows the route a chooser execution submits', async () => {
    const { transport, started } = runtime(answering(' ship\n'));
    const { runId, events } = await run(transport, routed());
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(attempts(final, 'ship')).toHaveLength(1);
    expect(attempts(final, 'fix')).toHaveLength(0);
    // The chooser is an execution of the router itself, with the routes as an input.
    expect(attempts(final, 'router')).toHaveLength(1);
    const chooser = started.find((s) => s.nodeId === 'router');
    const routes = chooser?.inputs.find((i) => i.name === 'routes')?.text ?? '';
    expect(routes).toContain('fix');
    expect(routes).toContain('The draft needs work.');
    expect(chooser?.inputs.map((i) => i.name)).toContain('draft');
    const [selected] = branch(events);
    expect(selected).toMatchObject({
      mode: 'router',
      selectedPort: 'ship',
      targetNodeId: 'ship',
      reasonCode: 'model_route',
    });
    expect(selected?.evidenceRefs.map((r) => r.kind)).toContain('artifact');
  });

  it('asks the person to pick a connected route when the answer is not a route', async () => {
    const { transport } = runtime(answering('I would rather not say.'));
    const { runId, events } = await run(transport, routed());
    const waiting = await waitForProjection(transport, runId, (p) => pendingApproval(p) !== null);
    const approval = pendingApproval(waiting);
    expect(approval).toMatchObject({
      kind: 'route',
      routes: [
        { id: 'fix', label: 'Fix it' },
        { id: 'ship', label: 'Ship it' },
      ],
    });
    const resolve = (payload: Record<string, unknown>) =>
      transport.sendCommand({
        schemaVersion: '0.1',
        commandId: `cmd_${++edgeNo}`,
        runId,
        type: 'resolve_approval',
        expectedControlRevision: waiting.controlRevision,
        payload: {
          approvalId: approval?.approvalId ?? '',
          subjectVersionId: approval?.subjectVersionIds[0] ?? '',
          ...payload,
        },
      } as Parameters<InProcessTransport['sendCommand']>[0]);
    expect((await resolve({ decision: 'approve' })).error?.code).toBe('SCHEMA_INVALID');
    expect((await resolve({ decision: 'approve', routeId: 'elsewhere' })).error?.code).toBe(
      'SCHEMA_INVALID',
    );
    expect((await resolve({ decision: 'approve', routeId: 'fix' })).status).toBe('applied');
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(attempts(final, 'fix')).toHaveLength(1);
    expect(branch(events)[0]).toMatchObject({ selectedPort: 'fix', reasonCode: 'human_route' });
    expect(
      events.find(
        (e) => e.type === 'approval.resolved' && e.payload.approvalId === approval?.approvalId,
      ),
    ).toMatchObject({ payload: { routeId: 'fix' } });
  });

  it('cancels the run when the person rejects the route approval', async () => {
    const { transport } = runtime({
      script: async (input) =>
        input.nodeId === 'router' ? { outcome: 'failed', error: 'chooser down' } : null,
    });
    const { runId } = await run(transport, routed());
    const waiting = await waitForProjection(transport, runId, (p) => pendingApproval(p) !== null);
    const approval = pendingApproval(waiting);
    expect(approval?.kind).toBe('route');
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: `cmd_${++edgeNo}`,
      runId,
      type: 'resolve_approval',
      expectedControlRevision: waiting.controlRevision,
      payload: {
        approvalId: approval?.approvalId ?? '',
        decision: 'reject',
        subjectVersionId: approval?.subjectVersionIds[0] ?? '',
      },
    });
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('cancelled');
    expect(final.statusReason).toBe('rejected: router');
  });

  it('ends with needs_user when the chosen route is not connected', async () => {
    const definition = routed();
    const { transport } = runtime(answering('fix'));
    const { runId } = await run(
      transport,
      team(
        definition.nodes
          .filter((n) => n.id !== 'fix')
          .map((n) => (n.id === 'output' ? output('ship') : n)),
        definition.controlEdges.filter((e) => e.target !== 'fix' && e.source !== 'fix'),
      ),
    );
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('needs_user: router fix');
  });
});
