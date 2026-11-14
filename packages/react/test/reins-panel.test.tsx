import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ReinsPanel } from '../src/components/ReinsPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { RunSessionState, RunSessionStore } from '../src/run/session.ts';

function fakeSession(steer = vi.fn(async () => ({}) as never)): RunSessionStore {
  return createStore<RunSessionState>(() => ({
    runId: 'run_0001',
    definition: null,
    definitionError: null,
    projection: null,
    initialLoadSeq: undefined,
    events: [],
    streams: {},
    artifactTexts: {},
    outputText: null,
    startError: null,
    streamError: null,
    missingRunId: null,
    pendingCommandIds: [],
    receipts: {},
    commandError: null,
    unconfirmedCommands: {},
    sendCommand: vi.fn(),
    retryCommand: vi.fn(),
    start: vi.fn(),
    open: vi.fn(),
    loadArtifact: vi.fn(),
    resolveApproval: vi.fn(),
    steer,
    refreshReceipt: vi.fn(),
    dispose: vi.fn(),
  }));
}

function renderPanel(
  session: RunSessionStore,
  target = { executionId: 'exec_0002', nodeLabel: 'Writer', finished: false },
) {
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ReinsPanel session={session} target={target} />
    </IntlProvider>,
  );
}

describe('ReinsPanel', () => {
  it('compact entry identifies a particular execution of the same node and its scope', () => {
    const session = fakeSession();
    const projection = emptyProjection('run_0001');
    projection.executionOrder = ['exec_first', 'exec_second'];
    session.setState({ projection });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel
          session={session}
          target={{ executionId: 'exec_second', nodeLabel: 'Writer', finished: false }}
          compact
        />
      </IntlProvider>,
    );
    expect(screen.getByText('Agent execution 2')).toBeInTheDocument();
    expect(screen.getByText('this execution only')).toBeInTheDocument();
  });
  it('compact entry puts delivery and scope as chips on the heading row and states nothing twice', () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel
          session={fakeSession()}
          target={{ executionId: 'exec_writer', nodeLabel: 'Writer', finished: false }}
          compact
        />
      </IntlProvider>,
    );
    const heading = screen.getByRole('heading', { name: 'Give instruction · Writer' });
    const row = heading.parentElement as HTMLElement;
    const chips = [...row.querySelectorAll('[data-reins-chip]')];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Delivery: next model request',
      'Scope: this execution only',
    ]);
    // The chip names stay for screen readers; the value is what shows.
    for (const chip of chips) expect(chip.querySelector('.sr-only')).not.toBeNull();
    // The field keeps its name under the heading, without a visible label or a key hint.
    const box = screen.getByLabelText('Instruction');
    expect(document.querySelector(`label[for="${box.id}"]`)).toHaveClass('sr-only');
    expect(box).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/Enter sends/)).not.toBeInTheDocument();
  });
  it.each([true, false])(
    'sets the instruction field flush with the heading only in the compact form (compact %s)',
    (compact) => {
      const { container } = render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ReinsPanel
            session={fakeSession()}
            target={{ executionId: 'exec_writer', nodeLabel: 'Writer', finished: false }}
            compact={compact}
          />
        </IntlProvider>,
      );
      const compose = container.querySelector<HTMLElement>('[data-reins-compose]');
      expect(compose?.contains(screen.getByLabelText('Instruction'))).toBe(true);
      // The compact form stands in the page beside its heading, "Agent execution" line and
      // Cancel button, so its field takes no inset of its own; the full panel's card keeps one.
      const inset = /(^|\s)(p[lrx]|ps|pe)-/.test(compose?.className ?? '');
      expect(inset).toBe(!compact);
    },
  );
  it('a missing compact instruction target never exposes run-wide settings as a substitute', () => {
    const session = fakeSession();
    session.setState({
      definition: linearCorral(['worker']),
      projection: { ...emptyProjection('run_0001'), status: 'running' },
    });
    const { container } = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel session={session} target={null} compact />
      </IntlProvider>,
    );
    expect(screen.queryByLabelText('Instruction')).not.toBeInTheDocument();
    expect(container.querySelector('button')).toBeNull();
  });
  it('compact instruction entry keeps its target and input without empty activity explanations', () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel
          session={fakeSession()}
          target={{ executionId: 'exec_writer', nodeLabel: 'Writer', finished: false }}
          compact
        />
      </IntlProvider>,
    );
    expect(screen.getByLabelText('Instruction')).toBeInTheDocument();
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByText('next model request')).toBeInTheDocument();
    expect(screen.queryByText(messages.Reins.noHistory)).not.toBeInTheDocument();
    expect(screen.queryByText(messages.Reins.deliveredNote)).not.toBeInTheDocument();
  });
  it.each([false, true])(
    'safe receipt recovery clears only the unchanged submitted draft (edited=%s)',
    async (edited) => {
      const session = fakeSession();
      session.setState({
        steer: async (executionId, text) => {
          session.setState({
            unconfirmedCommands: {
              cmd_lost: {
                error: 'response lost',
                command: {
                  schemaVersion: '0.1',
                  commandId: 'cmd_lost',
                  runId: 'run_0001',
                  type: 'steer',
                  payload: { targetExecutionId: executionId, text, delivery: 'next_request' },
                },
              },
            },
          });
          throw new Error('response lost');
        },
      });
      renderPanel(session);
      fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Original' } });
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));
      if (edited)
        fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Edited' } });
      act(() =>
        session.setState({
          receipts: {
            cmd_lost: {
              commandId: 'cmd_lost',
              runId: 'run_0001',
              status: 'queued',
              target: 'execution:exec_0002',
              requestedBoundary: 'next_request',
              acceptedSeq: 1,
              relatedEventIds: [],
            },
          },
        }),
      );
      expect(screen.getByLabelText('Instruction')).toHaveValue(edited ? 'Edited' : '');
    },
  );

  it('keeps a draft bound to its original execution until the user explicitly moves it', async () => {
    const steer = vi.fn(async () => ({ status: 'queued' }) as never);
    const session = fakeSession(steer);
    const view = renderPanel(session);
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Writer only' } });
    view.rerender(
      <IntlProvider locale="en" messages={messages}>
        <ReinsPanel
          session={session}
          target={{ executionId: 'exec_other', nodeLabel: 'Reviewer', finished: false }}
        />
      </IntlProvider>,
    );
    expect(screen.getByLabelText('Instruction')).toHaveValue('Writer only');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Instruction'), { key: 'Enter' });
    expect(steer).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Use draft for this execution' }));
    fireEvent.keyDown(screen.getByLabelText('Instruction'), { key: 'Enter' });
    expect(steer).toHaveBeenCalledWith('exec_other', 'Writer only');
  });

  it('always states target, delivery boundary and scope', () => {
    renderPanel(fakeSession());
    expect(screen.getByText('Target').nextSibling).toHaveTextContent(
      'Writer · execution exec_0002',
    );
    expect(screen.getByText('Delivery').nextSibling).toHaveTextContent('next model request');
    expect(screen.getByText('Scope').nextSibling).toHaveTextContent('this execution only');
  });

  it('sends the instruction on Enter', async () => {
    const steer = vi.fn(async () => ({}) as never);
    renderPanel(fakeSession(steer));
    const box = screen.getByLabelText('Instruction');
    await userEvent.type(box, 'Primary sources only.{Enter}');
    expect(steer).toHaveBeenCalledWith('exec_0002', 'Primary sources only.');
  });

  it('does not send while an IME composition is confirming with Enter', () => {
    const steer = vi.fn(async () => ({}) as never);
    renderPanel(fakeSession(steer));
    const box = screen.getByLabelText('Instruction');
    fireEvent.change(box, { target: { value: '1차 자료만' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(steer).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(steer).toHaveBeenCalledWith('exec_0002', '1차 자료만');
  });

  it('keeps Shift+Enter as a new line', () => {
    const steer = vi.fn(async () => ({}) as never);
    renderPanel(fakeSession(steer));
    const box = screen.getByLabelText('Instruction');
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(steer).not.toHaveBeenCalled();
  });

  // docs/specs/product-contract.md: screens name the action and its target, never "Reins".
  it.each([false, true])('titles the panel by its action and target (compact %s)', (compact) => {
    const { container } = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel
          session={fakeSession()}
          target={{ executionId: 'exec_writer', nodeLabel: 'Writer', finished: false }}
          compact={compact}
        />
      </IntlProvider>,
    );
    expect(screen.getByRole('region', { name: 'Give instruction · Writer' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('Reins');
  });

  it('titles the panel by its action when nothing is chosen yet', () => {
    const { container } = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel session={fakeSession()} target={null} />
      </IntlProvider>,
    );
    expect(screen.getByRole('region', { name: 'Give instruction' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('Reins');
  });

  it('explains what to do when there is nothing to steer', () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel session={fakeSession()} target={null} />
      </IntlProvider>,
    );
    expect(
      screen.getByText('Start a run and choose an execution to give an instruction.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Instruction')).not.toBeInTheDocument();
  });

  it('keeps undelivered instructions visible after the execution finishes', () => {
    const session = fakeSession();
    session.setState({
      projection: {
        directiveOrder: ['dir_0001'],
        directives: {
          dir_0001: {
            directiveId: 'dir_0001',
            targetExecutionId: 'exec_0002',
            text: 'Primary sources only.',
            status: 'expired',
          },
        },
      } as never,
    });
    renderPanel(session, { executionId: 'exec_0002', nodeLabel: 'Writer', finished: true });
    expect(screen.getByText('Primary sources only.')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByLabelText('Instruction')).not.toBeInTheDocument();
    expect(
      screen.getByText('This execution has finished. New instructions can no longer be delivered.'),
    ).toBeInTheDocument();
  });
});

it.each(['awaiting_user', 'paused', 'pausing'])(
  'shows a scoped receipt and honors %s before restarting the latest cancelled attempt',
  async (status) => {
    const session = fakeSession();
    const sendCommand = vi.fn(async () => ({ status: 'applied' }) as never);
    session.setState({
      sendCommand,
      receipts: {
        cmd_cancel: {
          commandId: 'cmd_cancel',
          runId: 'run_0001',
          status: 'applied',
          acceptedSeq: 12,
          target: 'execution:exec_0002',
          requestedBoundary: 'safe_boundary',
          relatedEventIds: [],
        },
      },
      projection: {
        status,
        controlRevision: 4,
        executionOrder: ['exec_parent', 'exec_0002'],
        directiveOrder: [],
        directives: {},
        tasks: {
          task_2: { taskId: 'task_2', status: 'blocked', activeExecutionId: null, attemptCount: 1 },
        },
        executions: {
          exec_0002: {
            executionId: 'exec_0002',
            taskId: 'task_2',
            nodeId: 'writer',
            status: 'cancelled',
            attemptNo: 1,
            parentExecutionId: 'exec_parent',
          },
          exec_parent: {
            executionId: 'exec_parent',
            status: 'waiting_children',
            waitingOn: { targetIds: ['exec_0002'] },
          },
        },
      } as never,
    });
    renderPanel(session, { executionId: 'exec_0002', nodeLabel: 'Writer', finished: true });
    expect(screen.getByTestId('receipt-cmd_cancel')).toHaveTextContent('Applied');
    await userEvent.type(
      screen.getByLabelText('Instruction for the new attempt'),
      'Try again with sources',
    );
    if (status !== 'awaiting_user') {
      expect(
        screen.getByRole('button', { name: 'Restart task with a new attempt' }),
      ).toBeDisabled();
      expect(screen.getByText('Resume the run before restarting this task.')).toBeVisible();
      expect(sendCommand).not.toHaveBeenCalled();
      return;
    }
    await userEvent.click(screen.getByRole('button', { name: 'Restart task with a new attempt' }));
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'restart_task',
      expectedControlRevision: 4,
      payload: {
        taskId: 'task_2',
        previousExecutionId: 'exec_0002',
        instruction: 'Try again with sources',
      },
    });
  },
);

it('an execution cancel confirmed after the view moved to another run is not sent there', () => {
  const session = fakeSession();
  const running = (runId: string) => ({
    ...emptyProjection(runId),
    status: 'running' as const,
    executions: {
      exec_0002: { executionId: 'exec_0002', status: 'running', taskId: 'task_1' },
    } as never,
  });
  const sendCommand = vi.fn(async () => ({}) as never);
  session.setState({ projection: running('run_0001'), sendCommand });
  renderPanel(session);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel selected execution' }));
  expect(screen.getByRole('button', { name: 'Confirm selected cancellation' })).toBeTruthy();
  act(() => session.setState({ runId: 'run_0002', projection: running('run_0002') }));
  expect(screen.queryByRole('button', { name: 'Confirm selected cancellation' })).toBeNull();
  expect(sendCommand).not.toHaveBeenCalled();
});
