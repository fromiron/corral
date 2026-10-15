import { applyEvent, Coordinator, emptyProjection, InProcessTransport } from '@corral/core';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
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
    expect(missing.getState().runId).toBeNull();
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

  it('keeps a rejected start visible instead of pretending a run exists', async () => {
    const store = session();
    const definition = linearCorral(['writer']);
    definition.entryNodeId = 'output';
    await store.getState().start(definition);
    expect(store.getState().runId).toBeNull();
    expect(store.getState().startError?.code).toBe('GRAPH_INVALID');
  });
});
