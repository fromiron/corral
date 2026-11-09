import {
  type AgentStartInput,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type RunCommand,
  type RunEvent,
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
  Coordinator,
  type DecisionPolicy,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// docs/specs/features/fork-and-breakpoints.md

const SESSION = 'session_fork';
const finished = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const pending = (p: RunProjection) =>
  Object.values(p.approvals).find((a) => a.status === 'pending') ?? null;

let commandNo = 0;
const commandId = () => `cmd_fb_${++commandNo}`;

/**
 * A runtime with saved teams by `corralId@revision`. Agents named in `held` wait at their gate;
 * every started execution is recorded with the inputs it received.
 */
function runtime(options: { held?: Record<string, Gate>; decisions?: DecisionPolicy } = {}) {
  const saved = new Map<string, CorralDefinition>();
  const store = new InMemoryRunStore();
  const started: { runId: string; input: AgentStartInput }[] = [];
  const waiters: { runId: string; nodeId: string; resolve: () => void }[] = [];
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    corrals: { getDefinition: (id, revision) => saved.get(`${id}@${revision}`) ?? null },
    ...(options.decisions ? { decisions: options.decisions } : {}),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      beforeReply: async (_turn, input) => {
        started.push({ runId: input.runId, input });
        for (const waiter of [...waiters])
          if (waiter.runId === input.runId && waiter.nodeId === input.nodeId) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        await options.held?.[input.nodeId]?.wait();
      },
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const save = (id: string, revision: number, definition: CorralDefinition) =>
    saved.set(`${id}@${revision}`, JSON.parse(JSON.stringify(definition)) as CorralDefinition);
  const start = async (
    corralId: string,
    definitionRevision: number,
    extra: Record<string, unknown> = {},
  ) =>
    transport.startRun({
      schemaVersion: '0.1',
      commandId: commandId(),
      corralId,
      definitionRevision,
      mode: 'mock',
      sessionId: SESSION,
      ...extra,
    } as Parameters<InProcessTransport['startRun']>[0]);
  const run = async (corralId: string, revision: number, extra: Record<string, unknown> = {}) => {
    const { runId, receipt } = await start(corralId, revision, extra);
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    return runId;
  };
  /** Resolves once the agent of `nodeId` has started in that run. */
  const reached = (runId: string, nodeId: string) =>
    started.some((s) => s.runId === runId && s.input.nodeId === nodeId)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ runId, nodeId, resolve }));
  const nodesStarted = (runId: string) =>
    started.filter((s) => s.runId === runId).map((s) => s.input.nodeId);
  const inputOf = (runId: string, nodeId: string) =>
    started.find((s) => s.runId === runId && s.input.nodeId === nodeId)?.input;
  const events = (runId: string) => store.readEvents(runId, 0);
  const submit = (runId: string, command: Record<string, unknown>) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: commandId(),
      runId,
      ...command,
    } as RunCommand);
  return {
    coordinator,
    transport,
    store,
    save,
    start,
    run,
    nodesStarted,
    reached,
    inputOf,
    events,
    submit,
    wait: (runId: string, until: (p: RunProjection) => boolean) =>
      waitForProjection(transport, runId, until),
  };
}

/** The last completed submission of a node in a run. */
function submitted(p: RunProjection, nodeId: string): string[] {
  for (const id of [...(p.nodeExecutions[nodeId] ?? [])].reverse()) {
    const task = p.tasks[p.executions[id]?.taskId ?? ''];
    if (task?.status === 'completed') return task.submittedArtifactVersionIds;
  }
  return [];
}

const forkedFrom = (events: RunEvent[]) => {
  const started = events.find((e) => e.type === 'run.started');
  return started?.type === 'run.started' ? started.payload.forkedFrom : undefined;
};

const abc = () => linearCorral(['a', 'b', 'c'], 'abc');

describe('fork', () => {
  it('starts a new run at a middle step with the edited team and copies earlier results', async () => {
    const r = runtime();
    r.save('abc', 1, abc());
    const source = await r.run('abc', 1);
    const done = await r.wait(source, finished);
    expect(done.status).toBe('succeeded');
    const sourceEvents = r.events(source);
    const [aVersion] = submitted(done, 'a');
    const aText = r.store.getArtifactText(source, aVersion ?? '');
    expect(aText).toBeTruthy();

    const edited = abc();
    const bRole = edited.roles.find((role) => role.id === 'b_role');
    if (bRole) bRole.prompt = 'Act as an edited b.';
    edited.input = { brief: 'A different brief.', criteria: ['Different criteria.'] };
    r.save('abc', 2, edited);

    const fork = await r.run('abc', 2, { forkFrom: { runId: source, nodeId: 'b' } });
    const final = await r.wait(fork, finished);
    expect(final.status).toBe('succeeded');
    expect(r.nodesStarted(fork)).toEqual(['b', 'c']);

    const b = r.inputOf(fork, 'b');
    expect(b?.role.prompt).toBe('Act as an edited b.');
    const previous = b?.inputs.find((i) => i.name === 'previous');
    expect(previous?.text).toBe(aText);
    expect(previous?.artifactVersionId).not.toBe(aVersion);
    expect(forkedFrom(r.events(fork))).toEqual({
      runId: source,
      nodeId: 'b',
      carried: [{ nodeId: 'a', artifactVersionIds: [previous?.artifactVersionId] }],
    });
    // The request and criteria come from the source run.
    const snapshot = r.coordinator.getRunSnapshot(fork);
    expect(snapshot?.definition.input).toEqual(
      r.coordinator.getRunSnapshot(source)?.definition.input,
    );
    expect(snapshot?.definition.roles.find((role) => role.id === 'b_role')?.prompt).toBe(
      'Act as an edited b.',
    );
    // The source run is unchanged; only its body lifetime ends, a later run having succeeded.
    const after = r.events(source);
    expect(after.slice(0, sourceEvents.length)).toEqual(sourceEvents);
    expect(after.slice(sourceEvents.length).map((e) => e.type)).toEqual([
      'artifact.content_released',
    ]);
  });

  it('forks again from a forked run, copying results the fork carried', async () => {
    const r = runtime();
    const definition = abc();
    const c = definition.nodes.find((n) => n.id === 'c');
    if (c?.type === 'agent')
      c.inputBindings.push({ kind: 'task_output', name: 'first', sourceNodeId: 'a' });
    r.save('abc', 1, definition);
    const source = await r.run('abc', 1);
    const aText = r.store.getArtifactText(
      source,
      submitted(await r.wait(source, finished), 'a')[0] ?? '',
    );
    const first = await r.run('abc', 1, { forkFrom: { runId: source, nodeId: 'b' } });
    const middle = await r.wait(first, finished);
    expect(middle.status).toBe('succeeded');
    const bText = r.store.getArtifactText(first, submitted(middle, 'b')[0] ?? '');

    const second = await r.run('abc', 1, { forkFrom: { runId: first, nodeId: 'c' } });
    expect((await r.wait(second, finished)).status).toBe('succeeded');
    expect(r.nodesStarted(second)).toEqual(['c']);
    const inputs = r.inputOf(second, 'c')?.inputs ?? [];
    expect(inputs.find((i) => i.name === 'first')?.text).toBe(aText);
    expect(inputs.find((i) => i.name === 'previous')?.text).toBe(bText);
    expect(
      forkedFrom(r.events(second))
        ?.carried.map((c) => c.nodeId)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('starts at a top-level Loop and runs its rounds again', async () => {
    const r = runtime({ decisions: { decide: async () => 'pass' } });
    r.save('looped', 1, looped());
    const source = await r.run('looped', 1);
    expect((await r.wait(source, finished)).status).toBe('succeeded');
    const fork = await r.run('looped', 1, { forkFrom: { runId: source, nodeId: 'loop' } });
    expect((await r.wait(fork, finished)).status).toBe('succeeded');
    expect(r.nodesStarted(fork)).toEqual(['w', 'rv']);
  });

  it('refuses a step inside a parallel branch or a Loop, an Output, a callable Agent and an unknown step', async () => {
    const r = runtime({ decisions: { decide: async () => 'pass' } });
    r.save('fan', 1, fanOut());
    r.save('looped', 1, looped());
    const fan = await r.run('fan', 1);
    // Its own session, so its success does not end the fan run's step results.
    const loopRun = await r.run('looped', 1, { sessionId: 'session_loop' });
    await r.wait(fan, finished);
    await r.wait(loopRun, finished);
    const runsBefore = r.coordinator.listRuns().length;
    const refusal = async (corralId: string, runId: string, nodeId: string, sessionId = SESSION) =>
      (await r.start(corralId, 1, { sessionId, forkFrom: { runId, nodeId } })).receipt.error?.code;
    expect(await refusal('fan', fan, 'x')).toBe('GRAPH_INVALID');
    expect(await refusal('fan', fan, 'output')).toBe('GRAPH_INVALID');
    expect(await refusal('fan', fan, 'nowhere')).toBe('TARGET_NOT_FOUND');
    expect(await refusal('looped', loopRun, 'w', 'session_loop')).toBe('GRAPH_INVALID');
    expect(r.coordinator.listRuns()).toHaveLength(runsBefore);
    // After the Join, and the start step, can be forked.
    expect(await refusal('fan', fan, 'm')).toBeUndefined();
    expect(await refusal('fan', fan, 'p')).toBeUndefined();
  });

  it('refuses a fork from a callable Agent', async () => {
    const r = runtime();
    const definition = collaborationCorral('collab');
    r.save('collab', 1, definition);
    const source = await r.run('collab', 1);
    await r.wait(source, finished);
    const callable = definition.nodes.find(
      (n) => n.type === 'agent' && n.invocation === 'callable',
    );
    expect(callable).toBeDefined();
    const { receipt } = await r.start('collab', 1, {
      forkFrom: { runId: source, nodeId: callable?.id },
    });
    expect(receipt.error?.code).toBe('GRAPH_INVALID');
  });

  it('refuses when a needed earlier result was never submitted', async () => {
    const a = new Gate();
    const r = runtime({ held: { a } });
    r.save('abc', 1, abc());
    const source = await r.run('abc', 1);
    await r.reached(source, 'a');
    r.submit(source, { type: 'cancel', payload: { scope: { kind: 'run' }, reason: 'test' } });
    a.open();
    expect((await r.wait(source, finished)).status).toBe('cancelled');
    const { runId, receipt } = await r.start('abc', 1, {
      forkFrom: { runId: source, nodeId: 'b' },
    });
    expect(runId).toBeNull();
    expect(receipt.error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('keeps step results until a later run in the session succeeds', async () => {
    const r = runtime();
    r.save('abc', 1, abc());
    const source = await r.run('abc', 1);
    const [aVersion] = submitted(await r.wait(source, finished), 'a');
    expect(r.coordinator.getArtifactText(source, aVersion ?? '')).toBeTruthy();

    const later = await r.run('abc', 1);
    expect((await r.wait(later, finished)).status).toBe('succeeded');
    expect(r.coordinator.getArtifactText(source, aVersion ?? '')).toBeNull();
    const { receipt } = await r.start('abc', 1, { forkFrom: { runId: source, nodeId: 'b' } });
    expect(receipt.error?.code).toBe('TARGET_NOT_FOUND');
    // The later run itself can still be forked.
    const { receipt: fresh } = await r.start('abc', 1, { forkFrom: { runId: later, nodeId: 'b' } });
    expect(fresh.error ?? null).toBeNull();
  });

  it('refuses an unfinished run and a run of another session', async () => {
    const a = new Gate();
    const r = runtime({ held: { a } });
    r.save('abc', 1, abc());
    const running = await r.run('abc', 1);
    await r.reached(running, 'a');
    const busy = await r.start('abc', 1, { forkFrom: { runId: running, nodeId: 'b' } });
    expect(busy.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    a.open();
    await r.wait(running, finished);
    const other = await r.start('abc', 1, {
      sessionId: 'session_other',
      forkFrom: { runId: running, nodeId: 'b' },
    });
    expect(other.receipt.error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('refuses a fork that also sets the input, a start point or references', async () => {
    const r = runtime();
    r.save('abc', 1, abc());
    const source = await r.run('abc', 1);
    await r.wait(source, finished);
    const forkFrom = { runId: source, nodeId: 'b' };
    for (const extra of [
      { input: { brief: 'Other.', criteria: ['x'] } },
      { startFrom: { runId: source, artifactVersionId: 'artifact_version_1' } },
      { references: [{ kind: 'run', runId: source }] },
    ]) {
      const { receipt } = await r.start('abc', 1, { forkFrom, ...extra });
      expect(receipt.error?.code).toBe('SCHEMA_INVALID');
    }
  });

  it('returns the same result for a resent fork', async () => {
    const r = runtime();
    r.save('abc', 1, abc());
    const source = await r.run('abc', 1);
    await r.wait(source, finished);
    const request = {
      schemaVersion: '0.1' as const,
      commandId: 'cmd_fork_again',
      corralId: 'abc',
      definitionRevision: 1,
      mode: 'mock' as const,
      sessionId: SESSION,
      forkFrom: { runId: source, nodeId: 'b' },
    };
    const first = await r.transport.startRun(request);
    const again = await r.transport.startRun(request);
    expect(first.runId).toBeTruthy();
    expect(again).toEqual(first);
  });
});

describe('breakpoints', () => {
  const ab = () => linearCorral(['a', 'b'], 'ab');
  const changed = (events: RunEvent[]) =>
    events.flatMap((e) => (e.type === 'breakpoints.changed' ? [e.payload.nodeIds] : []));

  it('pauses before a step, then starts it with the settings patched meanwhile', async () => {
    const r = runtime();
    r.save('ab', 1, ab());
    const runId = await r.run('ab', 1, { breakpoints: ['b'] });
    const waiting = await r.wait(runId, (p) => pending(p) !== null);
    const approval = pending(waiting);
    expect(approval?.kind).toBe('breakpoint');
    expect(approval?.nodeId).toBe('b');
    expect(approval?.subjectVersionIds).toEqual(submitted(waiting, 'a'));
    expect(r.nodesStarted(runId)).toEqual(['a']);
    expect(changed(r.events(runId))).toEqual([['b']]);

    const patched = r.submit(runId, {
      type: 'patch',
      expectedControlRevision: waiting.controlRevision,
      payload: { kind: 'node_future', nodeId: 'b', prompt: 'Act as a patched b.' },
    });
    expect(patched.error ?? null).toBeNull();
    const now = await r.wait(runId, (p) => p.controlRevision > waiting.controlRevision);
    const resolved = r.submit(runId, {
      type: 'resolve_approval',
      expectedControlRevision: now.controlRevision,
      payload: {
        approvalId: approval?.approvalId,
        decision: 'approve',
        subjectVersionId: approval?.subjectVersionIds[0],
      },
    });
    expect(resolved.error ?? null).toBeNull();
    expect((await r.wait(runId, finished)).status).toBe('succeeded');
    expect(r.inputOf(runId, 'b')?.role.prompt).toBe('Act as a patched b.');
  });

  it('cancels the run when the person stops at a breakpoint', async () => {
    const r = runtime();
    r.save('ab', 1, ab());
    const runId = await r.run('ab', 1, { breakpoints: ['b'] });
    const waiting = await r.wait(runId, (p) => pending(p) !== null);
    const approval = pending(waiting);
    r.submit(runId, {
      type: 'resolve_approval',
      expectedControlRevision: waiting.controlRevision,
      payload: {
        approvalId: approval?.approvalId,
        decision: 'reject',
        subjectVersionId: approval?.subjectVersionIds[0],
      },
    });
    expect((await r.wait(runId, finished)).status).toBe('cancelled');
    expect(r.nodesStarted(runId)).toEqual(['a']);
    const cancel = r.events(runId).find((e) => e.type === 'cancel.requested');
    expect(cancel?.type === 'cancel.requested' && cancel.payload).toMatchObject({
      scope: { kind: 'run' },
      reason: 'breakpoint_rejected',
    });
  });

  it('applies a breakpoint set during the run from the next step', async () => {
    const a = new Gate();
    const r = runtime({ held: { a } });
    r.save('abc', 1, abc());
    const runId = await r.run('abc', 1);
    await r.reached(runId, 'a');
    const set = r.submit(runId, { type: 'set_breakpoints', payload: { nodeIds: ['c'] } });
    expect(set.status).toBe('applied');
    // The same list again changes nothing.
    r.submit(runId, { type: 'set_breakpoints', payload: { nodeIds: ['c'] } });
    a.open();
    const waiting = await r.wait(runId, (p) => pending(p) !== null);
    expect(pending(waiting)?.nodeId).toBe('c');
    expect(r.nodesStarted(runId)).toEqual(['a', 'b']);
    expect(changed(r.events(runId))).toEqual([['c']]);
    expect(waiting.breakpoints).toEqual(['c']);
  });

  it('holds only the branch whose step has a breakpoint', async () => {
    const r = runtime();
    r.save('fan', 1, fanOut());
    const runId = await r.run('fan', 1, { breakpoints: ['x'] });
    const waiting = await r.wait(runId, (p) => pending(p) !== null && submitted(p, 'y').length > 0);
    expect(pending(waiting)?.nodeId).toBe('x');
    expect(r.nodesStarted(runId)).not.toContain('x');
    const approval = pending(waiting);
    r.submit(runId, {
      type: 'resolve_approval',
      expectedControlRevision: waiting.controlRevision,
      payload: {
        approvalId: approval?.approvalId,
        decision: 'approve',
        subjectVersionId: approval?.subjectVersionIds[0],
      },
    });
    expect((await r.wait(runId, finished)).status).toBe('succeeded');
  });

  it('stops a step inside a Loop before every round', async () => {
    const verdicts = ['revise', 'pass'];
    const r = runtime({ decisions: { decide: async () => verdicts.shift() ?? 'pass' } });
    r.save('looped', 1, looped());
    const runId = await r.run('looped', 1, { breakpoints: ['w'] });
    for (const round of [1, 2]) {
      const waiting = await r.wait(
        runId,
        (p) => pending(p)?.nodeId === 'w' && (p.loopIterations.loop?.length ?? 0) === round,
      );
      const approval = pending(waiting);
      r.submit(runId, {
        type: 'resolve_approval',
        expectedControlRevision: waiting.controlRevision,
        payload: {
          approvalId: approval?.approvalId,
          decision: 'approve',
          subjectVersionId: approval?.subjectVersionIds[0],
        },
      });
    }
    expect((await r.wait(runId, finished)).status).toBe('succeeded');
    expect(r.nodesStarted(runId).filter((id) => id === 'w')).toHaveLength(2);
  });

  it('refuses a breakpoint on an Output or a callable Agent', async () => {
    const a = new Gate();
    const r = runtime({ held: { a } });
    r.save('abc', 1, abc());
    const definition = collaborationCorral('collab');
    r.save('collab', 1, definition);
    const atStart = await r.start('abc', 1, { breakpoints: ['output'] });
    expect(atStart.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    const callable = definition.nodes.find(
      (n) => n.type === 'agent' && n.invocation === 'callable',
    );
    const collab = await r.start('collab', 1, { breakpoints: [callable?.id] });
    expect(collab.receipt.error?.code).toBe('TARGET_NOT_FOUND');

    const runId = await r.run('abc', 1, { breakpoints: ['b'] });
    await r.reached(runId, 'a');
    const set = r.submit(runId, { type: 'set_breakpoints', payload: { nodeIds: ['c', 'output'] } });
    expect(set.error?.code).toBe('TARGET_NOT_FOUND');
    const current = await r.wait(runId, () => true);
    expect(current.breakpoints).toEqual(['b']);
    a.open();
  });

  it('closes an open breakpoint when the run is cancelled', async () => {
    const r = runtime();
    r.save('ab', 1, ab());
    const runId = await r.run('ab', 1, { breakpoints: ['b'] });
    const waiting = await r.wait(runId, (p) => pending(p) !== null);
    const approvalId = pending(waiting)?.approvalId ?? '';
    r.submit(runId, { type: 'cancel', payload: { scope: { kind: 'run' }, reason: 'test' } });
    const final = await r.wait(runId, finished);
    expect(final.status).toBe('cancelled');
    expect(final.approvals[approvalId]?.status).not.toBe('pending');
    expect(r.nodesStarted(runId)).toEqual(['a']);
  });
});

// ── definitions ──────────────────────────────────────────────────────────────

const base = Definition.parse(researchTeam);
let edgeNo = 0;
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') =>
  ({ id: `fe${++edgeNo}`, source, sourcePort, target, targetPort }) as ControlEdge;
const agent = (id: string, source?: string, parentId?: string): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'writer',
  invocation: 'scheduled',
  inputBindings: source
    ? [{ kind: 'task_output', name: 'input', sourceNodeId: source }]
    : [{ kind: 'run_input', name: 'brief' }],
  outputName: 'draft',
  ...(parentId ? { parentId } : {}),
});
const output = (source: string): CorralNode => ({
  id: 'output',
  type: 'output',
  label: 'output',
  inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: source }],
  requireApproval: false,
});
const team = (id: string, entryNodeId: string, nodes: CorralNode[], edges: ControlEdge[]) =>
  Definition.parse({
    ...base,
    id,
    entryNodeId,
    nodes,
    controlEdges: edges,
    capabilityLinks: [],
  });

/** p → x, y → Join j (all) → m → output. */
function fanOut(): CorralDefinition {
  return team(
    'fan',
    'p',
    [
      agent('p'),
      agent('x', 'p'),
      agent('y', 'p'),
      { id: 'j', type: 'join', label: 'j', policy: 'all' },
      agent('m', 'p'),
      output('m'),
    ],
    [
      edge('p', 'out', 'x'),
      edge('p', 'out', 'y'),
      edge('x', 'out', 'j'),
      edge('y', 'out', 'j'),
      edge('j', 'out', 'm'),
      edge('m', 'out', 'output'),
    ],
  );
}

/** start → Loop(w → rv → decision d) → output(w). */
function looped(): CorralDefinition {
  const w: CorralNode = {
    id: 'w',
    type: 'agent',
    label: 'w',
    roleId: 'writer',
    invocation: 'scheduled',
    inputBindings: [
      { kind: 'run_input', name: 'brief' },
      { kind: 'previous_iteration_output', name: 'draft', sourceNodeId: 'w', optional: true },
    ],
    outputName: 'draft',
    parentId: 'loop',
  };
  const rv: CorralNode = {
    id: 'rv',
    type: 'agent',
    label: 'rv',
    roleId: 'reviewer',
    invocation: 'scheduled',
    inputBindings: [
      { kind: 'task_output', name: 'draft', sourceNodeId: 'w' },
      { kind: 'run_input', name: 'criteria' },
    ],
    outputName: 'review',
    parentId: 'loop',
  };
  const d: CorralNode = {
    id: 'd',
    type: 'decision',
    label: 'd',
    mode: 'review',
    rule: 'review_verdict',
    inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'rv' }],
    parentId: 'loop',
  };
  return team(
    'looped',
    'start',
    [
      agent('start'),
      { id: 'loop', type: 'loop', label: 'loop', maxIterations: 3 } as CorralNode,
      w,
      rv,
      d,
      output('w'),
    ],
    [
      edge('start', 'out', 'loop', 'enter'),
      edge('loop', 'body', 'w'),
      edge('w', 'out', 'rv'),
      edge('rv', 'out', 'd'),
      edge('d', 'pass', 'loop', 'exit'),
      edge('d', 'revise', 'loop', 'repeat'),
      edge('loop', 'next', 'output'),
    ],
  );
}
