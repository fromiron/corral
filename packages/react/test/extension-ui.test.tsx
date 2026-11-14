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
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InteractionPanel session={session} />
    </IntlProvider>,
  );
  expect(screen.getByText('Choose a style')).toBeVisible();
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

// An answered expansion request folds into one line in its place while the run still waits, the
// shape of an answered question and a decided approval (RequestCard.tsx).
it('folds an answered expansion request into one line while another request still waits', () => {
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
  const target = (requestId: string) => ({ requestId, executionId: 'exec_1', attemptNo: 1 });
  const asked = (seq: number, requestId: string, kind: 'select' | 'confirm') =>
    at(seq, 'extension.ui_requested', {
      ...target(requestId),
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
  const session = sessionStore({
    runId: 'run_story',
    projection: projectionWith({
      status: 'awaiting_user',
      controlRevision: 3,
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
