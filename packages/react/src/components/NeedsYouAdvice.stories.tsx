import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { InboxStoryFrame } from '../../../../apps/studio/src/pages/InboxPage.story-fixture.tsx';
import { InboxPage } from '../../../../apps/studio/src/pages/InboxPage.tsx';

// Needs you with advice its target never read (docs/specs/features/inbox.md `advice`).

const items: ComponentProps<typeof InboxStoryFrame>['items'] = [
  {
    kind: 'advice',
    sessionId: 'session_sources',
    sessionTitle: 'Compare two vendors',
    runId: 'run_sources',
    executionId: 'exec_sources',
    severity: 'concern',
    detail: 'The answer cites one source where the brief asks for two.',
  },
  {
    kind: 'advice',
    sessionId: 'session_api',
    sessionTitle: 'Migrate the billing client',
    runId: 'run_api',
    executionId: 'exec_api',
    severity: 'blocker',
    detail: 'The new client still calls the retired v1 endpoint.',
  },
  {
    kind: 'check_failed',
    sessionId: 'session_tests',
    sessionTitle: 'Tidy the test helpers',
    runId: null,
    detail: 'Types',
  },
];

function NeedsYou() {
  return (
    <div className="h-[44rem] w-[72rem]">
      <InboxStoryFrame
        items={items}
        runs={[
          {
            runId: 'run_sources',
            sessionId: 'session_sources',
            projectId: 'story_project',
            corralId: 'team',
            status: 'succeeded',
            startedAt: '2026-11-13T00:00:00Z',
          },
        ]}
      >
        <InboxPage />
      </InboxStoryFrame>
    </div>
  );
}

const meta = {
  title: 'Workbench/Needs you advice',
  component: NeedsYou,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof NeedsYou>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AdviceRows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByText(
          'Concern · The answer cites one source where the brief asks for two. · Run #1',
        ),
      ).toBeVisible(),
    );
    expect(
      canvas.getByText('Blocker · The new client still calls the retired v1 endpoint.'),
    ).toBeVisible();
    expect(canvas.getByText('Review')).toBeVisible();
  },
};
