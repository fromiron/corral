import { InMemoryCoordinator, InProcessTransport } from '@corral/core';
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
    new InMemoryCoordinator({
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

  it('keeps a rejected start visible instead of pretending a run exists', async () => {
    const store = session();
    const definition = linearCorral(['writer']);
    definition.entryNodeId = 'output';
    await store.getState().start(definition);
    expect(store.getState().runId).toBeNull();
    expect(store.getState().startError?.code).toBe('GRAPH_INVALID');
  });
});
