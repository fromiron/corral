import { emptyProjection } from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { OverviewStoryRouter } from '../../../../apps/studio/src/workbench/widgets/OverviewWidgets.story-fixture.tsx';
import {
  OverviewPopover,
  OverviewWidgets,
} from '../../../../apps/studio/src/workbench/widgets/OverviewWidgets.tsx';
import {
  actionRequired,
  activityLine,
  presentContext,
  usageSummary,
  viewedRun,
} from '../../../../apps/studio/src/workbench/widgets/selectors.ts';
import type { ChatWidgetModel } from '../../../../apps/studio/src/workbench/widgets/useChatWidgets.tsx';

function fixture(live = true): ChatWidgetModel {
  const projection = emptyProjection('overview_story');
  projection.status = live ? 'running' : 'succeeded';
  for (const [index, outputTokens] of [180, 260, 210, 280].entries()) {
    projection.modelCalls[`call_${index}`] = {
      modelCallId: `call_${index}`,
      executionId: 'exec_writer',
      finished: true,
      usage: { outputTokens },
    } as never;
  }
  const usage = usageSummary(projection);
  return {
    sessionId: 'overview_story_session',
    runId: projection.runId,
    live,
    viewed: viewedRun({ runIds: [projection.runId], presentationRunId: projection.runId, live }),
    runNumber: 1,
    failedExecutionId: null,
    simulated: true,
    readState: 'ready',
    retryRead: fn(),
    context: {
      ...presentContext({
        calls: [],
        compactions: [],
        executionIds: [],
        selectedExecutionId: null,
      }),
      kind: 'request',
      tokens: 26_300,
      windowTokens: 64_000,
      percent: 41,
      barPercent: 41,
      coverage: 'request',
      completeness: 'complete',
    },
    reserveTokens: null,
    chips: ['context', 'agents', 'changes', 'environment'],
    changesLabel: live ? 'provisional' : 'fixed',
    changeFiles: 3,
    changeLines: 24,
    changeAdditions: 18,
    changeDeletions: 6,
    agents: { total: 2, working: live ? 1 : 0, waiting: live ? 1 : 0, failed: 0 },
    agentRows: [
      { id: 'writer', name: 'Writer', status: live ? 'active' : 'succeeded' },
      { id: 'reviewer', name: 'Reviewer', status: live ? 'waiting_message' : 'succeeded' },
    ],
    tools: [],
    results: [{ id: 'current_report', label: 'Research report v1' }],
    environment: 'simulated',
    usage: usage ? { ...usage, perCall: [140, 260, 210, 320] } : null,
    cost: null,
    action: actionRequired({
      pendingApprovals: 0,
      pendingQuestions: 0,
      failedEffects: 0,
      unclearEffects: 0,
    }),
    questionNotice: null,
    activity: {
      ...activityLine({
        runStatus: projection.status,
        startedAt: null,
        endedAt: null,
        now: '2026-11-06T00:00:00Z',
        planTitle: null,
        planVisible: false,
        toolName: null,
        failed: false,
        needsUser: false,
      }),
      runId: projection.runId,
    },
    plan: {
      open: false,
      setOpen: fn(),
      status: { state: 'hidden' },
      choices: [],
      multiple: false,
      auto: true,
      selectedKey: null,
      selectedChoice: null,
      runStatus: projection.status,
      retry: fn(),
      follow: fn(),
      choose: fn(),
    },
    notice: '',
  };
}

const meta = {
  title: 'Chat/OverviewWidgets',
  component: OverviewWidgets,
  args: { model: fixture() },
  decorators: [
    (Story) => (
      <OverviewStoryRouter>
        <Story />
      </OverviewStoryRouter>
    ),
  ],
  render: (args) => (
    <div className="w-72 max-w-full">
      <OverviewWidgets {...args} />
    </div>
  ),
} satisfies Meta<typeof OverviewWidgets>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Writer')).toBeVisible();
    await expect(canvas.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '41');
    await expect(canvas.getByRole('button', { name: 'Research report v1' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open Usage details' }));
    await expect(
      within(canvasElement.ownerDocument.body).getByTestId('usage-detail'),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Open Usage details' })).toHaveFocus(),
    );
  },
};

export const PendingAttention: Story = {
  args: {
    model: {
      ...fixture(),
      action: actionRequired({
        pendingApprovals: 1,
        pendingQuestions: 0,
        failedEffects: 0,
        unclearEffects: 0,
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Approval needed')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Respond' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  },
};

export const CompletedDark: Story = {
  args: { model: fixture(false) },
  render: (args) => (
    <div
      className="dark w-72 max-w-full bg-background text-foreground"
      style={{ colorScheme: 'dark' }}
    >
      <OverviewWidgets {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const order = [...canvasElement.querySelectorAll<HTMLElement>('[data-overview-widget]')].map(
      (element) => element.dataset.overviewWidget,
    );
    await expect(order.slice(0, 3)).toEqual(['results', 'changes', 'agents']);
    await expect(within(canvasElement).queryByText('Writer')).not.toBeInTheDocument();
  },
};

export const Unmeasured: Story = {
  args: {
    model: {
      ...fixture(),
      context: presentContext({
        calls: [],
        compactions: [],
        executionIds: [],
        selectedExecutionId: null,
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('progressbar')).not.toBeInTheDocument();
  },
};

export const NarrowOverview: Story = {
  render: (args) => (
    <div className="w-80 max-w-full pt-80">
      <OverviewPopover {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('session-summary-trigger'));
    const body = within(canvasElement.ownerDocument.body);
    const popup = await body.findByTestId('session-summary-popup');
    await waitFor(() => {
      const bounds = popup.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
      expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
    });
    await expect(within(popup).getByRole('button', { name: 'Research report v1' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.getByTestId('session-summary-trigger')).toHaveFocus());
  },
};
