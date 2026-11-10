// @vitest-environment jsdom
import type { InboxItemView } from '@corral/client';
import type { Receipt } from '@corral/contracts';
import {
  emptyProjection,
  type ProjectSummary,
  type RunProjection,
  type RunSummary,
  type RuntimeTransport,
} from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { inboxEntries } from '../workbench/inbox.ts';
import { notificationDestination } from '../workbench/notifications.ts';
import { InboxPage, validateInboxSearch } from './InboxPage.tsx';

// docs/specs/features/inbox.md: the global Needs you list and its one selected detail.

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  navigate: (() => {}) as (...args: unknown[]) => void,
  search: {} as Record<string, unknown>,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', async (original) => {
  const hrefOf = (
    to: string,
    params: Record<string, string> = {},
    search: Record<string, string | undefined> = {},
  ) => {
    const path = Object.entries(params).reduce(
      (current, [key, value]) => current.replace(`$${key}`, encodeURIComponent(value)),
      to,
    );
    const query = Object.entries(search)
      .flatMap(([key, value]) =>
        value === undefined ? [] : [`${key}=${encodeURIComponent(value)}`],
      )
      .join('&');
    return query ? `${path}?${query}` : path;
  };
  return {
    ...(await original<typeof import('@tanstack/react-router')>()),
    Link: ({
      to,
      params,
      search,
      children,
      ...rest
    }: {
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
      children?: React.ReactNode;
    }) => (
      <a href={hrefOf(to, params, search)} {...rest}>
        {children}
      </a>
    ),
    useNavigate: () => fixture.navigate,
    useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
      select({ location: { href: '/inbox', search: fixture.search } }),
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const project = (projectId: string, name: string): ProjectSummary => ({
  projectId,
  name,
  description: '',
  revision: 1,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  archivedAt: null,
});
const ALPHA = project('alpha', 'Alpha');
const BETA = project('beta', 'Beta');

const item = (
  kind: InboxItemView['kind'],
  sessionId: string,
  sessionTitle: string,
  extra: Partial<InboxItemView> = {},
): InboxItemView => ({ kind, sessionId, sessionTitle, runId: null, detail: null, ...extra });
const decisionA = item('decision', 's_a', 'Fix login', { runId: 'run_a' });
const decisionB = item('decision', 's_b', 'Ship it', { runId: 'run_b' });
const queuedC = item('queued', 's_c', 'Write docs', { detail: 'Private request body' });
const checkD = item('check_failed', 's_d', 'Tidy tests', { detail: 'Types' });

const runSummary = (runId: string, sessionId: string, startedAt: string): RunSummary => ({
  runId,
  sessionId,
  projectId: 'alpha',
  corralId: 'team',
  status: 'awaiting_user',
  startedAt,
});

const waiting = (runId: string): RunProjection => ({
  ...emptyProjection(runId),
  status: 'awaiting_user',
  approvals: {
    [`approval_${runId}`]: {
      approvalId: `approval_${runId}`,
      kind: 'user_action',
      subjectVersionIds: ['artv_subject'],
      criteriaVersionId: null,
      status: 'pending',
    },
  },
});
const answered = (runId: string): RunProjection => {
  const projection = waiting(runId);
  const approval = projection.approvals[`approval_${runId}`];
  return {
    ...projection,
    status: 'running',
    approvals: approval ? { [approval.approvalId]: { ...approval, status: 'approved' } } : {},
  };
};
const applied = (runId: string): Receipt => ({
  commandId: `cmd_${runId}`,
  runId,
  status: 'applied',
  acceptedSeq: 2,
  target: `approval:approval_${runId}`,
  requestedBoundary: 'immediate',
  relatedEventIds: [],
});

interface RunFixture {
  store: RunSessionStore;
  sent: Deferred<Receipt>[];
  sendCommand: ReturnType<typeof vi.fn>;
}
function runFixture(runId: string): RunFixture {
  const sent: Deferred<Receipt>[] = [];
  const sendCommand = vi.fn(() => {
    const reply = deferred<Receipt>();
    sent.push(reply);
    return reply.promise;
  });
  const transport = { sendCommand, getReceipt: vi.fn(async () => null) };
  const store = createRunSession(transport as unknown as RuntimeTransport, () => `cmd_${runId}`);
  store.setState({ runId, projection: waiting(runId), open: async () => {} });
  return { store, sent, sendCommand };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fixture.search = {};
  fixture.navigate = () => {};
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

async function mount({
  projects = [ALPHA],
  inbox,
  runs = [],
}: {
  projects?: ProjectSummary[];
  inbox: (projectId: string) => Promise<InboxItemView[]>;
  runs?: RunSummary[];
}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const stores = new Map<string, RunFixture>();
  const releases: string[] = [];
  const services = {
    repository: { listProjects: vi.fn(async () => projects) },
    transport: { listRuns: vi.fn(async () => runs) },
    workspaces: { inbox: vi.fn(inbox) },
    runFor: vi.fn((runId: string) => {
      let run = stores.get(runId);
      if (!run) {
        run = runFixture(runId);
        stores.set(runId, run);
      }
      return run.store;
    }),
    retainRun: vi.fn((runId: string) => () => {
      releases.push(runId);
    }),
  };
  fixture.services = services;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <InboxPage />
      </IntlProvider>,
    ),
  );
  await flush();
  const rowButton = (title: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="listitem"] button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith(title),
    );
  const detail = () => container.querySelector<HTMLElement>('[data-testid="inbox-detail"]');
  const click = async (element: HTMLElement | null | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => element?.click());
    await flush();
  };
  const buttonIn = (scope: HTMLElement | null, text: string) =>
    [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent === text || button.getAttribute('aria-label') === text,
    );
  const refocus = async () => {
    await act(async () => window.dispatchEvent(new Event('focus')));
    await flush();
  };
  return { container, services, stores, releases, rowButton, detail, click, buttonIn, refocus };
}

it('keeps only an in-app return address', () => {
  expect(validateInboxSearch({ returnTo: '/sessions/session_a?panel=run#result' })).toEqual({
    returnTo: '/sessions/session_a?panel=run#result',
  });
  for (const returnTo of [
    'https://example.org',
    '//example.org',
    '/\\example.org',
    '/settings?section=general',
    'sessions/session_a',
    ['/inbox'],
  ])
    expect(validateInboxSearch({ returnTo })).toEqual({});
});

it('names the screen from its own messages and offers the way back it was given', async () => {
  fixture.search = { returnTo: '/sessions/s_a?panel=files' };
  const navigate = vi.fn();
  fixture.navigate = navigate;
  const { container, click, buttonIn } = await mount({ inbox: async () => [] });
  expect(container.querySelector('h1')?.textContent).toBe('Needs you');
  await click(buttonIn(container, 'Back'));
  expect(navigate).toHaveBeenCalledWith({ href: '/sessions/s_a?panel=files' });
});

it('shows each group as a titled list of project, session and run number, never a request body', async () => {
  const { container, services } = await mount({
    projects: [ALPHA, BETA],
    runs: [
      runSummary('run_old', 's_a', '2026-11-10T00:00:00Z'),
      runSummary('run_a', 's_a', '2026-11-10T01:00:00Z'),
    ],
    inbox: async (projectId) => (projectId === 'alpha' ? [decisionA] : [queuedC]),
  });
  const lists = [...container.querySelectorAll<HTMLElement>('[role="list"]')];
  const name = (list: HTMLElement) =>
    document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent;
  expect(lists.map(name)).toEqual(['Response needed', 'Waiting & stopped']);
  expect(lists[0]?.textContent).toContain('Fix login');
  expect(lists[0]?.textContent).toContain('Response needed · Run #2');
  expect(lists[0]?.textContent).toContain('Alpha');
  expect(lists[1]?.textContent).toContain('Write docs');
  expect(lists[1]?.textContent).toContain('Beta');
  expect(container.textContent).not.toContain('Private request body');
  // Rows open no run stores or subscriptions.
  expect(services.runFor).not.toHaveBeenCalled();
  expect(services.retainRun).not.toHaveBeenCalled();
});

it('opens one run store for the selected decision only and releases it when the selection moves', async () => {
  const { services, releases, rowButton, click } = await mount({
    inbox: async () => [decisionA, decisionB, queuedC],
  });
  await click(rowButton('Fix login'));
  expect(new Set(services.runFor.mock.calls.map(([runId]) => runId))).toEqual(new Set(['run_a']));
  expect(services.retainRun.mock.calls).toEqual([['run_a']]);
  await click(rowButton('Ship it'));
  expect(releases).toEqual(['run_a']);
  expect(services.retainRun.mock.calls).toEqual([['run_a'], ['run_b']]);
  await click(rowButton('Write docs'));
  expect(releases).toEqual(['run_a', 'run_b']);
  expect(services.retainRun).toHaveBeenCalledTimes(2);
});

it('keeps an answered decision until its success receipt, then focuses the next item', async () => {
  let listed = [decisionA, decisionB];
  const { container, stores, rowButton, detail, click, buttonIn } = await mount({
    inbox: async () => listed,
  });
  await click(rowButton('Fix login'));
  const approve = buttonIn(detail(), 'Continue with this version');
  await click(approve);
  const run = stores.get('run_a');
  expect(run?.sent).toHaveLength(1);
  expect(rowButton('Fix login')).toBeDefined();
  expect(approve?.disabled).toBe(true);
  // The run moving on is not the receipt: the item still waits for it.
  await act(async () => run?.store.setState({ projection: answered('run_a') }));
  await flush();
  expect(rowButton('Fix login')).toBeDefined();
  listed = [decisionB];
  await act(async () => run?.sent[0]?.resolve(applied('run_a')));
  await flush();
  expect(rowButton('Fix login')).toBeUndefined();
  expect(document.activeElement).toBe(rowButton('Ship it'));
  expect(detail()?.textContent).toContain('This item was handled.');

  // With nothing after it, focus goes to the list's heading.
  await click(rowButton('Ship it'));
  await click(buttonIn(detail(), 'Continue with this version'));
  const next = stores.get('run_b');
  listed = [];
  await act(async () => {
    next?.store.setState({ projection: answered('run_b') });
    next?.sent[0]?.resolve(applied('run_b'));
  });
  await flush();
  expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  expect(document.activeElement?.tagName).toBe('H1');
  expect(document.activeElement?.textContent).toBe('Needs you');
});

it('treats Escape, close and choosing another item as neither a denial nor a cancel', async () => {
  const { stores, rowButton, detail, click, buttonIn } = await mount({
    inbox: async () => [decisionA, decisionB],
  });
  await click(rowButton('Fix login'));
  const panel = detail();
  expect(panel).not.toBeNull();
  await act(async () =>
    panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await flush();
  expect(detail()).toBeNull();
  expect(document.activeElement).toBe(rowButton('Fix login'));
  await click(rowButton('Fix login'));
  await click(buttonIn(detail(), 'Close'));
  expect(detail()).toBeNull();
  // The narrow layout's way back to the list is the same close.
  await click(rowButton('Fix login'));
  await click(buttonIn(detail(), 'Back to list'));
  expect(detail()).toBeNull();
  expect(document.activeElement).toBe(rowButton('Fix login'));
  await click(rowButton('Fix login'));
  await click(rowButton('Ship it'));
  expect(stores.get('run_a')?.sendCommand).not.toHaveBeenCalled();
  expect(stores.get('run_b')?.sendCommand).not.toHaveBeenCalled();
  expect(rowButton('Fix login')).toBeDefined();
});

it('heads a decision’s response area with its session, run number and a link to that run', async () => {
  const { rowButton, detail, click } = await mount({
    runs: [
      runSummary('run_old', 's_a', '2026-11-10T00:00:00Z'),
      runSummary('run_a', 's_a', '2026-11-10T01:00:00Z'),
    ],
    inbox: async () => [decisionA],
  });
  await click(rowButton('Fix login'));
  const header = detail()?.querySelector('header');
  expect(header?.querySelector('h2')?.textContent).toBe('Fix login');
  // The row already said a response is needed; the heading names the run it is for.
  expect(header?.querySelector('p')?.textContent).toBe('Run #2 · Alpha');
  const links = [...(detail()?.querySelectorAll('a') ?? [])];
  expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Open run', '/sessions/s_a?panel=run&view=run&run=run_a&respond=true'],
  ]);
  expect(header?.contains(links[0] ?? null)).toBe(true);
  const area = detail()?.querySelector('[data-testid="run-needs-you"]');
  expect(area).toBeTruthy();
  expect(
    header && area && header.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it('keeps a quiet placeholder where the detail opens, and none once everything is clear', async () => {
  const placeholder = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="inbox-no-selection"]');
  const listed = await mount({ inbox: async () => [queuedC] });
  expect(placeholder(listed.container)?.textContent).toContain('Nothing selected');
  expect(listed.detail()).toBeNull();
  await listed.click(listed.rowButton('Write docs'));
  expect(placeholder(listed.container)).toBeNull();
  expect(listed.detail()).not.toBeNull();

  const clear = await mount({ inbox: async () => [] });
  expect(clear.container.textContent).toContain('Nothing needs you');
  expect(placeholder(clear.container)).toBeNull();
});

it('never brings back a handled item from a reply that was already on its way', async () => {
  const replies: Deferred<InboxItemView[]>[] = [];
  const { stores, rowButton, detail, click, buttonIn, refocus } = await mount({
    inbox: () => {
      const reply = deferred<InboxItemView[]>();
      replies.push(reply);
      return reply.promise;
    },
  });
  await act(async () => replies[0]?.resolve([decisionA, decisionB]));
  await flush();
  await click(rowButton('Fix login'));
  // A refresh leaves before the answer and returns after it.
  await refocus();
  expect(replies).toHaveLength(2);
  await click(buttonIn(detail(), 'Continue with this version'));
  const run = stores.get('run_a');
  await act(async () => {
    run?.store.setState({ projection: answered('run_a') });
    run?.sent[0]?.resolve(applied('run_a'));
  });
  await flush();
  expect(rowButton('Fix login')).toBeUndefined();
  expect(replies).toHaveLength(3);
  await act(async () => replies[1]?.resolve([decisionA, decisionB]));
  await flush();
  expect(rowButton('Fix login')).toBeUndefined();
  expect(rowButton('Ship it')).toBeDefined();
  await act(async () => replies[2]?.resolve([decisionB]));
  await flush();
  expect(rowButton('Fix login')).toBeUndefined();
  expect(rowButton('Ship it')).toBeDefined();
});

it('shows a failed project’s retry in its own place and keeps the other projects’ items', async () => {
  let alphaFails = true;
  const { container, services, rowButton, click, buttonIn } = await mount({
    projects: [ALPHA, BETA],
    inbox: async (projectId) => {
      if (projectId === 'beta') return [queuedC];
      if (alphaFails) throw new Error('offline');
      return [decisionA];
    },
  });
  expect(rowButton('Write docs')).toBeDefined();
  const alerts = [...container.querySelectorAll<HTMLElement>('[role="alert"]')];
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toContain('Alpha');
  expect(alerts[0]?.textContent).not.toContain('Beta');
  const betaReads = () =>
    services.workspaces.inbox.mock.calls.filter(([projectId]) => projectId === 'beta').length;
  const before = betaReads();
  alphaFails = false;
  await click(buttonIn(alerts[0] ?? null, 'Try again'));
  expect(betaReads()).toBe(before);
  expect(rowButton('Fix login')).toBeDefined();
  expect(rowButton('Write docs')).toBeDefined();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('links a non-decision item to the exact screen a notification opens', async () => {
  const terminal = item('uncertain_terminal', 's_t', 'Shell owner', { terminalId: 'pty_1' });
  const stopped = item('recipe_stopped', 's_r', 'Recipe review', {
    runId: 'run_r',
    detail: 'attempt_limit',
  });
  const { services, rowButton, detail, click } = await mount({
    inbox: async () => [checkD, terminal, stopped],
  });
  const source = {
    getSession: async () => ({ projectId: 'alpha', archivedAt: null }),
    inbox: async () => [checkD, terminal, stopped],
  };
  expect(rowButton('Recipe review')?.getAttribute('aria-label')).toBe(
    'Recipe review · Review stopped: Generation attempt limit reached · Alpha',
  );
  await click(rowButton('Recipe review'));
  expect(detail()?.querySelector('a')?.getAttribute('href')).toBe(
    await notificationDestination(stopped, source),
  );
  expect(detail()?.querySelector('a')?.textContent).toBe('Open run');
  await click(rowButton('Tidy tests'));
  expect(detail()?.querySelector('a')?.getAttribute('href')).toBe(
    await notificationDestination(checkD, source),
  );
  await click(rowButton('Shell owner'));
  expect(detail()?.querySelector('a')?.getAttribute('href')).toBe(
    await notificationDestination(terminal, source),
  );
  expect(detail()?.querySelector('a')?.getAttribute('href')).toBe(
    '/sessions/s_t?panel=terminal&terminal=pty_1',
  );
  expect(services.runFor).not.toHaveBeenCalled();
});

it('says a selected item was handled when a refresh drops it, without choosing another', async () => {
  let listed = [queuedC, checkD];
  const { container, rowButton, detail, click, refocus } = await mount({
    inbox: async () => listed,
  });
  await click(rowButton('Write docs'));
  listed = [checkD];
  await refocus();
  expect(rowButton('Write docs')).toBeUndefined();
  expect(detail()?.textContent).toContain('This item was handled.');
  expect(container.querySelector('[role="listitem"] button[aria-pressed="true"]')).toBeNull();
});

/** The address key of one listed item, as the page writes it. */
const keyOf = (projectId: string, items: InboxItemView[], index = 0) =>
  inboxEntries(projectId, items)[index]?.key ?? '';
/** A navigate that moves the address the page reads on its next render, as the router does. */
const addressNavigate = () =>
  vi.fn((options: { search?: Record<string, unknown> }) => {
    fixture.search = options.search ?? {};
  });

it('keeps the selected item in the address, replacing it as the selection changes', async () => {
  const navigate = addressNavigate();
  fixture.navigate = navigate as (...args: unknown[]) => void;
  fixture.search = { returnTo: '/sessions/s_a?panel=files' };
  const listed = [decisionA, queuedC];
  const { rowButton, detail, click, buttonIn } = await mount({ inbox: async () => listed });
  await click(rowButton('Write docs'));
  expect(navigate).toHaveBeenLastCalledWith({
    to: '/inbox',
    search: { returnTo: '/sessions/s_a?panel=files', item: keyOf('alpha', listed, 1) },
    replace: true,
  });
  await click(rowButton('Fix login'));
  expect(navigate).toHaveBeenLastCalledWith({
    to: '/inbox',
    search: { returnTo: '/sessions/s_a?panel=files', item: keyOf('alpha', listed, 0) },
    replace: true,
  });
  await click(buttonIn(detail(), 'Close'));
  expect(navigate).toHaveBeenLastCalledWith({
    to: '/inbox',
    search: { returnTo: '/sessions/s_a?panel=files' },
    replace: true,
  });
  // The key is a plain string in the address; anything else is dropped.
  const key = keyOf('alpha', listed, 1);
  expect(validateInboxSearch({ item: key })).toEqual({ item: key });
  expect(validateInboxSearch({ item: ['x'] })).toEqual({});
  expect(validateInboxSearch({ item: '' })).toEqual({});
});

it('opens the item the address names, as when coming Back from its target screen', async () => {
  const listed = [decisionA, queuedC];
  fixture.search = { item: keyOf('alpha', listed, 1) };
  const navigate = vi.fn();
  fixture.navigate = navigate;
  const { container, detail } = await mount({ inbox: async () => listed });
  expect(detail()?.querySelector('h2')?.textContent).toBe('Write docs');
  expect(
    container
      .querySelector('[role="listitem"] [aria-pressed="true"]')
      ?.getAttribute('aria-label')
      ?.startsWith('Write docs'),
  ).toBe(true);
  // Opening it from the address writes nothing back.
  expect(navigate).not.toHaveBeenCalled();
});

it('clears an unknown or handled item from the address quietly and says it was handled', async () => {
  const navigate = addressNavigate();
  fixture.navigate = navigate as (...args: unknown[]) => void;
  fixture.search = { item: keyOf('alpha', [item('queued', 's_gone', 'Gone')]) };
  const replies: Deferred<InboxItemView[]>[] = [];
  const { container, detail } = await mount({
    inbox: () => {
      const reply = deferred<InboxItemView[]>();
      replies.push(reply);
      return reply.promise;
    },
  });
  // Nothing is decided before the list is read.
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => replies[0]?.resolve([checkD]));
  await flush();
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/inbox', search: {}, replace: true });
  expect(detail()?.textContent).toContain('This item was handled.');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="listitem"] [aria-pressed="true"]')).toBeNull();
});

it('says the list is loading until the first read settles, and not on later reads', async () => {
  const replies: Deferred<InboxItemView[]>[] = [];
  const { container, refocus } = await mount({
    inbox: () => {
      const reply = deferred<InboxItemView[]>();
      replies.push(reply);
      return reply.promise;
    },
  });
  const loading = () =>
    [...container.querySelectorAll<HTMLElement>('[role="status"]')].find(
      (element) => element.textContent === 'Loading…',
    );
  expect(loading()).toBeDefined();
  expect(container.textContent).not.toContain('Nothing needs you');
  await act(async () => replies[0]?.resolve([]));
  await flush();
  expect(loading()).toBeUndefined();
  expect(container.textContent).toContain('Nothing needs you');
  await refocus();
  expect(replies).toHaveLength(2);
  expect(loading()).toBeUndefined();
});

it('shows the empty state and asks again only when the window regains focus', async () => {
  vi.useFakeTimers();
  const { container, services, refocus } = await mount({ inbox: async () => [] });
  expect(container.textContent).toContain('Nothing needs you');
  const reads = services.workspaces.inbox.mock.calls.length;
  expect(reads).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(services.workspaces.inbox).toHaveBeenCalledTimes(reads);
  await refocus();
  expect(services.workspaces.inbox).toHaveBeenCalledTimes(reads + 1);
});
