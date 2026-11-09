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

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
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
  expect(view.onOpen).toHaveBeenCalledWith('active-run');
  // Opening is navigation: the kit's fold-out step panel never opens.
  expect(pill?.getAttribute('aria-expanded')).toBe('false');
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

it('a waiting run turns the pill into Check now, with the count from two, and opens the response area', async () => {
  const projection = running();
  pendingApproval(projection, 'approval_a');
  const session = sessionStore({ runId: 'active-run', projection });
  const view = await mount({ session });
  expect(view.pill()?.textContent).toContain('Check now');
  expect(view.pill()?.textContent).not.toContain('(1)');
  await act(async () => view.pill()?.click());
  expect(view.onOpen).toHaveBeenCalledWith('active-run');

  const two = running();
  pendingApproval(two, 'approval_a');
  pendingApproval(two, 'approval_b');
  await act(async () => session.setState({ projection: two }));
  expect(view.pill()?.textContent).toContain('Check now (2)');
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
