// @vitest-environment jsdom
import { RunEvent } from '@corral/contracts';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { useQuestionNotice, type WaitingQuestion } from './questionNotice.ts';

// The notice above the composer is the one place that names a waiting question
// (ComposerStatusLine). Its words come from here: the first question's own line, the count
// beside it from two, and the body read when the run's texts do not hold it yet.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const question = (requestId: string, runSeq: number): WaitingQuestion => ({
  kind: 'question',
  event: RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${requestId}`,
    runId: 'run_chat',
    runSeq,
    recordedAt: '2026-11-09T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'user_input.requested',
    payload: {
      requestId,
      executionId: `exec_${requestId}`,
      attemptNo: 1,
      bodyRef: `body_${requestId}`,
      schemaHash: 'b'.repeat(64),
      deadline: '2026-11-09T00:01:00.000Z',
    },
  }) as Extract<WaitingQuestion, { kind: 'question' }>['event'],
});

const body = (prompt: string) =>
  JSON.stringify({ key: 'layout', questions: [{ id: 'layout', kind: 'text', prompt }] });

/** The hook as the chat widgets use it: the run's texts, and a stable loader that fills them. */
async function show(questions: WaitingQuestion[], initial: Record<string, string>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const loads: string[] = [];
  let setTexts: (texts: Record<string, string>) => void = () => {};
  const load = async (bodyRef: string) => {
    loads.push(bodyRef);
  };
  function Notice() {
    const [texts, set] = useState(initial);
    setTexts = set;
    return <p>{useQuestionNotice(questions, texts, load) ?? ''}</p>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Notice />
      </IntlProvider>,
    ),
  );
  return {
    text: () => container.textContent,
    loads,
    fill: (texts: Record<string, string>) => act(async () => setTexts(texts)),
  };
}

it('names the first waiting question in its own words, without a count for one', async () => {
  const notice = await show([question('q_1', 1)], {
    body_q_1: body('Which layout should I keep?'),
  });
  expect(notice.text()).toBe('Question: Which layout should I keep?');
  expect(notice.text()).not.toContain(messages.Widgets.actionQuestion);
  // The text was already there: nothing is read again.
  expect(notice.loads).toEqual([]);
});

it('adds the count beside the first question and reads a body it does not have yet', async () => {
  const notice = await show([question('q_1', 1), question('q_2', 2)], {});
  // Until the question text is read, the caller keeps its generic wording.
  expect(notice.text()).toBe('');
  expect(notice.loads).toEqual(['body_q_1']);
  await notice.fill({ body_q_1: body(`Which layout should I keep? ${'x'.repeat(300)}`) });
  const text = notice.text() ?? '';
  expect(text).toContain('Which layout should I keep?');
  expect(text).toContain('2 waiting');
  // A long question is shortened in the notice; the response area keeps it whole.
  expect(text).not.toContain('x'.repeat(300));
});
