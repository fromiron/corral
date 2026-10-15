import { fireEvent, render, screen } from '@testing-library/react';
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
    projection: null,
    events: [],
    outputText: null,
    startError: null,
    streamError: null,
    missingRunId: null,
    pendingCommandIds: [],
    receipts: {},
    start: vi.fn(),
    open: vi.fn(),
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

  it('[TC-UX-001-N] does not send while an IME composition is confirming with Enter', () => {
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

  it('explains what to do when there is nothing to steer', () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReinsPanel session={fakeSession()} target={null} />
      </IntlProvider>,
    );
    expect(screen.getByText('Start a run and choose an execution to steer.')).toBeInTheDocument();
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
