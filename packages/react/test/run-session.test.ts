import type {
  CorralDefinition,
  Receipt,
  RunCommand,
  RunEvent,
  StreamFrame,
} from '@corral/contracts';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InProcessTransport,
  type TransportHandlers,
} from '@corral/core';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import { createRunSession, type RunSessionState } from '../src/run/session.ts';

function session(gates: Gate[] = []) {
  let reply = 0;
  const transport = new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: 2,
        beforeReply: () => gates[reply++]?.wait() ?? Promise.resolve(),
      }),
    }),
  );
  let n = 0;
  return createRunSession(transport, () => `cmd_test_${++n}`);
}

function until(store: ReturnType<typeof session>, check: (s: RunSessionState) => boolean) {
  return new Promise<RunSessionState>((resolve) => {
    if (check(store.getState())) return resolve(store.getState());
    const stop = store.subscribe((state) => {
      if (check(state)) {
        stop();
        resolve(state);
      }
    });
  });
}

describe('run session', () => {
  it('[TC-WIDGET-001-N] failed opening stays scoped to its requested run and ignores old failures', async () => {
    let failOld!: (error: Error) => void;
    const getRunDefinition = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<CorralDefinition>((_resolve, reject) => {
            failOld = reject;
          }),
      )
      .mockRejectedValueOnce(new Error('current definition unavailable'))
      .mockResolvedValue(linearCorral(['writer']));
    const subscribe = vi.fn(() => () => {});
    const store = createRunSession({ getRunDefinition, subscribe } as never);
    const old = store.getState().open('run_old');
    await store.getState().open('run_current');
    expect(store.getState()).toMatchObject({
      runId: 'run_current',
      projection: null,
      streamError: 'Error: current definition unavailable',
    });
    failOld(new Error('obsolete failure'));
    await old;
    expect(store.getState().streamError).toBe('Error: current definition unavailable');
    await store.getState().open('run_current');
    expect(store.getState().runId).toBe('run_current');
    expect(store.getState().streamError).toBeNull();
    expect(subscribe).toHaveBeenCalledTimes(1);
    store.getState().dispose();
  });

  it('[TC-WIDGET-001-N] retrying a broken current stream replaces its subscription once', async () => {
    let handlers!: TransportHandlers;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_runId, _seq, next: TransportHandlers) => {
      handlers = next;
      return unsubscribe;
    });
    const store = createRunSession({
      getRunDefinition: async () => linearCorral(['writer']),
      subscribe,
    } as never);
    await store.getState().open('run_current');
    handlers.onError?.(new Error('stream disconnected'));
    expect(store.getState().streamError).toContain('stream disconnected');
    await store.getState().open('run_current');
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(store.getState().streamError).toBeNull();
    store.getState().dispose();
  });

  it('explicit artifact retry refreshes only the selected body and excludes late results after navigation', async () => {
    let finishOldRead!: (text: string) => void;
    const getArtifactText = vi
      .fn()
      .mockResolvedValueOnce('invalid cached body')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('verified body')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishOldRead = resolve;
          }),
      );
    const store = createRunSession({
      getRunDefinition: async () => linearCorral(['writer']),
      subscribe: () => () => {},
      getArtifactText,
    } as never);
    await store.getState().open('run_1');
    await store.getState().loadArtifact('plan_1');
    await store.getState().loadArtifact('plan_1');
    expect(getArtifactText).toHaveBeenCalledTimes(1);
    await store.getState().loadArtifact('plan_1', { reload: true });
    expect(store.getState().artifactTexts.plan_1).toBeUndefined();
    await store.getState().loadArtifact('plan_1', { reload: true });
    expect(store.getState().artifactTexts.plan_1).toBe('verified body');
    const oldRead = store.getState().loadArtifact('plan_1', { reload: true });
    await store.getState().open('run_2');
    finishOldRead('late body');
    await oldRead;
    expect(store.getState().artifactTexts.plan_1).toBeUndefined();
    expect(getArtifactText.mock.calls).toEqual(Array(4).fill(['run_1', 'plan_1']));
    store.getState().dispose();
  });

  it('follows a run to completion and loads the output text', async () => {
    const store = session();
    await store.getState().start(linearCorral(['writer']));
    const done = await until(store, (s) => s.outputText !== null);
    expect(done.projection?.status).toBe('succeeded');
    expect(done.outputText).toContain('writer (writer) turn 2');
  });

  it('shows a steer as queued from its receipt, then delivered from committed events', async () => {
    const gates = [new Gate(), new Gate()];
    const store = session(gates);
    await store.getState().start(linearCorral(['writer']));
    const running = await until(store, (s) =>
      Object.values(s.projection?.executions ?? {}).some((e) => e.modelCallIds.length === 1),
    );
    const executionId = running.projection?.executionOrder[0] ?? '';

    const sending = store.getState().steer(executionId, 'Primary sources only.');
    expect(store.getState().pendingCommandIds).toHaveLength(1);
    const receipt = await sending;
    expect(receipt.status).toBe('queued');
    expect(store.getState().pendingCommandIds).toHaveLength(0);

    const queued = await until(store, (s) => (s.projection?.directiveOrder.length ?? 0) === 1);
    const directiveId = queued.projection?.directiveOrder[0] ?? '';
    expect(queued.projection?.directives[directiveId]?.status).toBe('queued');

    for (const gate of gates) gate.open();
    const delivered = await until(
      store,
      (s) => s.projection?.directives[directiveId]?.status === 'delivered',
    );
    expect(delivered.projection?.directives[directiveId]?.modelCallId).toBeTruthy();
  });

  it('[TC-RNS-003-H] refreshes a pending pause receipt when the run is cancelled before pausing', async () => {
    const gate = new Gate();
    const store = session([gate]);
    await store.getState().start(linearCorral(['writer']));
    await until(store, (s) => Object.keys(s.projection?.modelCalls ?? {}).length === 1);
    const pause = await store.getState().sendCommand({ type: 'pause', payload: { scope: 'run' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().receipts[pause.commandId]?.status).toBe('accepted');
    await store.getState().sendCommand({
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'Stop before pause boundary' },
    });
    gate.open();
    await until(store, (s) => s.projection?.status === 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().receipts[pause.commandId]?.status).toBe('cancelled');
    store.getState().dispose();
  });

  it('reopens a finished run from the runtime, with its definition and output', async () => {
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      }),
    );
    const first = createRunSession(transport, () => 'cmd_first');
    await first.getState().start(linearCorral(['writer']));
    const runId = (await until(first, (s) => s.outputText !== null)).runId ?? '';

    // A reloaded page: a new session that only knows the run id.
    const reopened = createRunSession(transport);
    await reopened.getState().open(runId);
    // Opening follows the run's stream; the state arrives as its events replay.
    const state = await until(reopened, (s) => s.outputText !== null);
    expect(state.runId).toBe(runId);
    expect(state.projection?.status).toBe('succeeded');
    expect(state.definition?.id).toBe('linear');
    expect(state.outputText).toContain('writer (writer) turn 1');

    const missing = createRunSession(transport);
    await missing.getState().open('run_gone');
    expect(missing.getState().runId).toBe('run_gone');
    expect(missing.getState().projection).toBeNull();
    expect(missing.getState().missingRunId).toBe('run_gone');
  });

  it('starts from a saved revision when one is given', async () => {
    const requests: unknown[] = [];
    const inner = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
        corrals: { getDefinition: () => linearCorral(['writer'], 'saved') },
      }),
    );
    const transport = Object.assign(Object.create(inner), {
      startRun: (request: Parameters<typeof inner.startRun>[0]) => {
        requests.push(request);
        return inner.startRun(request);
      },
    }) as typeof inner;
    const store = createRunSession(transport, () => 'cmd_saved');
    await store
      .getState()
      .start(linearCorral(['writer'], 'saved'), { corralId: 'saved', definitionRevision: 3 });
    expect(requests).toEqual([
      {
        schemaVersion: '0.1',
        commandId: 'cmd_saved',
        corralId: 'saved',
        definitionRevision: 3,
        mode: 'mock',
      },
    ]);
    expect(store.getState().runId).toMatch(/^run_/);
  });

  it('keeps every committed event, in order, next to the projection they build', async () => {
    const store = session();
    await store.getState().start(linearCorral(['research', 'writer']));
    const done = await until(store, (s) => s.projection?.status === 'succeeded');
    expect(done.events.map((e) => e.runSeq)).toEqual(done.events.map((_, i) => i + 1));
    expect(done.events.at(-1)?.runSeq).toBe(done.projection?.lastSeq);
    expect(done.events.reduce(applyEvent, emptyProjection(done.runId ?? ''))).toEqual(
      done.projection,
    );
  });

  it('collects streamed text per model call, in order, and stops at a gap', async () => {
    const frames: ((frame: StreamFrame) => void)[] = [];
    const inner = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => new Gate().wait() }),
      }),
    );
    const transport = Object.assign(Object.create(inner), {
      subscribe: (runId: string, after: number, handlers: TransportHandlers) => {
        if (handlers.onFrame) frames.push(handlers.onFrame);
        return inner.subscribe(runId, after, handlers);
      },
    }) as typeof inner;
    const store = createRunSession(transport);
    await store.getState().start(linearCorral(['writer']));
    const send = (modelCallId: string, chunkIndex: number, text: string) =>
      frames[0]?.({ runId: store.getState().runId ?? '', modelCallId, chunkIndex, text });
    send('call_a', 0, 'Hel');
    send('call_a', 1, 'lo');
    send('call_a', 1, 'lo');
    send('call_b', 0, 'x');
    send('call_b', 2, 'z');
    send('call_b', 3, 'w');
    await until(store, (s) => s.streams.call_a?.text === 'Hello');
    expect(store.getState().streams).toEqual({
      call_a: { text: 'Hello', next: 2, broken: false },
      call_b: { text: 'x', next: 1, broken: true },
    });
  });

  it('keeps a rejected start visible instead of pretending a run exists', async () => {
    const store = session();
    const definition = linearCorral(['writer']);
    definition.entryNodeId = 'output';
    await store.getState().start(definition);
    expect(store.getState().runId).toBeNull();
    expect(store.getState().startError?.code).toBe('GRAPH_INVALID');
  });
});

describe('Reins command session (C-032–C-035)', () => {
  it('sends the reviewed revision and preserves a rejected receipt without changing status', async () => {
    const store = session();
    store.setState({
      runId: 'run_control',
      projection: { ...emptyProjection('run_control'), status: 'paused', controlRevision: 7 },
    });
    const receipt = await store.getState().sendCommand({
      type: 'patch',
      expectedControlRevision: 6,
      payload: { kind: 'run_limits', changes: { maxOutputTokens: 500 } },
    });
    expect(receipt.status).toBe('rejected');
    expect(store.getState().receipts[receipt.commandId]).toEqual(receipt);
    expect(store.getState().projection?.status).toBe('paused');
    expect(store.getState().pendingCommandIds).toEqual([]);
  });

  it('reports transport failure and clears pending without claiming rejection or application', async () => {
    const transport = {
      sendCommand: vi.fn(async () => {
        throw new Error('connection lost');
      }),
    } as never;
    const store = createRunSession(transport, () => 'cmd_offline');
    store.setState({ runId: 'run_control', projection: emptyProjection('run_control') });
    await expect(
      store.getState().sendCommand({ type: 'pause', payload: { scope: 'run' } }),
    ).rejects.toThrow('connection lost');
    expect(store.getState().commandError).toBe('connection lost');
    expect(store.getState().pendingCommandIds).toEqual([]);
    expect(store.getState().receipts).toEqual({});
  });

  it('recovers a committed command with its original ID instead of duplicating the directive', async () => {
    const gate = new Gate();
    const inner = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 2, beforeReply: () => gate.wait() }),
      }),
    );
    const sent: RunCommand[] = [];
    let loseResponse = true;
    const transport = Object.assign(Object.create(inner), {
      async sendCommand(command: RunCommand) {
        sent.push(command);
        const receipt = await inner.sendCommand(command);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('response lost');
        }
        return receipt;
      },
    });
    let id = 0;
    const store = createRunSession(transport, () => `cmd_recover_${++id}`);
    await store.getState().start(linearCorral(['writer']));
    const ready = await until(store, (s) => Boolean(s.projection?.executionOrder.length));
    const execution = ready.projection?.executionOrder[0] ?? '';
    await expect(store.getState().steer(execution, 'Use sources')).rejects.toThrow('response lost');
    const first = sent[0];
    const receipt = await store.getState().steer(execution, 'Use sources');
    expect(receipt.commandId).toBe(first?.commandId);
    expect(sent).toHaveLength(1);
    expect(store.getState().projection?.directiveOrder).toHaveLength(1);
    expect(store.getState().unconfirmedCommands).toEqual({});
    gate.open();
    await until(store, (s) => s.projection?.status === 'succeeded');
    store.getState().dispose();
  });

  it('retries an uncommitted command with the same ID and payload, but edits create a new command', async () => {
    const sent: RunCommand[] = [];
    let offline = true;
    const transport = {
      getReceipt: vi.fn(async () => null),
      getRunDefinition: async () => linearCorral(['writer']),
      subscribe: () => () => {},
      async sendCommand(command: RunCommand): Promise<Receipt> {
        sent.push(command);
        if (offline) throw new Error('offline');
        return {
          commandId: command.commandId,
          runId: command.runId,
          status: 'applied',
          target: 'run:run_retry',
          requestedBoundary: 'immediate',
          acceptedSeq: 1,
          relatedEventIds: [],
        };
      },
    } as never;
    let id = 0;
    const store = createRunSession(transport, () => `cmd_retry_${++id}`);
    store.setState({ runId: 'run_retry' });
    await expect(store.getState().steer('exec_a', 'Original')).rejects.toThrow();
    await expect(store.getState().steer('exec_b', 'Edited')).rejects.toThrow();
    expect(sent[0]?.commandId).not.toBe(sent[1]?.commandId);
    offline = false;
    await store.getState().steer('exec_a', 'Original');
    expect(sent[2]).toEqual(sent[0]);
    expect(Object.keys(store.getState().unconfirmedCommands)).toEqual([sent[1]?.commandId]);
    await store.getState().open('run_other');
    await store.getState().open('run_retry');
    await store.getState().retryCommand(sent[1]?.commandId ?? '');
    expect(sent[3]).toEqual(sent[1]);
    expect(store.getState().unconfirmedCommands).toEqual({});
    store.getState().dispose();
  });
});

describe('run selection races', () => {
  it('ignores an old open response and never subscribes it after the current run', async () => {
    const replies = new Map<string, (definition: CorralDefinition) => void>();
    const stopped: string[] = [];
    const subscribe = vi.fn((runId: string) => () => stopped.push(runId));
    const store = createRunSession({
      getRunDefinition: (runId: string) => new Promise((resolve) => replies.set(runId, resolve)),
      subscribe,
    } as never);
    const older = store.getState().open('run_old');
    const current = store.getState().open('run_current');
    replies.get('run_current')?.(linearCorral(['writer']));
    await current;
    replies.get('run_old')?.(linearCorral(['writer']));
    await older;
    expect(store.getState().runId).toBe('run_current');
    expect(subscribe.mock.calls.map(([id]) => id)).toEqual(['run_current']);
    store.getState().dispose();
    expect(stopped).toEqual(['run_current']);
  });

  it('does not follow a start that completes after another open or dispose', async () => {
    let finish: ((value: { runId: string; receipt: Receipt }) => void) | undefined;
    const subscribe = vi.fn(() => () => {});
    const store = createRunSession({
      startRun: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      getRunDefinition: async () => linearCorral(['writer']),
      subscribe,
    } as never);
    const starting = store.getState().start(linearCorral(['writer']));
    await store.getState().open('run_current');
    finish?.({ runId: 'run_old', receipt: {} as Receipt });
    await starting;
    expect(store.getState().runId).toBe('run_current');
    const late = store.getState().start(linearCorral(['writer']));
    store.getState().dispose();
    finish?.({ runId: 'run_disposed', receipt: {} as Receipt });
    await late;
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('contains stale open failures and ignores callbacks from a disposed same-run subscription', async () => {
    let rejectOld: ((reason: Error) => void) | undefined;
    const handlers: TransportHandlers[] = [];
    const store = createRunSession({
      getRunDefinition: (id: string) =>
        id === 'old'
          ? new Promise((_resolve, reject) => {
              rejectOld = reject;
            })
          : Promise.resolve(linearCorral(['writer'])),
      subscribe: (_run: string, _after: number, next: TransportHandlers) => {
        handlers.push(next);
        return () => {};
      },
    } as never);
    const old = store.getState().open('old');
    await store.getState().open('current');
    rejectOld?.(new Error('old unavailable'));
    await expect(old).resolves.toBeUndefined();
    expect(store.getState().streamError).toBeNull();
    store.getState().dispose();
    await store.getState().open('current');
    handlers[0]?.onError?.(new Error('disposed failure'));
    expect(store.getState().streamError).toBeNull();
    store.getState().dispose();
  });
});

describe('receipt refresh boundaries', () => {
  const queued = (id: string): Receipt => ({
    commandId: id,
    runId: 'run_receipts',
    status: 'queued',
    acceptedSeq: 1,
    target: 'execution:exec_writer',
    requestedBoundary: 'next_request',
    relatedEventIds: [],
  });
  async function setup(
    getReceipt = vi.fn(async (_run: string, id: string) => queued(id)),
    sendCommand = vi.fn(async (command: RunCommand) => queued(command.commandId)),
  ) {
    let handlers: TransportHandlers | undefined;
    let sequence = 0;
    const store = createRunSession({
      getRunDefinition: async () => linearCorral(['writer']),
      getReceipt,
      sendCommand,
      subscribe: (_run: string, _after: number, next: TransportHandlers) => {
        handlers = next;
        return () => {};
      },
    } as never);
    await store.getState().open('run_receipts');
    store.setState({
      receipts: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`cmd_${i}`, queued(`cmd_${i}`)]),
      ),
    });
    const emit = async (event: Pick<RunEvent, 'type' | 'payload'> & { commandId?: string }) => {
      handlers?.onEvent({
        schemaVersion: '0.1',
        runId: 'run_receipts',
        eventId: `event_${++sequence}`,
        runSeq: sequence,
        recordedAt: '2026-10-15T00:00:00.000Z',
        actor: { kind: 'runtime', id: 'runtime' },
        causedByEventIds: [],
        ...event,
      } as RunEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { store, emit, getReceipt };
  }

  it('does not query queued steers for unrelated model events or another accepted instruction', async () => {
    const { store, emit, getReceipt } = await setup();
    await emit({
      type: 'model.request_prepared',
      payload: {
        executionId: 'exec_writer',
        modelCallId: 'call_1',
        contextSnapshotId: 'ctx_1',
        profile: 'model-a',
        configRevision: 0,
        directiveIds: [],
        inputArtifactVersionIds: [],
      },
    });
    await emit({
      type: 'directive.accepted',
      commandId: 'cmd_0',
      payload: { directiveId: 'dir_0', targetExecutionId: 'exec_writer', text: 'First' },
    });
    expect(getReceipt).not.toHaveBeenCalled();
    await emit({
      type: 'directive.attached',
      payload: { directiveId: 'dir_0', contextSnapshotId: 'ctx_1', modelCallId: 'call_1' },
    });
    expect(getReceipt.mock.calls).toEqual([['run_receipts', 'cmd_0']]);
    store.getState().dispose();
  });

  it('refreshes only safe-boundary commands at pause/resume and the confirmed cancel command', async () => {
    const { store, emit, getReceipt } = await setup();
    getReceipt.mockImplementation(async (_run, id) =>
      id === 'cmd_pause'
        ? {
            ...queued(id),
            status: 'accepted',
            requestedBoundary: 'safe_boundary',
          }
        : queued(id),
    );
    store.setState({
      receipts: {
        ...store.getState().receipts,
        cmd_pause: {
          ...queued('cmd_pause'),
          status: 'accepted',
          requestedBoundary: 'safe_boundary',
          target: 'run:run_receipts',
        },
      },
    });
    await emit({
      type: 'run.state_changed',
      payload: { from: 'pausing', to: 'paused', reasonCode: 'drained' },
    });
    await emit({
      type: 'run.state_changed',
      payload: { from: 'paused', to: 'running', reasonCode: 'resumed' },
    });
    await emit({
      type: 'cancel.confirmed',
      commandId: 'cmd_1',
      payload: {
        scope: { kind: 'execution', executionId: 'exec_writer' },
        settlementRefs: [],
        forced: false,
      },
    });
    expect(getReceipt.mock.calls.map(([, id]) => id)).toEqual(['cmd_pause', 'cmd_pause', 'cmd_1']);
    store.getState().dispose();
  });

  it('coalesces a refresh in flight and reads once more if a directive advances before the response', async () => {
    const replies: ((value: Receipt) => void)[] = [];
    const getReceipt = vi.fn(
      (_run: string, _id: string) => new Promise<Receipt>((resolve) => replies.push(resolve)),
    );
    const { store, emit } = await setup(getReceipt);
    await emit({
      type: 'directive.accepted',
      commandId: 'cmd_0',
      payload: { directiveId: 'dir_0', targetExecutionId: 'exec_writer', text: 'First' },
    });
    const refresh = store.getState().refreshReceipt('cmd_0');
    await emit({
      type: 'directive.attached',
      payload: { directiveId: 'dir_0', contextSnapshotId: 'ctx_1', modelCallId: 'call_1' },
    });
    await emit({
      type: 'directive.dispatched',
      payload: { directiveId: 'dir_0', modelCallId: 'call_1', executionEpoch: 1 },
    });
    expect(getReceipt).toHaveBeenCalledTimes(1);
    replies[0]?.(queued('cmd_0'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getReceipt).toHaveBeenCalledTimes(2);
    replies[1]?.({ ...queued('cmd_0'), status: 'applied' });
    await refresh;
    expect(store.getState().receipts.cmd_0?.status).toBe('applied');
    store.getState().dispose();
  });

  it('reads back once when delivery arrives before the original HTTP receipt', async () => {
    let respond: ((receipt: Receipt) => void) | undefined;
    const sendCommand = vi.fn(
      (_command: RunCommand) =>
        new Promise<Receipt>((resolve) => {
          respond = resolve;
        }),
    );
    const getReceipt = vi.fn(
      async (_run: string, id: string): Promise<Receipt> => ({ ...queued(id), status: 'applied' }),
    );
    const { store, emit } = await setup(getReceipt, sendCommand);
    const sending = store.getState().steer('exec_writer', 'Already delivered');
    const commandId = sendCommand.mock.calls[0]?.[0].commandId ?? '';
    await emit({
      type: 'directive.accepted',
      commandId,
      payload: {
        directiveId: 'dir_race',
        targetExecutionId: 'exec_writer',
        text: 'Already delivered',
      },
    });
    await emit({
      type: 'directive.dispatched',
      payload: { directiveId: 'dir_race', modelCallId: 'call_race', executionEpoch: 1 },
    });
    expect(getReceipt).not.toHaveBeenCalled();
    respond?.(queued(commandId));
    await sending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getReceipt).toHaveBeenCalledTimes(1);
    expect(store.getState().receipts[commandId]?.status).toBe('applied');
    store.getState().dispose();
  });
});

it('[TC-RUN-008] repairs a broken stream from a committed completed response on replay', async () => {
  let handlers: TransportHandlers | undefined;
  const transport = {
    getRunDefinition: async () => linearCorral(['writer']),
    subscribe: (_runId: string, _after: number, next: TransportHandlers) => {
      handlers = next;
      return () => {};
    },
    getArtifactText: async (_runId: string, ref: string) =>
      ref === 'response_1' ? 'The complete response' : null,
  } as never;
  const store = createRunSession(transport);
  await store.getState().open('run_recovery');
  handlers?.onFrame?.({
    runId: 'run_recovery',
    modelCallId: 'call_1',
    chunkIndex: 0,
    text: 'The ',
  });
  handlers?.onFrame?.({
    runId: 'run_recovery',
    modelCallId: 'call_1',
    chunkIndex: 2,
    text: 'response',
  });
  await until(store, (s) => Boolean(s.streams.call_1?.broken));
  handlers?.onEvent({
    schemaVersion: '0.1',
    eventId: 'event_1',
    runId: 'run_recovery',
    runSeq: 1,
    type: 'model.finished',
    at: '2026-10-15T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    payload: {
      executionId: 'exec_1',
      modelCallId: 'call_1',
      responseRef: 'response_1',
      rawUsage: null,
      normalizedUsage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      certainty: 'unknown',
    },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(store.getState().streams.call_1).toMatchObject({
    text: 'The complete response',
    broken: false,
    completed: true,
  });
  store.getState().dispose();
});

it('[TC-RSN-004-N] a failed effective-definition read never disconnects an accepted run', async () => {
  const gate = new Gate();
  const transport = new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
    }),
  );
  const read = vi
    .spyOn(transport, 'getRunDefinition')
    .mockRejectedValueOnce(new Error('metadata unavailable'));
  const start = vi.spyOn(transport, 'startRun');
  const subscribe = vi.spyOn(transport, 'subscribe');
  const store = createRunSession(transport);
  try {
    await store.getState().start(linearCorral(['writer']));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(store.getState().projection).not.toBeNull();
    const runId = store.getState().runId!;
    await store.getState().open(runId);
    expect(read).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(store.getState().definition).not.toBeNull();
  } finally {
    gate.open();
    store.getState().dispose();
  }
});
