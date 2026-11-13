// @vitest-environment jsdom
import { emptyProjection, type RunProjection, type RunSummary } from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { DockRunControls } from './DockRunControls.tsx';
import { topbarLayout } from './topbarTier.ts';

const fixture = vi.hoisted(() => ({ services: {}, tier: 0 }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
// The bar's tier is measured in the browser; here a test names the tier it is at.
vi.mock('./TopbarSlot.tsx', async (original) => ({
  ...(await original<typeof import('./TopbarSlot.tsx')>()),
  useTopbarLayout: () => topbarLayout(fixture.tier),
}));

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  fixture.tier = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const summary = (runId: string, status: RunSummary['status']): RunSummary => ({
  runId,
  status,
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-11-09T00:00:00Z',
});

function pendingApproval(projection: RunProjection, approvalId: string) {
  projection.approvals[approvalId] = {
    approvalId,
    kind: 'artifact',
    subjectVersionIds: [],
    criteriaVersionId: null,
    status: 'pending',
  } as unknown as RunProjection['approvals'][string];
}

async function mount({
  session,
  runs = [summary('active-run', 'running')],
  viewingOther = false,
}: {
  session: RunSessionStore;
  runs?: RunSummary[];
  viewingOther?: boolean;
}) {
  const release = vi.fn();
  const runFor = vi.fn(() => session);
  const retainRun = vi.fn(() => release);
  fixture.services = { runFor, retainRun };
  const onOpen = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DockRunControls
          runId="active-run"
          runs={runs}
          request="Summarize the report"
          viewingOther={viewingOther}
          onOpen={onOpen}
        />
      </IntlProvider>,
    );
  });
  const pill = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="dock-open-active-run"] button[data-pill-toggle]',
    );
  return { container, onOpen, runFor, retainRun, release, pill };
}

function running(change: Partial<RunProjection> = {}) {
  return {
    ...emptyProjection('active-run'),
    status: 'running' as const,
    startedAt: '2026-11-09T00:00:00Z',
    ...change,
  };
}

it('controls outside hidden panes retain and open the active run, not the historical selection', async () => {
  const session = createRunSession({} as never);
  const open = vi.fn(async () => {});
  session.setState({ runId: 'active-run', projection: running(), open });
  const view = await mount({ session });
  expect(view.runFor).toHaveBeenCalledWith('active-run');
  expect(view.retainRun).toHaveBeenCalledWith('active-run');
  expect(open).toHaveBeenCalledWith('active-run');
  expect(view.container.textContent).toContain(messages.Reins.cancelRun);
  // The breadcrumb already names the session: the request is the controls' description and
  // tooltip, not another visible line beside the status.
  const target = [...view.container.querySelectorAll('*')].find(
    (el) => el.children.length === 0 && el.textContent?.includes('Summarize the report'),
  );
  expect(target?.classList.contains('sr-only')).toBe(true);
  expect(view.container.querySelector('[data-testid="active-run-status"]')).not.toBeNull();
  const pill = view.pill();
  expect(pill).not.toBeNull();
  // The pill names the run it acts on and the request, and opens the run record.
  expect(pill?.getAttribute('aria-label')).toContain('Run #1');
  expect(pill?.getAttribute('aria-label')).toContain('Summarize the report');
  await act(async () => pill?.click());
  // Nothing waits: the pill opens the record, not the response area.
  expect(view.onOpen).toHaveBeenCalledWith('active-run', false);
  // Opening is navigation: the pill is a plain button with no disclosure state, chevron or panel.
  expect(pill?.hasAttribute('aria-expanded')).toBe(false);
  expect(pill?.hasAttribute('aria-controls')).toBe(false);
  expect(pill?.querySelector('[data-pill-chevron]')).toBeNull();
  expect(
    view.container.querySelector('[data-testid="dock-open-active-run"] [role="region"]'),
  ).toBeNull();
  await cleanup.splice(0)[0]?.();
  expect(view.release).toHaveBeenCalledOnce();
});

it('shows the run in the kit status pill without steps, progress or inline approval', async () => {
  const projection = running();
  pendingApproval(projection, 'approval_a');
  const session = sessionStore({ runId: 'active-run', projection });
  const view = await mount({ session });
  const root = view.container.querySelector('[data-testid="dock-open-active-run"]');
  expect(root?.getAttribute('data-state')).toBe('waiting');
  expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
  const names = [...view.container.querySelectorAll('button')].map(
    (button) => button.getAttribute('aria-label') ?? button.textContent ?? '',
  );
  expect(names.some((name) => /^(Approve|Deny)\b/.test(name))).toBe(false);
  // The composer owns the live region; the pill adds none of its own.
  expect(root?.querySelector('[aria-live]')).toBeNull();
});

it('a waiting run shows its state like any other, with the count from two, and opens the response area', async () => {
  const projection = running();
  pendingApproval(projection, 'approval_a');
  const session = sessionStore({ runId: 'active-run', projection });
  const view = await mount({ session });
  // The run row says the state in words; the pill shows its mark and names it to assistive tech.
  expect(view.pill()?.textContent).not.toContain(messages.Status.awaiting_user);
  expect(view.pill()?.getAttribute('aria-label')).toContain(messages.Status.awaiting_user);
  expect(view.pill()?.textContent).toContain('Run #1');
  expect(view.pill()?.getAttribute('aria-label')).not.toContain('(1)');
  // The notice above the composer is the one Respond.
  expect(view.pill()?.textContent).not.toContain('Respond');
  await act(async () => view.pill()?.click());
  // A request to respond: the run view opens its response area, whatever its width.
  expect(view.onOpen).toHaveBeenCalledWith('active-run', true);

  const two = running();
  pendingApproval(two, 'approval_a');
  pendingApproval(two, 'approval_b');
  await act(async () => session.setState({ projection: two }));
  expect(view.pill()?.getAttribute('aria-label')).toContain(`${messages.Status.awaiting_user} (2)`);
  expect(view.pill()?.textContent).not.toContain(messages.Status.awaiting_user);
  expect(view.pill()?.textContent).not.toContain('Respond');
});

it('names the active run by its number while another run is on screen', async () => {
  const session = sessionStore({ runId: 'active-run', projection: running() });
  const view = await mount({
    session,
    viewingOther: true,
    runs: [summary('earlier-run', 'cancelled'), summary('active-run', 'running')],
  });
  const root = view.container.querySelector('[data-testid="dock-open-active-run"]');
  expect(root?.textContent).toContain('Run #2');
  expect(root?.textContent).not.toContain('Run #1');
  const note = view.container.querySelector('[role="note"]');
  expect(note?.textContent).toBe(messages.Docking.activeRunNotViewed);
  expect(note?.classList.contains('sr-only')).toBe(true);
});

it('cancel from the session bar still goes through the existing confirmation', async () => {
  const sendCommand = vi.fn(async () => ({}) as never);
  const session = sessionStore({ runId: 'active-run', projection: running(), sendCommand });
  const view = await mount({ session });
  const cancel = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === messages.Reins.cancelRun,
  );
  expect(cancel).toBeDefined();
  await act(async () => cancel?.click());
  expect(sendCommand).not.toHaveBeenCalled();
  const confirm = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === messages.Reins.confirmCancelRun,
  );
  expect(confirm).toBeDefined();
  await act(async () => confirm?.click());
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel' }));
});

const button = (container: Element, name: string) =>
  [...container.querySelectorAll('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent) === name,
  );

it('a narrower bar turns Pause and Cancel into icons that keep their names and the confirmation', async () => {
  fixture.tier = 1;
  const sendCommand = vi.fn(async () => ({}) as never);
  const session = sessionStore({ runId: 'active-run', projection: running(), sendCommand });
  const view = await mount({ session });
  for (const name of [messages.Reins.pause, messages.Reins.cancelRun]) {
    const control = button(view.container, name);
    expect(control?.querySelector('svg')).not.toBeNull();
    // The words leave the layout, not the name.
    expect(control?.querySelector('[data-run-action-label]')?.classList.contains('sr-only')).toBe(
      true,
    );
  }
  // The pill is untouched by this first step: its state in its name, its number and clock shown.
  expect(view.pill()?.getAttribute('aria-label')).toContain('Running');
  expect(view.pill()?.textContent).not.toContain('Running');
  expect(view.pill()?.textContent).toContain('Run #1');
  expect(view.pill()?.textContent).toMatch(/\d:\d\d/);
  await act(async () => button(view.container, messages.Reins.cancelRun)?.click());
  expect(sendCommand).not.toHaveBeenCalled();
  const confirm = [...document.querySelectorAll('button')].find(
    (item) => item.textContent === messages.Reins.confirmCancelRun,
  );
  expect(confirm).toBeDefined();
  await act(async () => confirm?.click());
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel' }));
});

it('the pill then drops its clock, then its words, keeping the state and the run number', async () => {
  const session = sessionStore({ runId: 'active-run', projection: running() });
  fixture.tier = 2;
  const noClock = await mount({ session });
  expect(noClock.pill()?.getAttribute('aria-label')).toContain('Running');
  expect(noClock.pill()?.textContent).toContain('Run #1');
  expect(noClock.pill()?.textContent).not.toMatch(/\d:\d\d/);
  await cleanup.splice(0)[0]?.();

  fixture.tier = 3;
  const short = await mount({ session });
  expect(short.pill()?.textContent).toBe('Run #1');
  const root = short.container.querySelector('[data-testid="dock-open-active-run"]');
  expect(root?.getAttribute('data-state')).toBe('running');
  // What left the pill stays in its name.
  expect(short.pill()?.getAttribute('aria-label')).toContain('Running');
  expect(short.pill()?.getAttribute('aria-label')).toContain('Summarize the report');
  await act(async () => short.pill()?.click());
  expect(short.onOpen).toHaveBeenCalledWith('active-run', false);
  await cleanup.splice(0)[0]?.();

  fixture.tier = 7;
  const number = await mount({ session });
  expect(number.pill()?.textContent).toBe('#1');
  expect(number.pill()?.getAttribute('aria-label')).toContain('Run #1');
});

it('a waiting run narrows like any other state and still opens the response area', async () => {
  const projection = running();
  pendingApproval(projection, 'approval_a');
  pendingApproval(projection, 'approval_b');
  const session = sessionStore({ runId: 'active-run', projection });
  for (const [tier, shown] of [
    [3, 'Run #1'],
    [5, 'Run #1'],
    [7, '#1'],
  ] as const) {
    fixture.tier = tier;
    const view = await mount({ session });
    expect(view.pill()?.textContent).toBe(shown);
    const root = view.container.querySelector('[data-testid="dock-open-active-run"]');
    expect(root?.getAttribute('data-state')).toBe('waiting');
    // What left the pill stays in its name.
    expect(view.pill()?.getAttribute('aria-label')).toContain(
      `${messages.Status.awaiting_user} (2)`,
    );
    expect(view.pill()?.getAttribute('aria-label')).toContain('Run #1');
    await act(async () => view.pill()?.click());
    expect(view.onOpen).toHaveBeenCalledWith('active-run', true);
    await cleanup.splice(0)[0]?.();
  }
});
