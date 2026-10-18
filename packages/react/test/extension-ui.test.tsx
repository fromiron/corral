import { type ExtensionUiRequest, type Receipt, RunEvent } from '@corral/contracts';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ExtensionUiPanel } from '../src/components/ExtensionUiPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { SessionCommand } from '../src/run/session.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

it('[TC-HAR-007-H] shows a scoped extension prompt, sends its exact attempt and removes it on expiry', async () => {
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
      <ExtensionUiPanel session={session} />
    </IntlProvider>,
  );
  expect(screen.getByText('Choose a style')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'Choose a style' }), {
    target: { value: 'Two' },
  });
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
