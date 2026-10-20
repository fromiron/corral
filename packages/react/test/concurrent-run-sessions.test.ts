import type { RuntimeTransport, TransportHandlers } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { createRunSessions } from '../../../apps/studio/src/runSessions.ts';

it('[TC-ABS-006-H] [TC-ABS-006-N] run views retain independent SSE and cancel targets across navigation', async () => {
  const subscriptions = new Map<string, TransportHandlers>();
  const unsubscribed: string[] = [];
  const sendCommand = vi.fn(async (command) => ({
    commandId: command.commandId,
    runId: command.runId,
    status: 'applied',
    target: `run:${command.runId}`,
    acceptedSeq: 1,
    requestedBoundary: 'immediate',
    relatedEventIds: [],
  }));
  const transport = {
    getRunDefinition: async () => linearCorral(['writer']),
    subscribe: (id: string, _cursor: number, handlers: TransportHandlers) => {
      subscriptions.set(id, handlers);
      return () => {
        unsubscribed.push(id);
        subscriptions.delete(id);
      };
    },
    sendCommand,
  } as unknown as RuntimeTransport;
  const views = createRunSessions(transport);
  const a = views.runFor('a'),
    b = views.runFor('b');
  await a.getState().open('a');
  await b.getState().open('b');
  const releaseA = views.retainRun('a');
  const releaseASecondView = views.retainRun('a');
  const releaseB = views.retainRun('b');
  expect([...subscriptions.keys()]).toEqual(['a', 'b']);
  expect(views.runFor('a')).toBe(a);
  expect(a.getState().runId).toBe('a');
  await b
    .getState()
    .sendCommand({ type: 'cancel', payload: { scope: { kind: 'run' }, reason: 'stop selected' } });
  expect(sendCommand.mock.calls[0]?.[0].runId).toBe('b');
  expect(a.getState().receipts).toEqual({});
  expect(unsubscribed).toEqual([]);
  releaseA();
  expect(unsubscribed).toEqual([]);
  releaseASecondView();
  expect(unsubscribed).toEqual(['a']);
  expect(subscriptions.has('b')).toBe(true);
  releaseB();
  views.dispose();
  expect(unsubscribed.sort()).toEqual(['a', 'b']);
  const otherHost = createRunSessions(transport);
  expect(otherHost.runFor('a')).not.toBe(a);
});
