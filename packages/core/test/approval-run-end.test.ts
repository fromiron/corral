import {
  type AgentAdapter,
  type AgentHost,
  type AgentSettlement,
  type AgentStartInput,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type RunCommand,
  type RunEvent,
  type StartRunRequest,
  TERMINAL_EXECUTION_STATUSES,
} from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

// When a run ends (succeeded, failed, cancelled), the runtime closes every approval still
// waiting, whatever its kind (api-contract, "구현에서 정한 검토·승인 규칙").

/** A store that keeps each commit's events together, to see what one commit held. */
class CommitStore extends InMemoryRunStore {
  commits: RunEvent[][] = [];
  override appendEvents(runId: string, events: readonly RunEvent[]) {
    this.commits.push([...events]);
    super.appendEvents(runId, events);
  }
}

async function drain() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}

const pendingOf = (p: RunProjection) =>
  Object.values(p.approvals).filter((a) => a.status === 'pending');
const resolvedOf = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === 'approval.resolved' ? [e] : []));

/** Each approval was closed at most once, and none waits after the end. */
function closedOnce(events: readonly RunEvent[], projection: RunProjection) {
  const ids = resolvedOf(events).map((e) => e.payload.approvalId);
  expect(ids).toEqual([...new Set(ids)]);
  expect(pendingOf(projection)).toEqual([]);
}

/** The runtime's closing of one approval, as recorded. */
function closing(events: readonly RunEvent[], approvalId: string) {
  const found = resolvedOf(events).filter((e) => e.payload.approvalId === approvalId);
  expect(found).toHaveLength(1);
  return required(found[0]);
}

/** The approvals closed in the commit that ends the run, before its state change. */
function closedInEndingCommit(store: CommitStore, to: string, approvalIds: string[]) {
  const commit = required(
    store.commits.find((events) =>
      events.some((e) => e.type === 'run.state_changed' && e.payload.to === to),
    ),
  );
  const end = commit.findIndex((e) => e.type === 'run.state_changed' && e.payload.to === to);
  for (const approvalId of approvalIds) {
    const at = commit.findIndex(
      (e) => e.type === 'approval.resolved' && e.payload.approvalId === approvalId,
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(end);
  }
}

/** A projection read again from the events alone is the one the Coordinator kept. */
function replays(store: InMemoryRunStore, runId: string, projection: RunProjection) {
  const events = store.readEvents(runId, 0);
  const again = events.reduce(applyEvent, emptyProjection(runId));
  expect(again.approvals).toEqual(projection.approvals);
  expect(again.status).toBe(projection.status);
}

// ── a run driven by hand: each worker's requests, tools and end ─────────────

function manual(
  definition: CorralDefinition = linearCorral(['writer']),
  options: { cancelSettles?: boolean; start?: Partial<StartRunRequest> } = {},
) {
  const store = new CommitStore();
  const clock = new FakeClock();
  const hosts: AgentHost[] = [];
  const inputs: AgentStartInput[] = [];
  const exits: ((result: AgentSettlement) => void)[] = [];
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    policy: SPEC_HARD_CAPS,
    agents: {
      async start(input, host) {
        hosts.push(host);
        inputs.push(input);
        const settled = new Promise<AgentSettlement>((resolve) => exits.push(resolve));
        const index = exits.length - 1;
        return {
          cancel: async () => {
            if (options.cancelSettles !== false) exits[index]?.({ outcome: 'cancelled' });
          },
          waitForSettlement: () => settled,
        };
      },
    },
  });
  const runId = required(
    coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition,
      ...options.start,
    }).runId,
  );
  const projection = () => coordinator.getSnapshot(runId).projection;
  const send = (type: RunCommand['type'], payload: unknown, commandId: string) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId,
      runId,
      type,
      payload,
      expectedControlRevision: projection().controlRevision,
    } as RunCommand);
  const events = () => store.readEvents(runId, 0);
  const answer = (
    approval: { approvalId: string; subjectVersionIds: string[] },
    decision: 'approve' | 'reject',
    commandId: string,
  ) =>
    send(
      'resolve_approval',
      {
        approvalId: approval.approvalId,
        decision,
        subjectVersionId: approval.subjectVersionIds[0],
      },
      commandId,
    );
  return {
    coordinator,
    store,
    clock,
    hosts,
    inputs,
    exits,
    runId,
    projection,
    send,
    events,
    answer,
  };
}
type Manual = ReturnType<typeof manual>;

/** Six replies without progress, then a request that waits on the person. */
async function stall(s: Manual, host: AgentHost) {
  for (let i = 0; i < 6; i++) {
    const permit = await host.prepareModelRequest();
    await host.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text: 'reply',
      usage: { inputTokens: null, outputTokens: 1 },
    });
  }
  return waiting(s, host);
}

/** A request that waits; how it ended, once it does. */
async function waiting(s: Manual, host: AgentHost) {
  const state = { ended: null as 'permitted' | 'stopped' | null };
  const promise = host.prepareModelRequest().then(
    () => {
      state.ended = 'permitted';
    },
    () => {
      state.ended = 'stopped';
    },
  );
  await drain();
  expect(pendingOf(s.projection()).map((a) => a.limit?.kind)).toEqual(['no_progress']);
  return { promise, state };
}

async function writeAndSubmit(host: AgentHost, text: string) {
  const written = await host.invokeTool({ name: 'write_artifact', args: { text } });
  if (!written.ok) throw new Error('write refused');
  const submitted = await host.invokeTool({
    name: 'submit_result',
    args: { artifactVersionIds: [written.result.artifactVersionId] },
  });
  expect(submitted.ok).toBe(true);
}

async function spawnHelper(s: Manual) {
  const parent = required(s.hosts[0]);
  await parent.invokeTool({
    name: 'spawn_subagents',
    args: { tasks: [{ targetNodeId: 'helper', brief: 'Part' }] },
  });
  await drain();
  return { parent, child: required(s.hosts[1]), childId: required(s.inputs[1]).executionId };
}

// ── a run of scripted agents with parallel branches ──────────────────────────

const base = Definition.parse(researchTeam);
const agent = (id: string, source?: string, roleId = 'writer'): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId,
  invocation: 'scheduled',
  inputBindings: source
    ? [{ kind: 'task_output', name: 'input', sourceNodeId: source }]
    : [{ kind: 'run_input', name: 'brief' }],
  outputName: 'draft',
});
const join = (policy: 'all' | 'any'): CorralNode => ({ id: 'j', type: 'join', label: 'j', policy });
const output = (source: string, requireApproval = false): CorralNode => ({
  id: 'output',
  type: 'output',
  label: 'output',
  inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: source }],
  requireApproval,
});
const approvalStep = (id: string): CorralNode => ({
  id,
  type: 'decision',
  label: id,
  mode: 'approval',
  rule: 'human_approval',
  inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }],
});
let n = 0;
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') =>
  ({ id: `e${++n}`, source, sourcePort, target, targetPort }) as ControlEdge;

/** p → a, and another branch → Join j → m → output. */
function forked(
  policy: 'all' | 'any',
  branch: { nodes: CorralNode[]; edges: ControlEdge[] },
  requireApproval = false,
) {
  return Definition.parse({
    ...base,
    entryNodeId: 'p',
    capabilityLinks: [],
    nodes: [
      agent('p'),
      agent('a', 'p'),
      ...branch.nodes,
      join(policy),
      agent('m', 'p'),
      output('m', requireApproval),
    ],
    controlEdges: [
      edge('p', 'out', 'a'),
      edge('a', 'out', 'j'),
      ...branch.edges,
      edge('j', 'out', 'm'),
      edge('m', 'out', 'output'),
    ],
  });
}

/**
 * `a` waits at its gate, then fails; a node in `unconfirmed` never confirms its end when stopped,
 * and its gate settles it so; the other agents reply once.
 */
function scripted(gates: Record<string, Gate>, failing: string[] = ['a'], unconfirmed = '') {
  const store = new CommitStore();
  const clock = new FakeClock();
  const scriptedAgents = new ScriptedAgentAdapter({
    turns: 1,
    appendNotes: false,
    beforeReply: async (_turn, input) => gates[input.nodeId]?.wait(),
    script: async (input) => {
      if (!failing.includes(input.nodeId)) return null;
      await gates[input.nodeId]?.wait();
      return { outcome: 'failed', error: `${input.nodeId} broke` };
    },
  });
  const agents: AgentAdapter = {
    async start(input, host) {
      if (input.nodeId !== unconfirmed) return scriptedAgents.start(input, host);
      const gate = required(gates[unconfirmed]);
      return {
        cancel: async () => {},
        waitForSettlement: async () => {
          await gate.wait();
          return { outcome: 'cancelled', terminationMode: 'unconfirmed' };
        },
      };
    },
  };
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents,
  });
  const transport = new InProcessTransport(coordinator);
  const start = async (definition: CorralDefinition, extra: Partial<StartRunRequest> = {}) => {
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: `cmd_${++n}`,
      definition,
      mode: 'mock',
      ...extra,
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    return runId;
  };
  return { store, coordinator, transport, start };
}

const finished = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const waitingOn = (kind: string) => (p: RunProjection) => pendingOf(p).some((a) => a.kind === kind);

describe('approvals still waiting when a run fails', () => {
  const cases: [string, () => { nodes: CorralNode[]; edges: ControlEdge[] }, string[]?][] = [
    [
      'user_action',
      () => ({
        nodes: [approvalStep('gate')],
        edges: [edge('p', 'out', 'gate'), edge('gate', 'approve', 'j')],
      }),
    ],
    [
      'route',
      () => ({
        nodes: [
          agent('w', 'p'),
          {
            id: 'router',
            type: 'decision',
            label: 'router',
            mode: 'router',
            routes: [
              { id: 'fix', label: 'Fix it' },
              { id: 'ship', label: 'Ship it' },
            ],
            inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'w' }],
          } as CorralNode,
          agent('fix', 'w'),
          agent('ship', 'w'),
        ],
        edges: [
          edge('p', 'out', 'w'),
          edge('w', 'out', 'router'),
          edge('router', 'fix', 'fix'),
          edge('router', 'ship', 'ship'),
          edge('fix', 'out', 'j'),
          edge('ship', 'out', 'j'),
        ],
      }),
      ['a', 'router'],
    ],
    [
      'breakpoint',
      () => ({
        nodes: [agent('b', 'p')],
        edges: [edge('p', 'out', 'b'), edge('b', 'out', 'j')],
      }),
    ],
  ];

  it.each(cases)(
    'closes a %s approval in the commit that fails the run',
    async (kind, branch, failing) => {
      const a = new Gate();
      const s = scripted({ a }, failing);
      const runId = await s.start(
        forked('all', branch()),
        kind === 'breakpoint' ? { breakpoints: ['b'] } : {},
      );
      const asked = await waitForProjection(s.transport, runId, waitingOn(kind));
      const approval = required(pendingOf(asked).find((x) => x.kind === kind));
      a.open();
      const final = await waitForProjection(s.transport, runId, finished);
      expect(final.status).toBe('failed');
      const events = s.store.readEvents(runId, 0);
      closedOnce(events, final);
      expect(closing(events, approval.approvalId).payload).toMatchObject({
        decision: 'reject',
        actor: 'coordinator',
        reason: 'execution_ended',
      });
      closedInEndingCommit(s.store, 'failed', [approval.approvalId]);
      replays(s.store, runId, final);
    },
  );

  it('closes a final output approval when a stopped branch cannot confirm its end', async () => {
    const b = new Gate();
    const s = scripted({ b }, [], 'b');
    const runId = await s.start(
      forked(
        'any',
        { nodes: [agent('b', 'p')], edges: [edge('p', 'out', 'b'), edge('b', 'out', 'j')] },
        true,
      ),
    );
    const asked = await waitForProjection(s.transport, runId, waitingOn('final_output'));
    const approval = required(pendingOf(asked)[0]);
    b.open();
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('failed');
    const events = s.store.readEvents(runId, 0);
    closedOnce(events, final);
    expect(closing(events, approval.approvalId).payload.reason).toBe('execution_ended');
    closedInEndingCommit(s.store, 'failed', [approval.approvalId]);
  });
});

describe('approvals a run ends with', () => {
  it('closes a no-progress approval asked again after a criteria change, when the run is cancelled', async () => {
    const s = manual(Definition.parse(researchTeam));
    await drain();
    await writeAndSubmit(required(s.hosts[0]), 'notes');
    s.exits[0]?.({ outcome: 'succeeded' });
    await drain();
    const writer = required(s.hosts[s.inputs.findIndex((i) => i.nodeId === 'write')]);
    const { promise } = await stall(s, writer);
    const [first] = pendingOf(s.projection());
    const criteria = required(s.projection().currentCriteriaVersionId);
    expect(
      s.send(
        'patch',
        { kind: 'criteria', baseCriteriaVersionId: criteria, criteria: ['New bar.'] },
        'crit',
      ).status,
    ).toBe('applied');
    const [again] = pendingOf(s.projection());
    expect(again).toMatchObject({ kind: 'user_action' });
    expect(again?.limit).toBeUndefined();
    expect(s.projection().approvals[first?.approvalId ?? '']?.status).toBe('stale');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await promise;
    await drain();
    const final = s.projection();
    expect(final.status).toBe('cancelled');
    closedOnce(s.events(), final);
    expect(closing(s.events(), required(again).approvalId).payload.reason).toBe('cancelled');
    const confirmed = s.events().findIndex((e) => e.type === 'cancel.confirmed');
    expect(
      s
        .events()
        .findIndex(
          (e) => e.type === 'approval.resolved' && e.payload.approvalId === again?.approvalId,
        ),
    ).toBeLessThan(confirmed);
    replays(s.store, s.runId, final);
  });

  it('closes a child’s approval when its parent submits and the run succeeds', async () => {
    const s = manual(collaborationCorral());
    await drain();
    const { parent, child } = await spawnHelper(s);
    const childWait = await stall(s, child);
    const [approval] = pendingOf(s.projection());
    await writeAndSubmit(parent, 'notes');
    s.exits[0]?.({ outcome: 'succeeded' });
    await drain();
    expect(s.projection().executions[required(s.inputs[1]).executionId]?.status).toBe('cancelled');
    const writer = required(s.hosts[s.inputs.findIndex((i) => i.nodeId === 'write')]);
    await writeAndSubmit(writer, 'draft');
    s.exits[s.inputs.findIndex((i) => i.nodeId === 'write')]?.({ outcome: 'succeeded' });
    await drain();
    const final = s.projection();
    expect(final.status).toBe('succeeded');
    closedOnce(s.events(), final);
    expect(closing(s.events(), required(approval).approvalId).payload).toMatchObject({
      decision: 'reject',
      reason: 'execution_ended',
    });
    closedInEndingCommit(s.store, 'succeeded', [required(approval).approvalId]);
    // The stopped child's request was told no, once.
    await childWait.promise;
    expect(childWait.state.ended).toBe('stopped');
    // Too late to answer: the approval is closed, and says so.
    expect(final.approvals[required(approval).approvalId]?.status).toBe('rejected');
    const late = s.answer(required(approval), 'approve', 'late');
    expect(late.error?.code).toBe('APPROVAL_STALE');
    replays(s.store, s.runId, final);
  });

  it('closes each approval once when a run cancelled while paused ends', async () => {
    const s = manual();
    await drain();
    const { promise } = await stall(s, required(s.hosts[0]));
    const [approval] = pendingOf(s.projection());
    s.send('pause', { scope: 'run' }, 'pause');
    await drain();
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await promise;
    await drain();
    const final = s.projection();
    expect(final.status).toBe('cancelled');
    closedOnce(s.events(), final);
    expect(closing(s.events(), required(approval).approvalId).payload.reason).toBe('cancelled');
  });

  it('closes each approval once when a cancelled run cannot confirm its end and fails', async () => {
    const s = manual(linearCorral(['writer']), { cancelSettles: false });
    await drain();
    const { promise } = await stall(s, required(s.hosts[0]));
    const [approval] = pendingOf(s.projection());
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await promise;
    s.clock.advance(10_000);
    await drain();
    const final = s.projection();
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('termination_unconfirmed');
    closedOnce(s.events(), final);
    expect(closing(s.events(), required(approval).approvalId).payload.reason).toBe('cancelled');
  });

  it('refuses an answer sent after the cancel request and before its confirmation', async () => {
    const s = manual(linearCorral(['writer']), { cancelSettles: false });
    await drain();
    const { promise } = await stall(s, required(s.hosts[0]));
    const [approval] = pendingOf(s.projection());
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    expect(s.projection().status).toBe('cancelling');
    // The person's own cancel says so while it stops the run, and after.
    expect(s.projection().statusReason).toBe('cancel_requested');
    expect(s.events().some((e) => e.type === 'cancel.confirmed')).toBe(false);
    // Closed at the request, not at the confirmation.
    expect(s.projection().approvals[required(approval).approvalId]?.status).toBe('rejected');
    expect(s.answer(required(approval), 'approve', 'late').error?.code).toBe('APPROVAL_STALE');
    await promise;
    s.exits[0]?.({ outcome: 'cancelled' });
    await drain();
    expect(s.projection().status).toBe('cancelled');
    expect(s.projection().statusReason).toBe('cancel_confirmed');
    closedOnce(s.events(), s.projection());
  });

  it('closes one approval two executions wait on once', async () => {
    const s = manual(collaborationCorral());
    await drain();
    const { parent, child } = await spawnHelper(s);
    const childWait = await stall(s, child);
    const parentWait = await waiting(s, parent);
    const [approval] = pendingOf(s.projection());
    expect(pendingOf(s.projection())).toHaveLength(1);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await childWait.promise;
    await parentWait.promise;
    await drain();
    const final = s.projection();
    expect(final.status).toBe('cancelled');
    closedOnce(s.events(), final);
    closing(s.events(), required(approval).approvalId);
    expect([childWait.state.ended, parentWait.state.ended]).toEqual(['stopped', 'stopped']);
  });

  it('closes no approval when one execution is cancelled; the others keep waiting', async () => {
    const s = manual(collaborationCorral());
    await drain();
    const { parent, child, childId } = await spawnHelper(s);
    const childWait = await stall(s, child);
    const parentWait = await waiting(s, parent);
    const [approval] = pendingOf(s.projection());
    s.send(
      'cancel',
      { scope: { kind: 'execution', executionId: childId }, reason: 'stop it' },
      'cancel_child',
    );
    await drain();
    expect(childWait.state.ended).not.toBe('permitted');
    expect(s.projection().executions[childId]?.status).toBe('cancelled');
    expect(s.projection().approvals[required(approval).approvalId]?.status).toBe('pending');
    expect(resolvedOf(s.events())).toEqual([]);
    expect(parentWait.state.ended).toBeNull();
    expect(s.answer(required(approval), 'approve', 'go_on').status).toBe('applied');
    await parentWait.promise;
    expect(parentWait.state.ended).toBe('permitted');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('keeps a no-progress approval when one attempt fails and the next one joins it', async () => {
    const definition = linearCorral(['writer']);
    const node = required(definition.nodes.find((x) => x.type === 'agent'));
    Object.assign(node, { retry: { maxAttempts: 1 } });
    const s = manual(definition);
    await drain();
    const first = await stall(s, required(s.hosts[0]));
    const [approval] = pendingOf(s.projection());
    s.exits[0]?.({ outcome: 'failed', error: 'worker crashed' });
    await drain();
    expect(first.state.ended).not.toBe('permitted');
    expect(s.hosts).toHaveLength(2);
    expect(s.projection().status).not.toBe('failed');
    expect(s.projection().approvals[required(approval).approvalId]?.status).toBe('pending');
    expect(resolvedOf(s.events())).toEqual([]);
    const second = waiting(s, required(s.hosts[1]));
    const { state } = await second;
    expect(state.ended).toBeNull();
    expect(pendingOf(s.projection())).toHaveLength(1);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('closes a runtime-closed approval only once at the end', async () => {
    const a = new Gate();
    const s = scripted({ a }, []);
    const runId = await s.start(
      forked('any', {
        nodes: [approvalStep('gate')],
        edges: [edge('p', 'out', 'gate'), edge('gate', 'approve', 'j')],
      }),
    );
    const asked = await waitForProjection(s.transport, runId, waitingOn('user_action'));
    const approval = required(pendingOf(asked)[0]);
    a.open();
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const events = s.store.readEvents(runId, 0);
    closedOnce(events, final);
    // The Join withdrew it as the branch stopped; the end adds nothing.
    expect(closing(events, approval.approvalId).payload.reason).toBe('cancelled');
  });

  it('closes the other approvals when the person rejects one and the run ends', async () => {
    const s = scripted({});
    const runId = await s.start(
      Definition.parse({
        ...base,
        entryNodeId: 'p',
        capabilityLinks: [],
        nodes: [
          agent('p'),
          approvalStep('g1'),
          approvalStep('g2'),
          join('all'),
          agent('m', 'p'),
          output('m'),
        ],
        controlEdges: [
          edge('p', 'out', 'g1'),
          edge('p', 'out', 'g2'),
          edge('g1', 'approve', 'j'),
          edge('g2', 'approve', 'j'),
          edge('j', 'out', 'm'),
          edge('m', 'out', 'output'),
        ],
      }),
    );
    const asked = await waitForProjection(s.transport, runId, (p) => pendingOf(p).length === 2);
    const [first, second] = pendingOf(asked);
    await s.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'reject_one',
      runId,
      type: 'resolve_approval',
      expectedControlRevision: asked.controlRevision,
      payload: {
        approvalId: required(first).approvalId,
        decision: 'reject',
        subjectVersionId: required(first).subjectVersionIds[0],
      },
    } as RunCommand);
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('cancelled');
    const events = s.store.readEvents(runId, 0);
    closedOnce(events, final);
    expect(closing(events, required(second).approvalId).payload).toMatchObject({
      actor: 'coordinator',
      reason: 'cancelled',
    });
    closedInEndingCommit(s.store, 'cancelled', [required(second).approvalId]);
    replays(s.store, runId, final);
  });
});

// ── a rejection that ends the run stops the other live branches first ───────

/** Nothing of an execution is recorded after the run's end, and no execution is still live. */
function endedClean(events: readonly RunEvent[], projection: RunProjection) {
  const end = events.findIndex(
    (e) => e.type === 'run.state_changed' && finished({ status: e.payload.to } as RunProjection),
  );
  expect(end).toBeGreaterThanOrEqual(0);
  expect(events.slice(end + 1).filter((e) => e.type.startsWith('execution.'))).toEqual([]);
  expect(
    Object.values(projection.executions).filter((e) => !TERMINAL_EXECUTION_STATUSES.has(e.status)),
  ).toEqual([]);
  expect(
    events.filter(
      (e) => e.type === 'run.state_changed' && finished({ status: e.payload.to } as RunProjection),
    ),
  ).toHaveLength(1);
}

async function reject(
  s: ReturnType<typeof scripted>,
  runId: string,
  approval: { approvalId: string; subjectVersionIds: string[] },
  revision: number,
) {
  return s.transport.sendCommand({
    schemaVersion: '0.1',
    commandId: `reject_${approval.approvalId}`,
    runId,
    type: 'resolve_approval',
    expectedControlRevision: revision,
    payload: {
      approvalId: approval.approvalId,
      decision: 'reject',
      subjectVersionId: approval.subjectVersionIds[0],
    },
  } as RunCommand);
}

/** While its branches stop, the run already gives the rejection as its reason, as it does after. */
function stoppingFor(s: ReturnType<typeof scripted>, runId: string, reason: string) {
  expect(s.coordinator.getSnapshot(runId).projection).toMatchObject({
    status: 'cancelling',
    statusReason: reason,
  });
  const requested = s.store.readEvents(runId, 0).filter((e) => e.type === 'cancel.requested');
  expect(requested.map((e) => e.type === 'cancel.requested' && e.payload.reason)).toEqual([reason]);
}

describe('a rejection that ends the run', () => {
  const router = (): { nodes: CorralNode[]; edges: ControlEdge[] } => ({
    nodes: [
      agent('w', 'p'),
      {
        id: 'router',
        type: 'decision',
        label: 'router',
        mode: 'router',
        routes: [
          { id: 'fix', label: 'Fix it' },
          { id: 'ship', label: 'Ship it' },
        ],
        inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'w' }],
      } as CorralNode,
      agent('fix', 'w'),
      agent('ship', 'w'),
    ],
    edges: [
      edge('p', 'out', 'w'),
      edge('w', 'out', 'router'),
      edge('router', 'fix', 'fix'),
      edge('router', 'ship', 'ship'),
      edge('fix', 'out', 'j'),
      edge('ship', 'out', 'j'),
    ],
  });
  const cases: [string, () => { nodes: CorralNode[]; edges: ControlEdge[] }, string[], string][] = [
    [
      'user_action',
      () => ({
        nodes: [approvalStep('gate')],
        edges: [edge('p', 'out', 'gate'), edge('gate', 'approve', 'j')],
      }),
      [],
      'rejected: gate',
    ],
    ['route', router, ['router'], 'rejected: router'],
  ];

  it.each(cases)(
    'a rejected %s stops the branch still asking its model before the run is cancelled',
    async (kind, branch, failing, reason) => {
      const a = new Gate();
      const s = scripted({ a }, failing);
      const runId = await s.start(forked('all', branch()));
      const asked = await waitForProjection(s.transport, runId, waitingOn(kind));
      const approval = required(pendingOf(asked).find((x) => x.kind === kind));
      const running = (p: RunProjection) =>
        (p.nodeExecutions.a ?? []).some((id) => p.executions[id]?.status === 'active');
      expect(running(asked)).toBe(true);
      expect((await reject(s, runId, approval, asked.controlRevision)).status).toBe('applied');
      // The branch is told to stop; the run is not over while it is still stopping.
      const stopping = await waitForProjection(
        s.transport,
        runId,
        (p) => p.status === 'cancelling',
      );
      expect(finished(stopping)).toBe(false);
      stoppingFor(s, runId, reason);
      a.open();
      const final = await waitForProjection(s.transport, runId, finished);
      expect(final.status).toBe('cancelled');
      expect(final.statusReason).toBe(reason);
      const events = s.store.readEvents(runId, 0);
      endedClean(events, final);
      expect((final.nodeExecutions.a ?? []).map((id) => final.executions[id]?.status)).toEqual([
        'cancelled',
      ]);
      closedOnce(events, final);
      replays(s.store, runId, final);
    },
  );

  it('a rejected final output stops the branch an any Join left still ending', async () => {
    const b = new Gate();
    const s = scripted({ b }, []);
    const runId = await s.start(
      forked(
        'any',
        { nodes: [agent('b', 'p')], edges: [edge('p', 'out', 'b'), edge('b', 'out', 'j')] },
        true,
      ),
    );
    const asked = await waitForProjection(s.transport, runId, waitingOn('final_output'));
    const approval = required(pendingOf(asked)[0]);
    expect((await reject(s, runId, approval, asked.controlRevision)).status).toBe('applied');
    await waitForProjection(s.transport, runId, (p) => p.status === 'cancelling');
    stoppingFor(s, runId, 'final_output_rejected');
    b.open();
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('cancelled');
    expect(final.statusReason).toBe('final_output_rejected');
    endedClean(s.store.readEvents(runId, 0), final);
    replays(s.store, runId, final);
  });

  it('a person cancelling right after the rejection ends the run once', async () => {
    const a = new Gate();
    const s = scripted({ a }, []);
    const runId = await s.start(
      forked('all', {
        nodes: [approvalStep('gate')],
        edges: [edge('p', 'out', 'gate'), edge('gate', 'approve', 'j')],
      }),
    );
    const asked = await waitForProjection(s.transport, runId, waitingOn('user_action'));
    const approval = required(pendingOf(asked)[0]);
    await reject(s, runId, approval, asked.controlRevision);
    const again = await s.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_too',
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    } as RunCommand);
    // It arrives before the rejection has ended anything: an ordinary cancel, as it was.
    expect(again.status).toBe('accepted');
    a.open();
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('cancelled');
    const events = s.store.readEvents(runId, 0);
    endedClean(events, final);
    expect(events.filter((e) => e.type === 'cancel.confirmed').length).toBeLessThanOrEqual(1);
    closedOnce(events, final);
  });

  it('a person cancelling while the rejection stops the branches is taken as during any cancel, and the run ends once', async () => {
    const a = new Gate();
    const s = scripted({ a }, []);
    const runId = await s.start(
      forked('all', {
        nodes: [approvalStep('gate')],
        edges: [edge('p', 'out', 'gate'), edge('gate', 'approve', 'j')],
      }),
    );
    const asked = await waitForProjection(s.transport, runId, waitingOn('user_action'));
    await reject(s, runId, required(pendingOf(asked)[0]), asked.controlRevision);
    await waitForProjection(
      s.transport,
      runId,
      (p) => p.status !== 'awaiting_user' && p.status !== 'running',
    );
    const again = await s.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_late',
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    } as RunCommand);
    // The same receipt as a second cancel while the person's own cancel is stopping the run.
    expect(again.status).toBe('accepted');
    a.open();
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('cancelled');
    endedClean(s.store.readEvents(runId, 0), final);
  });

  it('a rejection with no other live branch ends the run as before, in its commit', async () => {
    const s = scripted({}, []);
    const definition = linearCorral(['writer']);
    const output = required(definition.nodes.find((x) => x.type === 'output'));
    Object.assign(output, { requireApproval: true });
    const runId = await s.start(definition);
    const asked = await waitForProjection(s.transport, runId, waitingOn('final_output'));
    const approval = required(pendingOf(asked)[0]);
    await reject(s, runId, approval, asked.controlRevision);
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('cancelled');
    expect(final.statusReason).toBe('final_output_rejected');
    const events = s.store.readEvents(runId, 0);
    expect(events.some((e) => e.type === 'cancel.requested')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'run.state_changed',
      payload: { from: 'running', to: 'cancelled', reasonCode: 'final_output_rejected' },
    });
    endedClean(events, final);
  });
});
