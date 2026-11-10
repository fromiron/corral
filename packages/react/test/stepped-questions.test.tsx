import { type Receipt, RunEvent, type UserInputRequest } from '@corral/contracts';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { InteractionPanel } from '../src/components/InteractionPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { SessionCommand } from '../src/run/session.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

const requested = RunEvent.parse({
  schemaVersion: '0.1',
  eventId: 'event_user',
  runId: 'run_story',
  runSeq: 1,
  recordedAt: '2026-10-18T00:00:00.000Z',
  actor: { kind: 'runtime', id: 'runtime' },
  causedByEventIds: [],
  type: 'user_input.requested',
  payload: {
    requestId: 'user_1',
    executionId: 'exec_1',
    attemptNo: 1,
    bodyRef: 'body_user',
    schemaHash: 'b'.repeat(64),
    deadline: '2099-10-18T00:01:00.000Z',
  },
});

const three: UserInputRequest = {
  key: 'setup',
  questions: [
    {
      id: 'format',
      prompt: 'Choose format',
      kind: 'single',
      options: [
        { id: 'short', label: 'Short' },
        { id: 'long', label: 'Long' },
      ],
    },
    {
      id: 'parts',
      prompt: 'Which parts?',
      kind: 'multiple',
      options: [
        { id: 'intro', label: 'Intro' },
        { id: 'body', label: 'Body' },
        { id: 'outro', label: 'Outro' },
      ],
    },
    { id: 'tone', prompt: 'What tone?', kind: 'text' },
  ],
};

function setup(
  request: UserInputRequest = three,
  sendCommand = vi.fn(async (_command: SessionCommand) => ({ status: 'applied' }) as Receipt),
) {
  const session = sessionStore({
    runId: 'run_story',
    events: [requested],
    sendCommand,
    projection: projectionWith({
      status: 'awaiting_user',
      controlRevision: 4,
      executions: {
        exec_1: {
          executionId: 'exec_1',
          nodeId: 'writer',
          taskId: 'task_1',
          attemptNo: 1,
          parentExecutionId: null,
          previousExecutionId: null,
          depth: 0,
          iterationId: null,
          modelProfile: 'model-a',
          configRevision: 0,
          criteriaVersionId: null,
          status: 'waiting_approval',
          activity: null,
          waitingOn: null,
          modelCallIds: [],
          error: null,
        },
      },
    }),
    artifactTexts: { body_user: JSON.stringify(request) },
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InteractionPanel session={session} />
    </IntlProvider>,
  );
  return { session, sendCommand };
}

const form = () => screen.getByRole('form', { name: 'Waiting for your answer' });
const heading = () => within(form()).getByRole('heading', { level: 3 });
const next = () => within(form()).getByRole('button', { name: 'Next' });
const send = () => within(form()).getByRole('button', { name: 'Send answer' });

it('steps through the questions and sends every answer once, from the review step', async () => {
  const { session, sendCommand } = setup();
  expect(heading()).toHaveTextContent('Question 1/3');
  // One question at a time; the others stay out of sight.
  expect(screen.getByRole('group', { name: 'Choose format' })).toBeVisible();
  expect(screen.queryByRole('group', { name: 'Which parts?' })).not.toBeInTheDocument();
  expect(within(form()).queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();
  expect(within(form()).queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'Short' }));
  await userEvent.click(next());
  expect(heading()).toHaveTextContent('Question 2/3');
  expect(heading()).toHaveFocus();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Intro' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Outro' }));
  await userEvent.click(within(form()).getByRole('button', { name: 'Previous' }));
  expect(heading()).toHaveTextContent('Question 1/3');
  expect(screen.getByRole('radio', { name: 'Short' })).toBeChecked();
  await userEvent.click(next());
  expect(screen.getByRole('checkbox', { name: 'Outro' })).toBeChecked();
  await userEvent.click(next());
  await userEvent.type(screen.getByRole('textbox', { name: 'Your answer' }), 'Plain');
  await userEvent.click(next());
  expect(heading()).toHaveTextContent('Review answers');
  expect(heading()).toHaveFocus();
  const review = within(form()).getByRole('list', { name: 'Review answers' });
  expect(
    within(review)
      .getAllByRole('listitem')
      .map((row) => row.textContent),
  ).toEqual([
    expect.stringContaining('Short'),
    expect.stringContaining('Intro, Outro'),
    expect.stringContaining('Plain'),
  ]);
  // Edit jumps back to that question; nothing is sent by moving around.
  await userEvent.click(
    within(review).getByRole('button', { name: 'Edit the answer to Choose format' }),
  );
  expect(heading()).toHaveTextContent('Question 1/3');
  await userEvent.click(screen.getByRole('radio', { name: 'Long' }));
  await userEvent.click(next());
  await userEvent.click(next());
  await userEvent.click(next());
  expect(sendCommand).not.toHaveBeenCalled();
  await userEvent.click(send());
  await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1));
  expect(sendCommand).toHaveBeenCalledWith({
    type: 'answer_user',
    expectedControlRevision: 4,
    payload: {
      requestId: 'user_1',
      executionId: 'exec_1',
      attemptNo: 1,
      schemaHash: 'b'.repeat(64),
      answers: [
        { questionId: 'format', optionIds: ['long'] },
        { questionId: 'parts', optionIds: ['intro', 'outro'] },
        { questionId: 'tone', text: 'Plain' },
      ],
    },
  });
  // An applied receipt is not the answer: the request stays until its answered event.
  expect(form()).toBeVisible();
  act(() =>
    session.setState({
      events: [
        requested,
        RunEvent.parse({
          ...requested,
          eventId: 'event_answered',
          runSeq: 2,
          type: 'user_input.answered',
          payload: {
            requestId: 'user_1',
            executionId: 'exec_1',
            attemptNo: 1,
            answerRef: 'body_answer',
            answerHash: 'c'.repeat(64),
          },
        }),
      ],
    }),
  );
  expect(screen.queryByRole('form', { name: 'Waiting for your answer' })).not.toBeInTheDocument();
});

it('lets a person skip ahead but marks missing answers and holds Send until they are given', async () => {
  const { sendCommand } = setup();
  await userEvent.click(next());
  await userEvent.click(next());
  await userEvent.click(next());
  expect(heading()).toHaveTextContent('Review answers');
  const review = within(form()).getByRole('list', { name: 'Review answers' });
  expect(within(review).getAllByText('Answer required')).toHaveLength(3);
  expect(send()).toBeDisabled();
  await userEvent.click(
    within(review).getByRole('button', { name: 'Edit the answer to What tone?' }),
  );
  await userEvent.type(screen.getByRole('textbox', { name: 'Your answer' }), 'Warm');
  await userEvent.click(next());
  expect(within(form()).getAllByText('Answer required')).toHaveLength(2);
  expect(send()).toBeDisabled();
  await userEvent.click(
    within(form()).getByRole('button', { name: 'Edit the answer to Choose format' }),
  );
  await userEvent.click(screen.getByRole('radio', { name: 'Short' }));
  await userEvent.click(next());
  await userEvent.click(screen.getByRole('checkbox', { name: 'Body' }));
  await userEvent.click(next());
  await userEvent.click(next());
  expect(within(form()).queryByText('Answer required')).not.toBeInTheDocument();
  expect(send()).toBeEnabled();
  expect(sendCommand).not.toHaveBeenCalled();
});

it('disables every question fieldset and the step controls while the answer is being sent', async () => {
  let settle: (receipt: Receipt) => void = () => {};
  const sendCommand = vi.fn(
    (_command: SessionCommand) => new Promise<Receipt>((resolve) => (settle = resolve)),
  );
  const { sendCommand: sent } = setup(
    {
      key: 'pair',
      questions: [
        { id: 'a', prompt: 'First?', kind: 'text' },
        { id: 'b', prompt: 'Second?', kind: 'text' },
      ],
    },
    sendCommand,
  );
  await userEvent.type(screen.getByRole('textbox', { name: 'Your answer' }), 'one');
  await userEvent.click(next());
  await userEvent.type(screen.getByRole('textbox', { name: 'Your answer' }), 'two');
  await userEvent.click(next());
  await userEvent.click(send());
  expect(sent).toHaveBeenCalledTimes(1);
  const fieldsets = form().querySelectorAll('fieldset');
  expect(fieldsets).toHaveLength(2);
  for (const fieldset of fieldsets) expect(fieldset).toBeDisabled();
  expect(send()).toBeDisabled();
  expect(within(form()).getByRole('button', { name: 'Previous' })).toBeDisabled();
  for (const edit of within(form()).getAllByRole('button', { name: /Edit the answer/ }))
    expect(edit).toBeDisabled();
  await act(async () => settle({ status: 'applied' } as Receipt));
  for (const fieldset of form().querySelectorAll('fieldset')) expect(fieldset).toBeEnabled();
  expect(sent).toHaveBeenCalledTimes(1);
});

it('never answers or moves on from number keys', async () => {
  const { sendCommand } = setup();
  const short = screen.getByRole('radio', { name: 'Short' });
  short.focus();
  await userEvent.keyboard('12');
  expect(short).not.toBeChecked();
  expect(screen.getByRole('radio', { name: 'Long' })).not.toBeChecked();
  expect(heading()).toHaveTextContent('Question 1/3');
  expect(sendCommand).not.toHaveBeenCalled();
});

it('a composing Enter neither advances nor sends; a plain Enter in a text answer moves on', async () => {
  const { sendCommand } = setup({
    key: 'pair',
    questions: [
      { id: 'a', prompt: 'First?', kind: 'text' },
      { id: 'b', prompt: 'Second?', kind: 'text' },
    ],
  });
  const answer = screen.getByRole('textbox', { name: 'Your answer' });
  await userEvent.type(answer, '한');
  expect(fireEvent.keyDown(answer, { key: 'Enter', isComposing: true })).toBe(false);
  expect(fireEvent.keyDown(answer, { key: 'Enter', keyCode: 229 })).toBe(false);
  expect(heading()).toHaveTextContent('Question 1/2');
  await userEvent.type(answer, '{Enter}');
  expect(heading()).toHaveTextContent('Question 2/2');
  const second = screen.getByRole('textbox', { name: 'Your answer' });
  await userEvent.type(second, 'b{Enter}');
  expect(heading()).toHaveTextContent('Review answers');
  expect(sendCommand).not.toHaveBeenCalled();
});

it('names who asks by agent and attempt, and keeps the execution id one copy away', async () => {
  setup();
  expect(form()).toHaveTextContent('writer · Attempt 1');
  expect(form()).not.toHaveTextContent('exec_1');
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await act(async () =>
    fireEvent.click(within(form()).getByRole('button', { name: 'Copy execution ID' })),
  );
  expect(writeText).toHaveBeenCalledWith('exec_1');
  expect(form()).toHaveTextContent('Execution ID copied');
});

it('keeps a single question on one screen with no steps', () => {
  setup({ key: 'one', questions: [{ id: 'a', prompt: 'Only?', kind: 'text' }] });
  expect(within(form()).queryByRole('heading')).not.toBeInTheDocument();
  expect(within(form()).queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Only?' })).toBeVisible();
  expect(send()).toBeDisabled();
});
