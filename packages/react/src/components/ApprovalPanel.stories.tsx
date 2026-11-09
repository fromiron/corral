import type { CheckPlan } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, within } from 'storybook/test';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { ApprovalPanel } from './ApprovalPanel.tsx';

type Approval = RunProjection['approvals'][string];

const plan: CheckPlan = {
  commandId: 'types',
  name: 'Type check',
  argv: ['pnpm', 'typecheck'],
  timeoutMs: 10000,
  configRevision: 2,
  fingerprint: 'a'.repeat(64),
  tree: 'b'.repeat(40),
  trusted: false,
};

const checkApproval: Approval = {
  approvalId: 'approval_check',
  kind: 'user_action',
  subjectVersionIds: ['check_body'],
  criteriaVersionId: null,
  status: 'pending',
  tool: {
    executionId: 'exec_reviewer',
    attemptNo: 1,
    effectId: 'effect_1',
    toolCallId: 'tool_1',
    bodyRef: 'check_body',
    fingerprint: plan.fingerprint,
    targetTree: plan.tree,
    deadline: '2099-10-18T00:00:00.000Z',
  },
};

const outputApproval: Approval = {
  approvalId: 'approval_output',
  kind: 'final_output',
  subjectVersionIds: ['report_v2'],
  criteriaVersionId: null,
  status: 'pending',
};

function store(approvals: Approval[], resolveApproval = fn()) {
  return sessionStore({
    projection: projectionWith({
      status: 'awaiting_user',
      approvals: Object.fromEntries(approvals.map((a) => [a.approvalId, a])),
    }),
    artifactTexts: { check_body: JSON.stringify(plan) },
    resolveApproval: async (...args: unknown[]) => {
      resolveApproval(...args);
      return { status: 'applied' } as never;
    },
  });
}

const meta = {
  title: 'Run/ApprovalPanel',
  component: ApprovalPanel,
  args: { session: store([checkApproval, outputApproval]), onOpenArtifact: fn() },
} satisfies Meta<typeof ApprovalPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A check launch and a final output, each waiting on its own buttons. */
export const Waiting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('pnpm typecheck')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Run this check once' })).toBeEnabled();
  },
};

const decided = fn();

/** Enter and Escape on the card decide nothing; only the buttons send a decision. */
export const ButtonsOnly: Story = {
  args: { session: store([checkApproval], decided) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByTestId('approval-approval_check');
    await canvas.findByText('pnpm typecheck');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: 'Escape' });
    await expect(decided).not.toHaveBeenCalled();
  },
};

/** The one-row strip beside the results view. */
export const Compact: Story = {
  args: { compact: true },
};

const routeApproval: Approval = {
  approvalId: 'approval_route',
  kind: 'route',
  subjectVersionIds: ['report_v2'],
  criteriaVersionId: null,
  status: 'pending',
  routes: [
    { id: 'fix', label: 'Fix it' },
    { id: 'ship', label: 'Ship it' },
  ],
};
const routed = fn();

/** A router that could not choose: each connected route is its own button. */
export const RouteChoice: Story = {
  args: { session: store([routeApproval], routed) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Choose a route')).toBeVisible();
    fireEvent.click(canvas.getByRole('button', { name: 'Ship it' }));
    await expect(routed).toHaveBeenCalledWith('approval_route', 'approve', 'ship');
  },
};

const checkVerdictApproval: Approval = {
  approvalId: 'approval_checks',
  kind: 'check',
  subjectVersionIds: ['report_v2'],
  criteriaVersionId: null,
  status: 'pending',
};
const rerun = fn();

/** A check step whose checks gave no verdict: run them again or stop. */
export const NoCheckVerdict: Story = {
  args: { session: store([checkVerdictApproval], rerun) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Checks gave no verdict')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Stop here' })).toBeEnabled();
    fireEvent.click(canvas.getByRole('button', { name: 'Run checks again' }));
    await expect(rerun).toHaveBeenCalledWith('approval_checks', 'approve');
  },
};
