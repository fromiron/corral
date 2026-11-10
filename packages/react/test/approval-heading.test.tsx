import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// A response area has one visible title: the panel's own when it stands alone, else its host's.
function show(headed?: boolean) {
  const session = sessionStore({
    projection: projectionWith({
      status: 'awaiting_user',
      approvals: {
        approval_final: {
          approvalId: 'approval_final',
          kind: 'final_output',
          subjectVersionIds: ['draft_v1'],
          criteriaVersionId: null,
          status: 'pending',
        },
      },
    }),
  });
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ApprovalPanel
        session={session}
        onOpenArtifact={() => {}}
        {...(headed === undefined ? {} : { headed })}
      />
    </IntlProvider>,
  );
}

it('titles itself when it stands alone', () => {
  show();
  const region = screen.getByRole('region', { name: messages.Approvals.heading });
  expect(within(region).getByRole('heading', { name: messages.Approvals.heading })).toBeVisible();
});

it('leaves the visible title to its host and keeps the name of its region', () => {
  const { container } = show(false);
  const region = screen.getByRole('region', { name: messages.Approvals.heading });
  expect(within(region).queryByRole('heading')).toBeNull();
  expect(container.textContent).not.toContain(messages.Approvals.heading);
  // The decision itself is still there to answer.
  expect(within(region).getByRole('article')).toBeVisible();
});
