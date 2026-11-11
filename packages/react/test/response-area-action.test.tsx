import { RunEvent, type UserInputRequest } from '@corral/contracts';
import type { ApprovalView, ExecutionView } from '@corral/core';
import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// The Run page's close control rides on the response area's first row; no row holds it alone.

const approval = (approvalId: string, status: ApprovalView['status']): ApprovalView => ({
  approvalId,
  kind: 'user_action',
  subjectVersionIds: ['draft_v1'],
  criteriaVersionId: null,
  status,
});

const execution: ExecutionView = {
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
};

const question = RunEvent.parse({
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
const asked: UserInputRequest = {
  key: 'layout',
  questions: [{ id: 'layout', prompt: 'Which layout?', kind: 'text' }],
};

function show({
  approvals = [],
  events = [],
}: {
  approvals?: ApprovalView[];
  events?: RunEvent[];
}) {
  const session = sessionStore({
    runId: 'run_story',
    events,
    projection: projectionWith({
      status: 'awaiting_user',
      approvals: Object.fromEntries(approvals.map((item) => [item.approvalId, item])),
      executions: { exec_1: execution },
    }),
    artifactTexts: { body_user: JSON.stringify(asked) },
  });
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ApprovalPanel
        session={session}
        onOpenArtifact={() => {}}
        headed={false}
        showPlan={false}
        action={
          <button type="button" aria-label="Close details">
            ×
          </button>
        }
      />
    </IntlProvider>,
  );
}

const close = () => screen.getByRole('button', { name: 'Close details' });
/** The row the close sits in: its parent, less the close's own wrapper. */
const rowOf = (element: HTMLElement) =>
  element.closest('[data-row-action]')?.parentElement ?? element.parentElement;

it('puts the close on the decision card heading row, first in focus order', () => {
  show({ approvals: [approval('approval_1', 'pending')] });
  expect(screen.getAllByRole('button', { name: 'Close details' })).toHaveLength(1);
  const card = screen.getByRole('article', { name: messages.Approvals.heading });
  const row = rowOf(close());
  expect(row?.textContent).toContain(messages.Approvals.kind.user_action);
  expect(card.contains(row)).toBe(true);
  // It still comes before the card's own controls, as it did above the card.
  expect(within(card).getAllByRole('button')[0]).toBe(close());
});

it('puts the close on the first decision already made, above the waiting card', () => {
  show({ approvals: [approval('approval_0', 'approved'), approval('approval_1', 'pending')] });
  expect(screen.getAllByRole('button', { name: 'Close details' })).toHaveLength(1);
  expect(rowOf(close())).toBe(screen.getByTestId('approved-approval_0'));
});

it('puts the close on the question card row that names who asks, not on a later card', () => {
  show({ approvals: [approval('approval_1', 'pending')], events: [question] });
  expect(screen.getAllByRole('button', { name: 'Close details' })).toHaveLength(1);
  const form = screen.getByRole('form', { name: 'Waiting for you' });
  const row = rowOf(close());
  expect(form.contains(row)).toBe(true);
  expect(row?.textContent).toContain('writer');
  expect(
    within(row as HTMLElement).getByRole('button', { name: 'Copy execution ID' }),
  ).toBeVisible();
  const card = screen.getByRole('article', { name: messages.Approvals.heading });
  expect(within(card).queryByRole('button', { name: 'Close details' })).toBeNull();
});
