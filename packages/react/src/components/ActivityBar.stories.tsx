import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AgentSteeringPlan, Elevated, Meter } from '../design-kit/index.ts';
import { ActivityBar, type ActivityBarProps, type ActivityBarRole } from './ActivityBar.tsx';

// The composer's activity bar in its five situations, inside the composer's one raised card as
// the session screen shows it: nothing running, one role at work, three roles at work, a request
// waiting while its card is off-screen, and a lost connection.

// The words crossfade on springs, and the a11y check runs after play: wait until nothing in the
// canvas is still fading.
async function settled(canvasElement: HTMLElement) {
  await waitFor(
    () => {
      for (const el of canvasElement.querySelectorAll('*')) {
        // A folded panel is hidden at rest, at its closed opacity.
        if (el.closest('[hidden]')) continue;
        expect(getComputedStyle(el).opacity).toBe('1');
      }
    },
    { timeout: 3000 },
  );
}

const started = Date.now() - 68_000;

function Card(props: ActivityBarProps) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <Elevated offset={2} className="rounded-[var(--shape-panel-radius)] p-1">
        <ActivityBar {...props} open={open} onOpenChange={setOpen} />
        <div className="px-2.5 py-2 text-ui text-muted-foreground">Ask for the next change…</div>
      </Elevated>
    </div>
  );
}

const plan = (
  <AgentSteeringPlan
    labels={{ plan: 'Work plan' }}
    status="running"
    steps={[
      { id: 'read', title: 'Read the session store', status: 'done' },
      { id: 'fix', title: 'Fix the session lookup', status: 'active' },
      { id: 'test', title: 'Run the auth tests', status: 'pending' },
    ]}
    className="px-0 pb-0"
  />
);

const context = (
  <div className="flex items-center gap-3 text-caption text-muted-foreground">
    <span>Context</span>
    <Meter value={0.41} label="Context about 41%" className="w-24" />
    <span className="tabular-nums">41%</span>
  </div>
);

const contextEnd = (
  <span className="px-2 text-caption tabular-nums text-muted-foreground">about 41%</span>
);

const role = (change: Partial<ActivityBarRole> & Pick<ActivityBarRole, 'id' | 'name'>) =>
  ({
    glyph: 'running',
    tone: 'active',
    state: { text: 'Working', target: `execution:${change.id}` },
    stateShown: true,
    target: false,
    startedAt: started,
    onShow: fn(),
    onJoin: fn(),
    ...change,
  }) satisfies ActivityBarRole;

const meta = {
  title: 'Components/ActivityBar',
  component: Card,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing runs: the ended run's state, its plan and its changes; context at the right end. */
export const Idle: Story = {
  args: {
    line: {
      glyph: 'done',
      tone: 'success',
      state: { text: 'Completed', target: 'run:run_story' },
      parts: (
        <>
          <span className="tabular-nums">5/5 done</span>
          <span aria-hidden>·</span>
          <span>3 changes</span>
        </>
      ),
    },
    end: contextEnd,
    plan,
    context,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Activity details' });
    // The closed line by keyboard: the toggle opens the panel above it, Escape folds it and
    // gives the focus back.
    await userEvent.tab();
    await expect(toggle).toHaveFocus();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{Enter}');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = canvas.getByRole('region', { name: 'Activity' });
    await waitFor(() => expect(panel).toBeVisible());
    // Once it has opened, the panel is above the line it opens from.
    await waitFor(() =>
      expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        toggle.getBoundingClientRect().top + 1,
      ),
    );
    await userEvent.keyboard('{Escape}');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveFocus();
    await settled(canvasElement);
  },
};

/** One role at work: its activity and clock. */
export const OneRole: Story = {
  args: {
    line: {
      glyph: 'running',
      tone: 'active',
      text: 'Read file',
      parts: <span className="tabular-nums">1/3 done</span>,
      startedAt: started,
    },
    end: contextEnd,
    roles: [role({ id: 'exec_lead', name: 'Corral', activity: 'Read file', target: true })],
    plan,
    context,
    controls: { paused: false, onPause: fn(), onStop: fn() },
  },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
  },
};

const team = [
  role({ id: 'exec_research', name: 'Researcher', activity: 'Read documents' }),
  role({ id: 'exec_impl', name: 'Implementer', activity: 'Edit file', target: true }),
  role({
    id: 'exec_review',
    name: 'Reviewer',
    glyph: 'queued',
    tone: 'active',
    state: { text: 'Starting', target: 'execution:exec_review' },
    startedAt: undefined,
  }),
];

/** Three roles at work, the panel open: each role's row, the plan and the run controls. */
export const ThreeRoles: Story = {
  args: {
    line: {
      glyph: 'running',
      tone: 'active',
      text: '3 roles working · Implementer: Edit file',
      parts: <span className="tabular-nums">1/3 done</span>,
      startedAt: started,
    },
    end: contextEnd,
    roles: team,
    plan,
    context,
    controls: { paused: false, onPause: fn(), onStop: fn() },
    defaultOpen: true,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole('region', { name: 'Activity' });
    await waitFor(() => expect(panel).toBeVisible());
    // Joining a role is a button on its row, reached by keyboard; the target says it is one.
    const join = within(panel).getByRole('button', { name: 'Join Researcher' });
    join.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.roles?.[0]?.onJoin).toHaveBeenCalledOnce();
    await expect(within(panel).queryByRole('button', { name: 'Join Implementer' })).toBeNull();
    await expect(within(panel).getByText('Join target')).toBeVisible();
    within(panel).getByRole('button', { name: 'View Reviewer' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.roles?.[2]?.onShow).toHaveBeenCalledOnce();
    // Escape from inside the panel folds it and returns to the toggle.
    await userEvent.keyboard('{Escape}');
    const toggle = canvas.getByRole('button', { name: 'Activity details' });
    await expect(toggle).toHaveFocus();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await settled(canvasElement);
  },
};

const approve = fn();
const deny = fn();

/** A request waiting while its card is off-screen: what it waits for, decided by its buttons. */
export const AwaitingResponse: Story = {
  args: {
    line: {
      glyph: 'waiting',
      tone: 'warning',
      state: { text: 'Waiting for you', target: 'execution:exec_impl' },
      text: 'Implementer: Run command',
      approval: {
        subject: 'Run command',
        approveLabel: 'Allow once',
        denyLabel: 'Deny',
        onApprove: approve,
        onDeny: deny,
      },
    },
    end: contextEnd,
    roles: team,
    controls: { paused: false, onPause: fn(), onStop: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Activity details' });
    // Enter on the line opens it; it never decides.
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Escape}');
    await expect(approve).not.toHaveBeenCalled();
    await expect(deny).not.toHaveBeenCalled();
    // The decision is its explicit button, and the focus returns to the line.
    await userEvent.click(canvas.getByRole('button', { name: 'Allow once · Run command' }));
    await expect(approve).toHaveBeenCalledOnce();
    await expect(toggle).toHaveFocus();
    await settled(canvasElement);
  },
};

const retry = fn();

/** The connection is lost: the line says so, with its one way back. */
export const Disconnected: Story = {
  args: {
    line: {
      glyph: 'failed',
      tone: 'danger',
      text: 'Connection lost',
      warning: true,
      action: { label: 'Retry', onClick: retry },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Nothing to fold out: no toggle, and the one action.
    await expect(canvas.queryByRole('button', { name: 'Activity details' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(retry).toHaveBeenCalledOnce();
    await settled(canvasElement);
  },
};
