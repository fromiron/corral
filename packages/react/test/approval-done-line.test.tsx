import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// A decision already made stays in view as one line with one mark: the line's icon.
it.each([
  ['en', en, 'approved'],
  ['ko', ko, '승인함'],
] as const)('marks a decided approval once (%s)', (locale, messages, approved) => {
  const session = sessionStore({
    projection: projectionWith({
      status: 'awaiting_user',
      artifacts: {
        draft_v2: { name: 'draft', version: 2 },
      } as never,
      approvals: {
        approval_first: {
          approvalId: 'approval_first',
          kind: 'user_action',
          subjectVersionIds: ['draft_v2'],
          criteriaVersionId: null,
          status: 'approved',
        },
        approval_final: {
          approvalId: 'approval_final',
          kind: 'final_output',
          subjectVersionIds: ['draft_v2'],
          criteriaVersionId: null,
          status: 'pending',
        },
      },
    }),
  });
  render(
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <ApprovalPanel session={session} onOpenArtifact={() => {}} headed={false} />
    </IntlProvider>,
  );
  const line = screen.getByTestId('approved-approval_first');
  // The icon is the one mark; the words carry no check character of their own.
  expect(line.querySelectorAll('svg')).toHaveLength(1);
  expect(line.textContent).not.toMatch(/[✓✔☑✅]/u);
  // The icon is silent, so the words say the decision was approved.
  expect(line.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(line.textContent).toContain(approved);
  expect(line.textContent).toContain('draft v2');
});
