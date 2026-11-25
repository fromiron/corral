import type { RunEvent } from '@corral/contracts';
import type { TransportHandlers } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunSession } from '../src/run/session.ts';
import { keepUnsentAnswer, onUnsentAnswer, unsentAnswer } from '../src/run/unsentAnswers.ts';

// features/composer-flow.md 대기 요청과 넘겨받기: what was typed into a question that closed
// without an answer goes to the conversation's draft, once; an answer sent drops it.

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function uiEvent(
  runId: string,
  runSeq: number,
  type: RunEvent['type'],
  requestId: string,
  extra: Record<string, unknown> = {},
): RunEvent {
  return {
    schemaVersion: '0.1',
    eventId: `event_${runId}_${runSeq}`,
    runId,
    runSeq,
    recordedAt: '2026-11-25T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type,
    executionId: 'exec_1',
    payload: { requestId, executionId: 'exec_1', attemptNo: 1, ...extra },
  } as unknown as RunEvent;
}

async function follow(runId: string) {
  let handlers!: TransportHandlers;
  const subscribe = vi.fn((_runId: string, _after: number, next: TransportHandlers) => {
    handlers = next;
    return () => {};
  });
  const store = createRunSession({
    getRunDefinition: async () => linearCorral(['writer']),
    subscribe,
  } as never);
  void store.getState().open(runId);
  await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
  stops.push(() => store.getState().dispose());
  const push = async (event: RunEvent) => {
    handlers.onEvent(event);
    await vi.waitFor(() => expect(store.getState().projection?.lastSeq).toBe(event.runSeq));
  };
  return { store, push };
}

function carried() {
  const seen = vi.fn();
  stops.push(onUnsentAnswer(seen));
  return seen;
}

it('a question closed without an answer hands its typed text over once, and a replay does not', async () => {
  const seen = carried();
  const { store, push } = await follow('run_a');
  keepUnsentAnswer(store, 'ask_1', 'session_a', { q1: 'Use the staging', q2: 'and log it' });
  expect(unsentAnswer(store, 'ask_1')).toEqual({ q1: 'Use the staging', q2: 'and log it' });
  await push(uiEvent('run_a', 1, 'user_input.closed', 'ask_1', { reason: 'cancelled' }));
  expect(seen).toHaveBeenCalledTimes(1);
  expect(seen).toHaveBeenCalledWith({
    sessionId: 'session_a',
    text: 'Use the staging\n\nand log it',
  });
  expect(unsentAnswer(store, 'ask_1')).toEqual({});
  // The closing event arrives again, in this store or another following the same run.
  await push(uiEvent('run_a', 2, 'user_input.closed', 'ask_1', { reason: 'cancelled' }));
  const replay = await follow('run_a');
  await replay.push(uiEvent('run_a', 1, 'user_input.closed', 'ask_1', { reason: 'cancelled' }));
  expect(seen).toHaveBeenCalledTimes(1);
});

it('an extension input that expires hands its text over too', async () => {
  const seen = carried();
  const { store, push } = await follow('run_b');
  keepUnsentAnswer(store, 'ui_1', 'session_b', { '': 'port 5179' });
  await push(uiEvent('run_b', 1, 'extension.ui_expired', 'ui_1', { reason: 'timeout' }));
  expect(seen).toHaveBeenCalledWith({ sessionId: 'session_b', text: 'port 5179' });
});

it('an answer sent, from here or another window, hands nothing over (counterexample)', async () => {
  const seen = carried();
  const { store, push } = await follow('run_c');
  keepUnsentAnswer(store, 'ask_1', 'session_c', { q1: 'typed then sent' });
  await push(
    uiEvent('run_c', 1, 'user_input.answered', 'ask_1', {
      answerRef: 'answer_1',
      answerHash: 'a'.repeat(64),
    }),
  );
  await push(uiEvent('run_c', 2, 'user_input.closed', 'ask_1', { reason: 'execution_ended' }));
  expect(seen).not.toHaveBeenCalled();
});

it('nothing typed, or typed outside a conversation, hands nothing over (counterexample)', async () => {
  const seen = carried();
  const { store, push } = await follow('run_d');
  keepUnsentAnswer(store, 'ask_1', 'session_d', { q1: '   ' });
  keepUnsentAnswer(store, 'ask_2', null, { q1: 'typed in a run record' });
  expect(unsentAnswer(store, 'ask_2')).toEqual({ q1: 'typed in a run record' });
  await push(uiEvent('run_d', 1, 'user_input.closed', 'ask_1', { reason: 'cancelled' }));
  await push(uiEvent('run_d', 2, 'user_input.closed', 'ask_2', { reason: 'cancelled' }));
  expect(seen).not.toHaveBeenCalled();
  expect(unsentAnswer(store, 'ask_2')).toEqual({});
});
