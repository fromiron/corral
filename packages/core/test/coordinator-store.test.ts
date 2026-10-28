import {
  type AgentAdapter,
  type AgentHandle,
  type AgentHost,
  type AgentStartInput,
  CorralDefinition,
  RunEvent,
  type StartRunRequest,
  type SteerCommand,
} from '@corral/contracts';
import {
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
  type CompiledPlan,
  Coordinator,
  type CoordinatorDeps,
  type DecisionPolicy,
  emptyProjection,
  type GraphRunner,
  InMemoryRunStore,
  InProcessTransport,
  type RunnerCallbacks,
  type RunProjection,
  type RunStore,
  SPEC_HARD_CAPS,
  ToolRefusal,
  waitForProjection,
} from '../src/index.ts';

/** Lets every pending continuation run (no timers in core). */
async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

const settled = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status);

const start = (definition: CorralDefinition, commandId = 'cmd_start'): StartRunRequest => ({
  schemaVersion: '0.1',
  commandId,
  definition,
  mode: 'mock',
});

const steer = (runId: string, executionId: string, commandId = 'cmd_steer'): SteerCommand => ({
  schemaVersion: '0.1',
  commandId,
  runId,
  type: 'steer',
  payload: {
    targetExecutionId: executionId,
    text: 'Primary sources only.',
    delivery: 'next_request',
  },
});

/** Counts agent starts so tests can prove an effect never left the runtime. */
class CountingAdapter implements AgentAdapter {
  readonly started: AgentStartInput[] = [];
  private readonly inner: AgentAdapter;

  constructor(inner: AgentAdapter) {
    this.inner = inner;
  }

  start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle> {
    this.started.push(input);
    return this.inner.start(input, host);
  }
}

/** A RunStore whose writes start failing on demand: a full disk, or a process that died. */
class FailingStore implements RunStore {
  readonly inner = new InMemoryRunStore();
  failWhen: ((projection: RunProjection) => boolean) | null = null;
  dead = false;

  transaction<T>(write: () => T): T {
    if (this.dead) throw new Error('database is gone');
    return this.inner.transaction(write);
  }
  insertRun: RunStore['insertRun'] = (run) => this.inner.insertRun(run);
  appendEvents: RunStore['appendEvents'] = (runId, events) =>
    this.inner.appendEvents(runId, events);
  saveProjection: RunStore['saveProjection'] = (runId, projection) => {
    // Fails after the events were appended in the same transaction.
    if (this.failWhen?.(projection)) throw new Error('disk I/O error');
    this.inner.saveProjection(runId, projection);
  };
  putCommand: RunStore['putCommand'] = (command) => this.inner.putCommand(command);
  putArtifactText: RunStore['putArtifactText'] = (runId, id, text) =>
    this.inner.putArtifactText(runId, id, text);
  getRun: RunStore['getRun'] = (runId) => this.inner.getRun(runId);
  listRuns: RunStore['listRuns'] = () => this.inner.listRuns();
  readEvents: RunStore['readEvents'] = (runId, after, limit) =>
    this.inner.readEvents(runId, after, limit);
  getCommand: RunStore['getCommand'] = (scope, id) => this.inner.getCommand(scope, id);
  getArtifactText: RunStore['getArtifactText'] = (runId, id) =>
    this.inner.getArtifactText(runId, id);
}

function coordinator(
  overrides: Partial<CoordinatorDeps> & { gates?: Gate[]; turns?: number } = {},
) {
  const gates = overrides.gates ?? [];
  let reply = 0;
  const agents =
    overrides.agents ??
    new CountingAdapter(
      new ScriptedAgentAdapter({
        turns: overrides.turns ?? 1,
        beforeReply: () => gates[reply++]?.wait() ?? Promise.resolve(),
      }),
    );
  const instance = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    ...overrides,
    agents,
  });
  return { instance, transport: new InProcessTransport(instance), agents };
}

describe('Coordinator over a RunStore: commit before effect', () => {
  it('a failed commit rolls back and starts no agent', async () => {
    const store = new FailingStore();
    // Fail the transaction that admits the first agent: events are appended, then the
    // projection write throws.
    store.failWhen = (p) => Object.values(p.effects).some((e) => e.kind === 'spawn');
    const { instance, agents } = coordinator({ store });

    const { runId, receipt } = instance.startRun(start(linearCorral(['research'])));
    expect(receipt.status).toBe('applied');
    await drain();

    expect((agents as CountingAdapter).started).toHaveLength(0);
    const events = store.inner.readEvents(runId ?? '', 0);
    expect(events.some((e) => e.type === 'task.created')).toBe(false);
    expect(store.inner.getRun(runId ?? '')?.projection.lastSeq).toBe(events.length);

    // Admission is closed: nothing new is accepted while facts cannot be recorded.
    const second = instance.startRun(start(linearCorral(['writer']), 'cmd_other'));
    expect(second.receipt.error?.code).toBe('STORAGE_UNAVAILABLE');
    expect(second.runId).toBeNull();
  });

  it('stores events, projection and command record together', async () => {
    const store = new InMemoryRunStore();
    const { transport } = coordinator({ store });
    const { runId } = await transport.startRun(start(linearCorral(['research', 'writer'])));
    const final = await waitForProjection(transport, runId ?? '', settled);

    const stored = store.getRun(runId ?? '');
    expect(stored?.projection).toEqual(final);
    const events = store.readEvents(runId ?? '', 0);
    expect(events.reduce(applyEvent, emptyProjection(runId ?? ''))).toEqual(final);
    expect(store.getCommand('*', 'cmd_start')?.runId).toBe(runId);
    for (const id of final.output?.artifactVersionIds ?? []) {
      expect(store.getArtifactText(runId ?? '', id)).toContain('writer');
    }
  });

  it('records each agent start, model request and tool call as an admitted, then settled, effect', async () => {
    const { transport } = coordinator();
    const { runId } = await transport.startRun(start(linearCorral(['research'])));
    const final = await waitForProjection(transport, runId ?? '', settled);
    const effects = Object.values(final.effects);
    expect(effects.map((e) => e.kind).sort()).toEqual(['model_request', 'spawn', 'tool', 'tool']);
    expect(effects.every((e) => e.status === 'settled' && e.outcome === 'succeeded')).toBe(true);
  });
});

describe('Coordinator over a RunStore: restart', () => {
  async function crashMidRequest() {
    const store = new FailingStore();
    const gate = new Gate();
    const first = coordinator({ store, gates: [gate], sessionId: 'backend_a' });
    const { runId } = await first.transport.startRun(start(linearCorral(['writer'])));
    const id = runId ?? '';
    const inFlight = await waitForProjection(first.transport, id, (p) =>
      Object.values(p.effects).some((e) => e.kind === 'model_request'),
    );
    // The receipt of a steer accepted before the crash must survive it.
    const executionId = inFlight.executionOrder[0] ?? '';
    const steered = await first.transport.sendCommand(steer(id, executionId));
    // The process dies: its view of the database is gone for good. The file survives.
    store.dead = true;
    gate.open();
    return { store: store.inner, runId: id, executionId, steered };
  }

  it('marks the unfinished run interrupted and does not re-run it', async () => {
    const { store, runId } = await crashMidRequest();
    const restarted = coordinator({
      store,
      sessionId: 'backend_b',
      ids: new SequentialIdFactory('b'),
    });
    const { projection } = await restarted.transport.getSnapshot(runId);

    expect(projection.status).toBe('interrupted');
    expect(projection.interruptedBy).toBe('backend_b');
    expect(Object.values(projection.executions).map((e) => e.status)).toEqual(['failed']);
    expect(Object.values(projection.effects).every((e) => e.status === 'settled')).toBe(true);
    expect(Object.values(projection.effects).find((e) => e.kind === 'model_request')?.outcome).toBe(
      'unknown',
    );
    expect(projection.budget).toMatchObject({
      spent: 0,
      reserved: 0,
      unknownOutstanding: 4_096,
      modelCalls: 1,
    });
    const recoveredAgain = coordinator({
      store,
      sessionId: 'backend_c',
      ids: new SequentialIdFactory('c'),
    });
    expect((await recoveredAgain.transport.getSnapshot(runId)).projection.budget).toEqual(
      projection.budget,
    );
    const events = store.readEvents(runId, 0);
    for (const event of events) expect(RunEvent.safeParse(event).success).toBe(true);
    expect(events.reduce(applyEvent, emptyProjection(runId))).toEqual(projection);
  });

  it('never calls the agent again for an effect admitted before the restart', async () => {
    const { store } = await crashMidRequest();
    const restarted = coordinator({
      store,
      sessionId: 'backend_b',
      ids: new SequentialIdFactory('b'),
    });
    await drain();
    expect((restarted.agents as CountingAdapter).started).toHaveLength(0);
  });

  it('a command committed before the restart returns the same receipt', async () => {
    const { store, runId, executionId, steered } = await crashMidRequest();
    const restarted = coordinator({
      store,
      sessionId: 'backend_b',
      ids: new SequentialIdFactory('b'),
    });
    const resent = await restarted.transport.sendCommand(steer(runId, executionId));
    expect(resent.commandId).toBe(steered.commandId);
    expect(resent.acceptedSeq).toBe(steered.acceptedSeq);
    expect(resent.error).toBeUndefined();
  });

  it('frees the workspace: a new run can start after the interrupted one', async () => {
    const { store } = await crashMidRequest();
    const restarted = coordinator({
      store,
      sessionId: 'backend_b',
      ids: new SequentialIdFactory('b'),
    });
    const next = await restarted.transport.startRun(start(linearCorral(['writer']), 'cmd_next'));
    expect(next.receipt.status).toBe('applied');
  });
});

describe('Coordinator: concurrent runs, pinned snapshot', () => {
  it('an unconfirmed worker retains its host model slot', async () => {
    const entered = new Gate(),
      finish = new Gate();
    let starts = 0;
    const { transport } = coordinator({
      policy: { ...SPEC_HARD_CAPS, maxModelConcurrency: 1 },
      files: { acquireRun: () => {}, available: () => true, execute: async () => ({}) },
      agents: {
        start: async (_input, host) => {
          const first = starts++ === 0;
          const work = (async () => {
            try {
              await host.prepareModelRequest();
              if (first) {
                entered.open();
                await finish.wait();
              }
              return { outcome: 'failed' as const, terminationMode: 'unconfirmed' as const };
            } catch {
              return { outcome: 'cancelled' as const };
            }
          })();
          return { cancel: async () => {}, waitForSettlement: () => work };
        },
      },
    });
    const definition = linearCorral(['writer']);
    definition.limits.maxModelConcurrency = 1;
    const first = await transport.startRun(start(definition, 'unknown'));
    await entered.wait();
    finish.open();
    await waitForProjection(transport, first.runId ?? '', settled);
    const second = await transport.startRun(start(definition, 'independent'));
    expect(second.runId).not.toBeNull();
    await drain();
    expect(
      Object.keys((await transport.getSnapshot(second.runId ?? '')).projection.modelCalls),
    ).toHaveLength(0);
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_waiter',
      runId: second.runId ?? '',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'capacity unavailable' },
    });
    await waitForProjection(transport, second.runId ?? '', settled);
  });
  it('file restore reserves the canonical target while unrelated sessions run', async () => {
    const entered = new Gate();
    const finish = new Gate();
    const { instance, transport } = coordinator({
      files: {
        worktreeScope: (sessionId) => (sessionId === 'session_alias' ? 'copy_a' : sessionId),
        available: () => false,
        execute: async () => ({}),
      },
    });
    const restoring = instance.withFileRestore(async () => {
      entered.open();
      await finish.wait();
    }, 'copy_a');
    await entered.wait();
    const blocked = await transport.startRun({
      ...start(linearCorral(['writer']), 'same'),
      sessionId: 'session_alias',
    });
    expect(blocked.receipt.error?.code).toBe('RUN_ALREADY_ACTIVE');
    const other = await transport.startRun({
      ...start(linearCorral(['writer']), 'other'),
      sessionId: 'copy_b',
    });
    expect(other.runId).not.toBeNull();
    await expect(instance.withFileRestore(async () => {}, 'session_alias')).rejects.toThrow(
      /idle target/,
    );
    await waitForProjection(transport, other.runId ?? '', settled);
    finish.open();
    await restoring;
    const after = await transport.startRun({
      ...start(linearCorral(['writer']), 'after'),
      sessionId: 'session_alias',
    });
    expect(after.runId).not.toBeNull();
    await waitForProjection(transport, after.runId ?? '', settled);
  });
  it('host model slots stay bounded across runs and wake the next run', async () => {
    const hold = new Gate();
    const observed: string[] = [];
    const agents = new ScriptedAgentAdapter({
      turns: 1,
      beforeReply: async (_turn, input) => {
        observed.push(input.runId);
        if (observed.length === 1) await hold.wait();
      },
    });
    const { transport } = coordinator({
      agents,
      policy: { ...SPEC_HARD_CAPS, maxModelConcurrency: 1 },
    });
    const definition = linearCorral(['writer']);
    definition.limits.maxModelConcurrency = 1;
    const first = await transport.startRun(start(definition, 'first'));
    const second = await transport.startRun(start(definition, 'second'));
    await drain();
    expect(observed).toEqual([first.runId]);
    hold.open();
    await Promise.all(
      [first, second].map(({ runId }) => waitForProjection(transport, runId ?? '', settled)),
    );
    expect(observed).toEqual([first.runId, second.runId]);
  });

  it('worker starts only after its file snapshot has been pinned', async () => {
    const ready = new Gate();
    const released: string[] = [];
    const { transport, agents } = coordinator({
      files: {
        acquireRun: () => {},
        prepareRun: () => ready.wait(),
        releaseRun: (id, confirmed) => {
          if (confirmed) released.push(id);
        },
        available: () => true,
        execute: async () => ({}),
      },
    });
    const { runId } = await transport.startRun(start(linearCorral(['writer'])));
    await drain();
    expect((agents as CountingAdapter).started).toHaveLength(0);
    ready.open();
    await waitForProjection(transport, runId ?? '', settled);
    expect((agents as CountingAdapter).started).toHaveLength(1);
    expect(released).toContain(runId);
  });

  it('cancelling a queued host request neither cancels nor starves other runs', async () => {
    const hold = new Gate();
    const observed: string[] = [];
    const agents = new ScriptedAgentAdapter({
      turns: 1,
      beforeReply: async (_turn, input) => {
        observed.push(input.runId);
        if (observed.length === 1) await hold.wait();
      },
    });
    const { transport } = coordinator({
      agents,
      policy: { ...SPEC_HARD_CAPS, maxModelConcurrency: 1 },
    });
    const definition = linearCorral(['writer']);
    definition.limits.maxModelConcurrency = 1;
    const first = await transport.startRun(start(definition, 'first'));
    const cancelled = await transport.startRun(start(definition, 'middle'));
    const last = await transport.startRun(start(definition, 'last'));
    await drain();
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_middle',
      runId: cancelled.runId ?? '',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'cancel queued request' },
    });
    await waitForProjection(transport, cancelled.runId ?? '', settled);
    expect(observed).toEqual([first.runId]);
    hold.open();
    await Promise.all(
      [first, last].map(({ runId }) => waitForProjection(transport, runId ?? '', settled)),
    );
    expect(observed).toEqual([first.runId, last.runId]);
  });

  it('admits independent runs without replacing the first run', async () => {
    const gate = new Gate();
    const { transport, agents } = coordinator({ gates: [gate] });
    const first = await transport.startRun(start(linearCorral(['research'])));
    const second = await transport.startRun(start(linearCorral(['writer']), 'cmd_second'));
    expect(second.runId).not.toBeNull();
    expect(second.receipt.status).toBe('applied');
    gate.open();
    await waitForProjection(transport, first.runId ?? '', settled);
    await waitForProjection(transport, second.runId ?? '', settled);
    expect((agents as CountingAdapter).started.map((s) => s.nodeId)).toContain('research');
    expect((agents as CountingAdapter).started.map((s) => s.nodeId)).toContain('writer');

    const third = await transport.startRun(start(linearCorral(['writer']), 'cmd_third'));
    expect(third.receipt.status).toBe('applied');
  });

  it('runs from a saved revision keep their snapshot when the Corral changes', async () => {
    const saved = new Map<string, CorralDefinition>();
    const definition = linearCorral(['writer'], 'saved');
    saved.set('saved@1', definition);
    const { transport, agents } = coordinator({
      corrals: { getDefinition: (id, revision) => saved.get(`${id}@${revision}`) ?? null },
    });
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_saved',
      corralId: 'saved',
      definitionRevision: 1,
      mode: 'mock',
    });
    expect(receipt.status).toBe('applied');
    // Editing the saved Corral afterwards (a new revision) must not reach the run.
    const edited = JSON.parse(JSON.stringify(definition)) as CorralDefinition;
    const role = edited.roles[0];
    if (role) role.prompt = 'Act as someone else.';
    saved.set('saved@1', edited);

    await waitForProjection(transport, runId ?? '', settled);
    expect((agents as CountingAdapter).started[0]?.role.prompt).toBe('Act as writer.');

    const missing = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_missing',
      corralId: 'saved',
      definitionRevision: 9,
      mode: 'mock',
    });
    expect(missing.receipt.error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('a resent start returns the stored receipt even if the revision is gone', async () => {
    const saved = new Map<string, CorralDefinition>([['saved@1', linearCorral(['w'], 'saved')]]);
    const { transport } = coordinator({
      corrals: { getDefinition: (id, revision) => saved.get(`${id}@${revision}`) ?? null },
    });
    const request = {
      schemaVersion: '0.1' as const,
      commandId: 'cmd_saved',
      corralId: 'saved',
      definitionRevision: 1,
      mode: 'mock' as const,
    };
    const first = await transport.startRun(request);
    saved.clear();
    const again = await transport.startRun(request);
    expect(again).toEqual(first);
  });
});

describe('Coordinator: activations', () => {
  /** A runner that replays a step, as a resumed or retried graph engine may. */
  class ReplayingRunner implements GraphRunner {
    async run(plan: CompiledPlan, callbacks: RunnerCallbacks) {
      const first = plan.order[0] ?? '';
      const [a, b] = await Promise.all([
        callbacks.activate(first, null),
        callbacks.activate(first, null),
      ]);
      const again = await callbacks.activate(first, null);
      if (!a.ok || !b.ok || !again.ok)
        return { kind: 'failed' as const, nodeId: first, reason: 'x' };
      await callbacks.finalize('output');
      return { kind: 'finished' as const, outputNodeId: 'output' };
    }
  }

  it('a duplicate activation of the same step creates no second Task', async () => {
    const { transport, agents } = coordinator({ runner: new ReplayingRunner() });
    const { runId } = await transport.startRun(start(linearCorral(['research'])));
    const final = await waitForProjection(transport, runId ?? '', settled);
    expect(final.status).toBe('succeeded');
    expect(Object.keys(final.tasks)).toHaveLength(1);
    expect((agents as CountingAdapter).started).toHaveLength(1);
  });

  it('a runner cannot finish a run by itself: only finalized output ends it', async () => {
    const lying: GraphRunner = { run: async () => ({ kind: 'finished', outputNodeId: 'output' }) };
    const { transport } = coordinator({ runner: lying });
    const { runId } = await transport.startRun(start(linearCorral(['research'])));
    const final = await waitForProjection(transport, runId ?? '', settled);
    expect(final.status).toBe('failed');
    expect(final.output).toBeNull();
    expect(final.statusReason).toContain('runner_finished_without_output');
  });

  it('each Loop round of a node is a separate execution', async () => {
    const script: Record<string, string[]> = {
      review_decision: ['revise', 'pass'],
      approval: ['approve'],
    };
    const decisions: DecisionPolicy = {
      decide: async ({ nodeId }) => script[nodeId]?.shift() ?? 'no answer',
    };
    const definition = CorralDefinition.parse(researchTeam);
    const output = definition.nodes.find((n) => n.type === 'output');
    if (output?.type === 'output') output.requireApproval = false;
    const { transport } = coordinator({ decisions });
    const { runId, receipt } = await transport.startRun(start(definition));
    expect(receipt.status).toBe('applied');
    const final = await waitForProjection(transport, runId ?? '', settled);

    expect(final.status).toBe('succeeded');
    const writes = final.nodeExecutions.write ?? [];
    expect(writes).toHaveLength(2);
    const [round1, round2] = writes.map((id) => final.executions[id]);
    expect(round1?.executionId).not.toBe(round2?.executionId);
    expect(round1?.taskId).not.toBe(round2?.taskId);
    expect(round1?.iterationId).not.toBe(round2?.iterationId);
    const iterations = (final.loopIterations.review_loop ?? []).map((id) => final.iterations[id]);
    expect(iterations.map((i) => [i?.no, i?.outcome])).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
    expect(iterations[0]?.criteriaVersionId).toBe(iterations[1]?.criteriaVersionId);
  });

  it('runs Decision steps with the built-in review and approval decisions (P5)', async () => {
    const { transport } = coordinator();
    const { runId, receipt } = await transport.startRun(
      start(CorralDefinition.parse(researchTeam)),
    );
    expect(receipt.status).toBe('applied');
    const waiting = await waitForProjection(
      transport,
      runId ?? '',
      (p) => p.status === 'awaiting_user',
    );
    expect(Object.values(waiting.approvals)[0]?.kind).toBe('user_action');
  });
});

it('preserves structured terminal ownership in a rejected start receipt', async () => {
  const owner = {
    kind: 'terminal' as const,
    id: 'custom_owner',
    sessionId: 'session',
    state: 'uncertain' as const,
  };
  const { transport } = coordinator({
    files: {
      acquireRun: () => {
        throw new ToolRefusal('RUN_ALREADY_ACTIVE', 'termination unconfirmed', owner);
      },
      available: () => true,
      execute: async () => ({}),
    },
  });
  const result = await transport.startRun({
    ...start(linearCorral(['writer']), 'blocked_terminal'),
    sessionId: 'session',
  });
  expect(result.runId).toBeNull();
  expect(result.receipt.error).toEqual({
    code: 'RUN_ALREADY_ACTIVE',
    message: 'termination unconfirmed',
    owner,
  });
});
