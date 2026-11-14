import { type ExtensionUiRequest, type Receipt, RunEvent } from '@corral/contracts';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { InteractionPanel } from '../src/components/InteractionPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { SessionCommand } from '../src/run/session.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

it('shows a scoped extension prompt, sends its exact attempt and removes it on expiry', async () => {
  const request: ExtensionUiRequest = {
    kind: 'select',
    title: 'Choose a style',
    options: ['One', 'Two'],
    timeoutMs: 300000,
  };
  const event = RunEvent.parse({
    schemaVersion: '0.1',
    eventId: 'event_1',
    runId: 'run_story',
    runSeq: 1,
    recordedAt: '2026-10-18T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'extension.ui_requested',
    payload: {
      requestId: 'ui_1',
      executionId: 'exec_1',
      attemptNo: 2,
      kind: 'select',
      bodyRef: 'body_1',
      bodyHash: 'a'.repeat(64),
      deadline: '2099-10-18T00:00:00.000Z',
    },
  });
  const sendCommand = vi.fn(async (_command: SessionCommand) => ({ status: 'applied' }) as Receipt);
  const projection = projectionWith({
    status: 'awaiting_user',
    controlRevision: 3,
    executions: {
      exec_1: {
        executionId: 'exec_1',
        nodeId: 'writer',
        taskId: 'task_1',
        attemptNo: 2,
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
  });
  const session = sessionStore({
    runId: 'run_story',
    projection,
    events: [event],
    artifactTexts: { body_1: JSON.stringify(request) },
    sendCommand,
  });
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InteractionPanel session={session} />
    </IntlProvider>,
  );
  expect(screen.getByText('Choose a style')).toBeVisible();
  // The card says what is asked and who asks; the execution id stays in the run record.
  const card = container.querySelector('[data-extension="ui_1"]');
  expect(card).not.toBeNull();
  expect(card?.textContent).not.toMatch(/exec_/);
  expect(card?.querySelector('details')).toBeNull();
  expect(card?.querySelector('[aria-label="Copy execution ID"]')).toBeNull();
  await userEvent.click(screen.getByRole('combobox', { name: 'Choose a style' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Two' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  await vi.waitFor(() =>
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'answer_extension_ui',
      expectedControlRevision: 3,
      payload: { requestId: 'ui_1', executionId: 'exec_1', attemptNo: 2, value: 'Two' },
    }),
  );
  act(() =>
    session.setState({
      events: [
        ...session.getState().events,
        RunEvent.parse({
          ...event,
          eventId: 'event_2',
          runSeq: 2,
          type: 'extension.ui_expired',
          payload: { requestId: 'ui_1', executionId: 'exec_1', attemptNo: 2, reason: 'timeout' },
        }),
      ],
    }),
  );
  expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument();
  act(() =>
    session.setState({
      events: [event],
      projection,
      artifactTexts: {},
      loadArtifact: async () => {
        throw new Error('offline');
      },
    }),
  );
  expect(
    await screen.findByText('The extension prompt could not be loaded. Dismiss it or try again.'),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss request' }));
  await vi.waitFor(() =>
    expect(sendCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: { requestId: 'ui_1', executionId: 'exec_1', attemptNo: 2, value: null },
      }),
    ),
  );
});

it('asks for an explicit choice and submits free text with its schema and current revision', async () => {
  const event = RunEvent.parse({
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
      deadline: '2026-10-18T00:01:00.000Z',
    },
  });
  const sendCommand = vi.fn(async (_command: SessionCommand) => ({ status: 'applied' }) as Receipt);
  const session = sessionStore({
    runId: 'run_story',
    events: [event],
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
    artifactTexts: {
      body_user: JSON.stringify({
        key: 'format',
        questions: [
          {
            id: 'format',
            prompt: 'Choose format',
            kind: 'single',
            allowFreeText: true,
            options: [
              { id: 'short', label: 'Short', recommended: true },
              { id: 'long', label: 'Long' },
            ],
          },
        ],
      }),
    },
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InteractionPanel session={session} />
    </IntlProvider>,
  );
  expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: /Short/ })).not.toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
    target: { value: 'A table' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  await vi.waitFor(() =>
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'answer_user',
      expectedControlRevision: 4,
      payload: {
        requestId: 'user_1',
        executionId: 'exec_1',
        attemptNo: 1,
        schemaHash: 'b'.repeat(64),
        answers: [{ questionId: 'format', text: 'A table' }],
      },
    }),
  );
});

// Requests of one writer execution, as the runtime records them.
const at = (seq: number, type: string, payload: Record<string, unknown>) =>
  RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${seq}`,
    runId: 'run_story',
    runSeq: seq,
    recordedAt: '2026-10-18T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type,
    payload,
  });
const target = (requestId: string, attemptNo = 1) => ({
  requestId,
  executionId: 'exec_1',
  attemptNo,
});
const asked = (seq: number, requestId: string, kind: 'select' | 'confirm', attemptNo = 1) =>
  at(seq, 'extension.ui_requested', {
    ...target(requestId, attemptNo),
    kind,
    bodyRef: `body_${requestId}`,
    bodyHash: 'a'.repeat(64),
    deadline: '2099-10-18T00:00:00.000Z',
  });
const answered = (seq: number, requestId: string) =>
  at(seq, 'extension.ui_answered', {
    ...target(requestId),
    answerRef: `answer_${requestId}`,
    answerHash: 'b'.repeat(64),
  });
const select: ExtensionUiRequest = {
  kind: 'select',
  title: 'Choose a style',
  options: ['One', 'Two'],
  timeoutMs: 300000,
};
const confirm: ExtensionUiRequest = {
  kind: 'confirm',
  title: 'Keep the draft?',
  message: 'The draft stays.',
  timeoutMs: 300000,
};
/** The writer's execution: waiting on the person, or gone on, at an attempt. */
const writer = (status: 'waiting_approval' | 'active', attemptNo = 1) => ({
  exec_1: {
    executionId: 'exec_1',
    nodeId: 'writer',
    taskId: 'task_1',
    attemptNo,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: null,
    status,
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
  },
});

// An answered expansion request folds into one line in its place while the run still waits, the
// shape of an answered question and a decided approval (RequestCard.tsx).
it('folds an answered expansion request into one line while another request still waits', () => {
  const session = sessionStore({
    runId: 'run_story',
    projection: projectionWith({
      status: 'awaiting_user',
      controlRevision: 3,
      executions: writer('waiting_approval'),
    }),
    events: [
      asked(1, 'ui_select', 'select'),
      asked(2, 'ui_confirm', 'confirm'),
      asked(3, 'ui_waiting', 'select'),
      answered(4, 'ui_select'),
      answered(5, 'ui_confirm'),
    ],
    artifactTexts: {
      body_ui_select: JSON.stringify(select),
      body_ui_confirm: JSON.stringify(confirm),
      body_ui_waiting: JSON.stringify({ ...select, title: 'Choose a tone' }),
      answer_ui_select: '"Two"',
      answer_ui_confirm: 'true',
    },
  });
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InteractionPanel session={session} />
    </IntlProvider>,
  );
  expect(screen.getByTestId('answered-ui_select')).toHaveTextContent('Answered: Two');
  expect(screen.getByTestId('answered-ui_confirm')).toHaveTextContent('Answered: Confirm');
  expect(container.querySelector('[data-extension="ui_select"]')).toBeNull();
  expect(container.querySelector('[data-extension="ui_confirm"]')).toBeNull();
  // The one still waiting keeps its card.
  expect(screen.getByText('Choose a tone')).toBeVisible();
});

// A request the person dismissed was not answered: its line says what they did, with a neutral
// mark, not the completed one. A declined confirm was answered; an expired request leaves no line.
it('folds a dismissed request as Dismissed, a declined confirm as answered, and an expired one not at all', () => {
  const session = sessionStore({
    runId: 'run_story',
    projection: projectionWith({
      status: 'awaiting_user',
      controlRevision: 3,
      executions: writer('waiting_approval'),
    }),
    events: [
      asked(1, 'ui_dismissed', 'select'),
      asked(2, 'ui_declined', 'confirm'),
      asked(3, 'ui_expired', 'select'),
      asked(4, 'ui_waiting', 'select'),
      answered(5, 'ui_dismissed'),
      answered(6, 'ui_declined'),
      at(7, 'extension.ui_expired', { ...target('ui_expired'), reason: 'timeout' }),
    ],
    artifactTexts: {
      body_ui_dismissed: JSON.stringify(select),
      body_ui_declined: JSON.stringify(confirm),
      body_ui_expired: JSON.stringify({ ...select, title: 'Choose a size' }),
      body_ui_waiting: JSON.stringify({ ...select, title: 'Choose a tone' }),
      answer_ui_dismissed: 'null',
      answer_ui_declined: 'false',
    },
  });
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InteractionPanel session={session} />
    </IntlProvider>,
  );
  const dismissed = screen.getByTestId('answered-ui_dismissed');
  expect(dismissed).toHaveTextContent(/^Dismissed$/);
  expect(dismissed).not.toHaveTextContent('Answered');
  const declined = screen.getByTestId('answered-ui_declined');
  expect(declined).toHaveTextContent('Answered: Decline');
  // The marks: neutral for the dismissal, the completed check for the answer.
  const mark = (line: HTMLElement) => line.querySelector('svg')?.style.color;
  expect(mark(dismissed)).toBe('var(--muted-foreground)');
  expect(mark(declined)).toBe('var(--success)');
  // The expired request leaves neither a line nor its card.
  expect(screen.queryByTestId('answered-ui_expired')).toBeNull();
  expect(container.querySelector('[data-extension="ui_expired"]')).toBeNull();
  expect(screen.getByText('Choose a tone')).toBeVisible();
});

// freshDecisions.ts: once the run is seen waiting on nothing, an expansion request's answer line
// belongs to that earlier wait, even when its history never closed the other request.
it('never brings back an answered expansion request’s line when the run waits again', () => {
  const session = sessionStore({
    runId: 'run_story',
    projection: projectionWith({
      status: 'awaiting_user',
      controlRevision: 3,
      executions: writer('waiting_approval'),
    }),
    events: [
      asked(1, 'ui_select', 'select'),
      asked(2, 'ui_open', 'select'),
      answered(3, 'ui_select'),
    ],
    artifactTexts: {
      body_ui_select: JSON.stringify(select),
      body_ui_open: JSON.stringify({ ...select, title: 'Choose a tone' }),
      body_ui_next: JSON.stringify({ ...select, title: 'Choose a size' }),
      answer_ui_select: '"Two"',
    },
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InteractionPanel session={session} />
    </IntlProvider>,
  );
  expect(screen.getByTestId('answered-ui_select')).toHaveTextContent('Answered: Two');
  // The wait ends with no closing event for the other request: the writer simply goes on.
  const state = session.getState();
  const projection = state.projection;
  if (!projection) throw new Error('fixture projection missing');
  act(() =>
    session.setState({
      projection: { ...projection, status: 'running', executions: writer('active') },
    }),
  );
  expect(screen.queryByTestId('answered-ui_select')).toBeNull();
  // A later attempt waits on a new request: only its card shows.
  act(() =>
    session.setState({
      events: [...session.getState().events, asked(4, 'ui_next', 'select', 2)],
      projection: {
        ...projection,
        status: 'awaiting_user',
        executions: writer('waiting_approval', 2),
      },
    }),
  );
  expect(screen.getByText('Choose a size')).toBeVisible();
  expect(screen.queryByTestId('answered-ui_select')).toBeNull();
});
