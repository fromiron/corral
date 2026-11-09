import { emptyProjection } from '@corral/core';
import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ExecutionSteering } from '../src/components/ExecutionSteering.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { RunSessionState } from '../src/run/session.ts';

function sessionWithTwoExecutions() {
  const projection = emptyProjection('run_1');
  projection.status = 'running';
  projection.executions = {
    exec_writer: { executionId: 'exec_writer', status: 'active', modelProfile: 'writer' },
    exec_reviewer: { executionId: 'exec_reviewer', status: 'active', modelProfile: 'reviewer' },
  } as never;
  projection.directiveOrder = ['dir_writer', 'dir_reviewer'];
  projection.directives = {
    dir_writer: {
      directiveId: 'dir_writer',
      targetExecutionId: 'exec_writer',
      text: 'Writer instruction',
      status: 'delivery_unknown',
      reason: 'Awaiting confirmation',
    },
    dir_reviewer: {
      directiveId: 'dir_reviewer',
      targetExecutionId: 'exec_reviewer',
      text: 'Reviewer instruction',
      status: 'delivered',
    },
  } as never;
  return createStore<RunSessionState>(
    () =>
      ({
        runId: 'run_1',
        projection,
        artifactTexts: {},
        streams: {},
        events: [
          {
            type: 'tool.requested',
            runSeq: 1,
            payload: {
              executionId: 'exec_writer',
              toolCallId: 'call_writer',
              name: 'writer_search',
              validatedArgs: { query: 'primary sources' },
            },
          },
          {
            type: 'tool.requested',
            runSeq: 2,
            payload: {
              executionId: 'exec_reviewer',
              toolCallId: 'call_reviewer',
              name: 'reviewer_search',
              validatedArgs: {},
            },
          },
        ],
        loadArtifact: vi.fn(),
      }) as unknown as RunSessionState,
  );
}

describe('ExecutionSteering', () => {
  it.each([
    { runStatus: 'paused', executionStatus: 'paused', label: 'Paused' },
    { runStatus: 'awaiting_user', executionStatus: 'waiting_approval', label: 'Waiting for you' },
    { runStatus: 'running', executionStatus: 'waiting_children', label: 'Waiting for sub-agents' },
  ] as const)(
    'keeps unfinished tools static while their owner is $executionStatus',
    ({ runStatus, executionStatus, label }) => {
      const session = sessionWithTwoExecutions();
      const state = session.getState();
      if (!state.projection) throw new Error('fixture projection missing');
      const writer = state.projection.executions.exec_writer;
      if (!writer) throw new Error('fixture execution missing');
      session.setState({
        projection: {
          ...state.projection,
          status: runStatus,
          executions: {
            ...state.projection.executions,
            exec_writer: { ...writer, status: executionStatus },
          },
        },
        events: [
          ...state.events,
          {
            type: 'tool.requested',
            runSeq: 3,
            payload: {
              executionId: 'exec_writer',
              toolCallId: 'done',
              name: 'read_document',
              validatedArgs: {},
            },
          },
          {
            type: 'tool.finished',
            runSeq: 4,
            payload: {
              executionId: 'exec_writer',
              toolCallId: 'done',
              resultRef: null,
              error: null,
            },
          },
          {
            type: 'tool.requested',
            runSeq: 5,
            payload: {
              executionId: 'exec_writer',
              toolCallId: 'failed',
              name: 'run_check',
              validatedArgs: {},
            },
          },
          {
            type: 'tool.finished',
            runSeq: 6,
            payload: {
              executionId: 'exec_writer',
              toolCallId: 'failed',
              resultRef: null,
              error: 'Check failed',
            },
          },
        ] as never,
      });
      const { container } = render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ExecutionSteering
            session={session}
            target={{ executionId: 'exec_writer', nodeLabel: 'Writer', finished: false }}
            compose={null}
            showToolActivity
          />
        </IntlProvider>,
      );
      const pending = screen.getByRole('button', { name: /^writer_search/ });
      expect(pending.closest('[data-status]')).toHaveAttribute('data-status', 'waiting');
      expect(pending).toHaveTextContent(label);
      expect(
        screen.getByRole('button', { name: /^read_document/ }).closest('[data-status]'),
      ).toHaveAttribute('data-status', 'success');
      expect(
        screen.getByRole('button', { name: /^run_check/ }).closest('[data-status]'),
      ).toHaveAttribute('data-status', 'error');
      expect(container.querySelector('.shimmer-text')).toBeNull();
    },
  );

  it('shows only the selected execution’s tool activity and directive delivery state', () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionSteering
          session={sessionWithTwoExecutions()}
          target={{ executionId: 'exec_writer', nodeLabel: 'Writer', finished: false }}
          compose={<textarea aria-label="Instruction" />}
          showToolActivity
        />
      </IntlProvider>,
    );
    expect(screen.getByRole('button', { name: /writer_search/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reviewer_search/ })).toBeNull();
    expect(screen.getByText('Writer instruction')).toBeInTheDocument();
    expect(screen.getByText('Delivery unknown')).toBeInTheDocument();
    expect(screen.getByText('Awaiting confirmation')).toBeInTheDocument();
    expect(screen.queryByText('Reviewer instruction')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Now' })).toBeNull();
    expect(screen.queryByText(/Step \d|0s/)).toBeNull();
  });
});
