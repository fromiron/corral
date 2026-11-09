import { Coordinator, InMemoryRunStore, InProcessTransport, waitForProjection } from '@corral/core';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { createRunSession } from '../src/run/session.ts';

it('evicts a superseded final and refuses an in-flight body response after release', async () => {
  const coordinator = new Coordinator({
    store: new InMemoryRunStore(),
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const transport = new InProcessTransport(coordinator);
  const start = async (commandId: string) => {
    const result = coordinator.startRun({
      schemaVersion: '0.1',
      commandId,
      definition: linearCorral(['writer']),
      mode: 'mock',
      sessionId: 'session_cache',
    });
    await waitForProjection(transport, result.runId!, (p) => p.status === 'succeeded');
    return result.runId!;
  };
  const first = await start('cmd_first');
  const id = coordinator.getSnapshot(first).projection.output!.artifactVersionIds[0]!;
  const session = createRunSession(transport);
  await session.getState().open(first);
  await vi.waitFor(() => expect(session.getState().outputText).toBeTruthy());
  await session.getState().loadArtifact(id);
  expect(session.getState().artifactTexts[id]).toBeTruthy();
  let finish!: (text: string) => void;
  vi.spyOn(transport, 'getArtifactText').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = session.getState().loadArtifact(id, { reload: true });
  await start('cmd_second');
  await vi.waitFor(() =>
    expect(session.getState().projection?.artifacts[id]?.bodyAvailable).toBe(false),
  );
  expect(session.getState().artifactTexts[id]).toBeUndefined();
  expect(session.getState().outputText).toBeNull();
  finish('stale result');
  await pending;
  expect(session.getState().artifactTexts[id]).toBeUndefined();
  session.getState().dispose();
});

it('does not reopen a retired cached body while reconnect waits for new release events', async () => {
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const transport = new InProcessTransport(coordinator);
  const start = async (commandId: string) => {
    const result = coordinator.startRun({
      schemaVersion: '0.1',
      commandId,
      definition: linearCorral(['writer']),
      mode: 'mock',
      sessionId: 'session_reopen',
    });
    if (!result.runId) throw new Error('run missing');
    await waitForProjection(transport, result.runId, (p) => p.status === 'succeeded');
    return result.runId;
  };
  const first = await start('cmd_first');
  const id = coordinator.getSnapshot(first).projection.output?.artifactVersionIds[0];
  if (!id) throw new Error('result missing');
  const recovery = {
    commands: () => [],
    pending: () => {},
    confirmed: () => {},
    events: () => store.readEvents(first, 0),
    committed: () => {},
  };
  const session = createRunSession(transport, undefined, recovery);
  await session.getState().open(first);
  await session.getState().loadArtifact(id);
  expect(session.getState().artifactTexts[id]).toBeTruthy();
  const cachedEvents = session.getState().events;
  session.getState().dispose();
  await start('cmd_second');
  recovery.events = () => cachedEvents;
  vi.spyOn(transport, 'subscribe').mockImplementation(() => () => {});
  await session.getState().open(first);
  expect(coordinator.getArtifactText(first, id)).toBeNull();
  expect(session.getState().artifactTexts[id]).toBeUndefined();
  expect(session.getState().outputText).toBeNull();
  session.getState().dispose();
});
