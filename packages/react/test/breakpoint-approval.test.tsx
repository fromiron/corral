import type { Receipt } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

// docs/specs/features/fork-and-breakpoints.md: a breakpoint holds one named step before it starts.
function setup() {
  const resolveApproval = vi.fn(async () => ({ status: 'applied' }) as Receipt);
  const definition = linearCorral(['research', 'writer']);
  const writer = definition.nodes.find((node) => node.id === 'writer');
  if (writer) writer.label = 'Writer';
  const session = sessionStore({
    definition,
    projection: projectionWith({
      status: 'awaiting_user',
      breakpoints: ['writer'],
      approvals: {
        approval_bp: {
          approvalId: 'approval_bp',
          kind: 'breakpoint',
          nodeId: 'writer',
          subjectVersionIds: ['research_v1'],
          criteriaVersionId: null,
          status: 'pending',
        },
      },
    }),
    resolveApproval,
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ApprovalPanel session={session} onOpenArtifact={() => {}} />
    </IntlProvider>,
  );
  return resolveApproval;
}

it('names the held step and continues it', async () => {
  const decide = setup();
  expect(await screen.findByText('Paused before Writer')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await vi.waitFor(() => expect(decide).toHaveBeenCalledWith('approval_bp', 'approve'));
});

it('stops the run from the held step', async () => {
  const decide = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop the run' }));
  await vi.waitFor(() => expect(decide).toHaveBeenCalledWith('approval_bp', 'reject'));
});
