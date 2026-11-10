import type { Receipt } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { RunSessionStore } from '../src/run/session.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// A decision sent from a card hands focus on when the card leaves, as an answered question does:
// to the next waiting card's main action, else to the conversation's request box. Focus the
// person already moved elsewhere stays where they put it.

type Approval = RunProjection['approvals'][string];
const approval = (approvalId: string, kind: Approval['kind']): Approval => ({
  approvalId,
  kind,
  subjectVersionIds: ['draft_v2'],
  criteriaVersionId: null,
  status: 'pending',
});

function waiting(...approvals: Approval[]) {
  return projectionWith({
    status: 'awaiting_user',
    approvals: Object.fromEntries(approvals.map((item) => [item.approvalId, item])),
  });
}

/** The approval leaves the waiting list, as its `approval.resolved` event does. */
function resolve(session: RunSessionStore, approvalId: string) {
  act(() =>
    session.setState((state) => {
      const projection = state.projection as RunProjection;
      const current = projection.approvals[approvalId] as Approval;
      return {
        projection: {
          ...projection,
          approvals: { ...projection.approvals, [approvalId]: { ...current, status: 'approved' } },
        },
      };
    }),
  );
}

/** Lets the frame after the card leaves run. */
const nextFrame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

function show(session: RunSessionStore, frame: (panel: ReactNode) => ReactNode) {
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {frame(<ApprovalPanel session={session} onOpenArtifact={() => {}} headed={false} />)}
    </IntlProvider>,
  );
}

/** A chat view: the conversation with the panel, then the composer's request box. */
const chat = (panel: ReactNode) => (
  <div data-chat-view>
    <section aria-label="Conversation">{panel}</section>
    <div data-testid="chat-composer">
      <textarea aria-label="Request" />
    </div>
  </div>
);

async function decide(name: string) {
  const button = screen.getByRole('button', { name });
  button.focus();
  expect(button).toHaveFocus();
  await act(async () => button.click());
}

it('hands focus to the request box when the decided card leaves a chat view', async () => {
  const resolveApproval = vi.fn(async () => ({}) as Receipt);
  const session = sessionStore({
    projection: waiting(approval('approval_1', 'user_action')),
    resolveApproval,
  });
  show(session, chat);
  await decide(messages.Approvals.approveAs.user_action);
  expect(resolveApproval).toHaveBeenCalledWith('approval_1', 'approve');
  resolve(session, 'approval_1');
  await nextFrame();
  expect(screen.getByRole('textbox', { name: 'Request' })).toHaveFocus();
});

it('hands focus to the next waiting card’s main action when another approval waits', async () => {
  const session = sessionStore({
    projection: waiting(
      approval('approval_1', 'user_action'),
      approval('approval_2', 'final_output'),
    ),
  });
  show(session, chat);
  await decide(messages.Approvals.approveAs.user_action);
  resolve(session, 'approval_1');
  await nextFrame();
  expect(
    screen.getByRole('button', { name: messages.Approvals.approveAs.final_output }),
  ).toHaveFocus();
});

it('waits for the receipt, so the next card’s main action can take focus', async () => {
  let receipt!: (value: Receipt) => void;
  const session = sessionStore({
    projection: waiting(
      approval('approval_1', 'user_action'),
      approval('approval_2', 'final_output'),
    ),
    resolveApproval: () => new Promise<Receipt>((done) => (receipt = done)),
  });
  show(session, chat);
  await decide(messages.Approvals.approveAs.user_action);
  // The card left before the receipt: the next card's buttons are still disabled.
  resolve(session, 'approval_1');
  await nextFrame();
  await act(async () => receipt({} as Receipt));
  await nextFrame();
  expect(
    screen.getByRole('button', { name: messages.Approvals.approveAs.final_output }),
  ).toHaveFocus();
});

it('hands focus to the next card’s decline when its main action cannot be taken', async () => {
  // A tool permission whose call could not be verified can only be declined.
  const tool: Approval = {
    ...approval('approval_2', 'user_action'),
    tool: {
      purpose: 'tool',
      executionId: 'exec_writer',
      attemptNo: 1,
      toolCallId: 'call_1',
      bodyRef: 'body_unreadable',
      fingerprint: 'a'.repeat(64),
      deadline: '2026-11-09T00:05:00.000Z',
    },
  };
  const session = sessionStore({
    projection: waiting(approval('approval_1', 'user_action'), tool),
  });
  show(session, chat);
  await decide(messages.Approvals.approveAs.user_action);
  resolve(session, 'approval_1');
  await nextFrame();
  expect(screen.getByRole('button', { name: messages.Approvals.approveTool })).toBeDisabled();
  expect(screen.getByRole('button', { name: messages.Approvals.rejectTool })).toHaveFocus();
});

it('keeps focus in a card whose decision was refused', async () => {
  const session = sessionStore({
    projection: waiting(approval('approval_1', 'user_action')),
    resolveApproval: async () =>
      ({ error: { code: 'stale', message: 'Out of date' } }) as unknown as Receipt,
  });
  show(session, chat);
  await decide(messages.Approvals.approveAs.user_action);
  await nextFrame();
  expect(
    screen.getByRole('button', { name: messages.Approvals.approveAs.user_action }),
  ).toHaveFocus();
  expect(screen.getByRole('alert')).toHaveTextContent('Out of date');
});

it('hands focus on after a rejection too, and when the card leaves before the receipt', async () => {
  let receipt!: (value: Receipt) => void;
  const session = sessionStore({
    projection: waiting(approval('approval_1', 'user_action')),
    resolveApproval: () => new Promise<Receipt>((done) => (receipt = done)),
  });
  show(session, chat);
  await decide(messages.Approvals.rejectAs.user_action);
  resolve(session, 'approval_1');
  await nextFrame();
  await act(async () => receipt({} as Receipt));
  await nextFrame();
  expect(screen.getByRole('textbox', { name: 'Request' })).toHaveFocus();
});

it('leaves focus where the person moved it before the card left', async () => {
  const session = sessionStore({ projection: waiting(approval('approval_1', 'user_action')) });
  show(session, (panel) => (
    <>
      {chat(panel)}
      <input aria-label="Search" />
    </>
  ));
  await decide(messages.Approvals.approveAs.user_action);
  const search = screen.getByRole('textbox', { name: 'Search' });
  search.focus();
  resolve(session, 'approval_1');
  await nextFrame();
  expect(search).toHaveFocus();
});

it('does not move focus for a card that did not hold it', async () => {
  const session = sessionStore({ projection: waiting(approval('approval_1', 'user_action')) });
  show(session, chat);
  // Decided elsewhere (another view of the same run): this card never held focus.
  resolve(session, 'approval_1');
  await nextFrame();
  expect(document.body).toHaveFocus();
});

it('leaves the last decision’s focus to a host that is not a chat view', async () => {
  // The Run page and Needs you move focus themselves once nothing waits.
  const session = sessionStore({ projection: waiting(approval('approval_1', 'user_action')) });
  show(session, (panel) => (
    <>
      <section aria-label="Response area">{panel}</section>
      <textarea aria-label="Elsewhere" />
    </>
  ));
  await decide(messages.Approvals.approveAs.user_action);
  resolve(session, 'approval_1');
  await nextFrame();
  expect(document.body).toHaveFocus();
});
