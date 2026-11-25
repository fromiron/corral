import type { Receipt } from '@corral/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// workbench.md 응답 카드: two or more plain approvals in one place get one control that approves
// exactly the cards drawn when it is pressed, each by its own command.

const pending = (approvalId: string, kind: string, extra: Record<string, unknown> = {}) => ({
  approvalId,
  kind,
  subjectVersionIds: ['draft_v2'],
  criteriaVersionId: null,
  status: 'pending',
  ...extra,
});

function mount(approvals: Record<string, unknown>) {
  const resolveApproval = vi.fn(async () => ({ status: 'applied' }) as Receipt);
  const session = sessionStore({
    projection: projectionWith({
      status: 'awaiting_user',
      artifacts: { draft_v2: { name: 'draft', version: 2 } } as never,
      approvals: approvals as never,
    }),
  });
  session.setState({ resolveApproval } as never);
  render(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <ApprovalPanel session={session} onOpenArtifact={() => {}} headed={false} />
    </IntlProvider>,
  );
  return { resolveApproval, session };
}

it('approves exactly the plain cards shown, and never a route choice', async () => {
  const { resolveApproval } = mount({
    a: pending('a', 'user_action'),
    b: pending('b', 'final_output'),
    r: pending('r', 'route', { routes: [{ id: 'left', label: 'Left' }] }),
  });
  const all = screen.getByRole('button', { name: 'Approve the 2 shown' });
  fireEvent.click(all);
  await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2));
  expect(resolveApproval.mock.calls.map((call) => (call as unknown[]).slice(0, 2))).toEqual([
    ['a', 'approve'],
    ['b', 'approve'],
  ]);
});

it('offers nothing for one plain card (counterexample)', () => {
  mount({ a: pending('a', 'user_action'), r: pending('r', 'route', { routes: [] }) });
  expect(screen.queryByRole('button', { name: /shown$/ })).toBeNull();
});
