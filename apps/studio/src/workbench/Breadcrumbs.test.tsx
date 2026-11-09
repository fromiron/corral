// @vitest-environment jsdom
import type { RunSummary, WorkSession } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { setCommands } from '../commandRegistry.ts';
import { RunMenu, SessionMenu } from './Breadcrumbs.tsx';

Element.prototype.getAnimations ??= () => [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </IntlProvider>,
    ),
  );
  return container;
}

const session = (id: string, updatedAt: string, extra: Partial<WorkSession> = {}) =>
  ({
    sessionId: id,
    projectId: 'alpha',
    title: `Session ${id}`,
    objective: '',
    pinned: false,
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    entries: [],
    ...extra,
  }) as unknown as WorkSession;
const run = (runId: string, sessionId: string, status: string, startedAt: string) =>
  ({ runId, sessionId, status, startedAt }) as unknown as RunSummary;

/** Text a person reads: the kit draws each label twice, once hidden to reserve its bold width. */
function visibleText(element: Element) {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent?.trim();
}

async function open(trigger: HTMLElement | null | undefined) {
  expect(trigger).toBeTruthy();
  await act(async () => trigger?.click());
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
}

it('names the current session as the page title and switches within the project in sidebar order', async () => {
  const onOpen = vi.fn();
  const container = await render(
    <SessionMenu
      sessions={[
        session('old', '2026-11-01T00:00:00Z'),
        session('current', '2026-11-03T00:00:00Z'),
        session('pinned', '2026-10-01T00:00:00Z', { pinned: true }),
        session('elsewhere', '2026-11-05T00:00:00Z', { projectId: 'beta' }),
      ]}
      runs={[
        run('run_a', 'old', 'failed', '2026-11-01T00:00:00Z'),
        run('run_b', 'old', 'succeeded', '2026-11-02T00:00:00Z'),
      ]}
      projectId="alpha"
      sessionId="current"
      title="Session current"
      onOpen={onOpen}
    />,
  );
  const heading = container.querySelector('h2');
  expect(heading?.textContent).toContain('Session current');
  const trigger = heading?.querySelector('button');
  expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
  const items = await open(trigger);
  expect(items).toHaveLength(3);
  ['Session pinned', 'Session current', 'Session old'].forEach((title, index) => {
    expect(items[index]?.textContent).toContain(title);
  });
  expect(items[1]?.getAttribute('aria-checked')).toBe('true');
  // The latest run decides a session's status, as in the sidebar.
  expect(items[2]?.textContent).toContain('Succeeded');
  await act(async () => items[0]?.click());
  expect(onOpen).toHaveBeenCalledWith('pinned');
});

it('lists the session runs newest first by number and status and selects one', async () => {
  const onSelect = vi.fn();
  const container = await render(
    <RunMenu
      runs={[
        run('first', 'current', 'failed', '2026-11-01T00:00:00Z'),
        run('second', 'current', 'succeeded', '2026-11-02T00:00:00Z'),
      ]}
      runId="first"
      onSelect={onSelect}
    />,
  );
  const trigger = container.querySelector('button');
  expect(trigger?.textContent).toContain('Run #1');
  const items = await open(trigger);
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining('Run #2'),
    expect.stringContaining('Run #1'),
  ]);
  expect(items[0]?.textContent).toContain('Succeeded');
  expect(items[1]?.getAttribute('aria-checked')).toBe('true');
  await act(async () => items[0]?.click());
  expect(onSelect).toHaveBeenCalledWith('second');
});

it('names each run by its session number and request summary', async () => {
  const container = await render(
    <RunMenu
      runs={[
        run('first', 'current', 'failed', '2026-11-01T00:00:00Z'),
        run('second', 'current', 'succeeded', '2026-11-02T00:00:00Z'),
      ]}
      runId="second"
      names={{ first: 'Draft the notes', second: 'Research brief' }}
      onSelect={vi.fn()}
    />,
  );
  const trigger = container.querySelector('button');
  expect(trigger?.textContent).toContain('#2 · Research brief');
  expect(trigger?.textContent).not.toContain('Run #');
  const items = await open(trigger);
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining('#2 · Research brief'),
    expect.stringContaining('#1 · Draft the notes'),
  ]);
});

it('puts this session’s rename, pin and archive above the session list and runs the page’s own actions', async () => {
  const rename = vi.fn();
  const pin = vi.fn();
  const archive = vi.fn();
  // The session page registers these with its revision checks (session/SessionActions.tsx).
  setCommands('session', [
    { id: 'session:rename', title: 'Rename session', group: 'Session', run: rename },
    { id: 'session:pin', title: 'Pin session', group: 'Session', run: pin },
    { id: 'session:archive', title: 'Archive session', group: 'Session', run: archive },
    { id: 'session:review', title: 'Open the review screen', group: 'Session', run: vi.fn() },
  ]);
  try {
    const container = await render(
      <SessionMenu
        sessions={[
          session('current', '2026-11-03T00:00:00Z'),
          session('old', '2026-11-01T00:00:00Z'),
        ]}
        runs={[]}
        projectId="alpha"
        sessionId="current"
        title="Session current"
        onOpen={vi.fn()}
      />,
    );
    await act(async () => container.querySelector<HTMLElement>('h2 button')?.click());
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
    ];
    expect(rows.map((row) => `${row.getAttribute('role')}:${visibleText(row)}`)).toEqual([
      'menuitem:Rename session',
      'menuitem:Pin session',
      'menuitem:Archive session',
      expect.stringMatching(/^menuitemradio:Session current/),
      expect.stringMatching(/^menuitemradio:Session old/),
    ]);
    await act(async () => rows[1]?.click());
    expect(pin).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  } finally {
    setCommands('session', null);
  }
});

it('shows only the actions the open page offers, as for a meeting', async () => {
  setCommands('session', [
    { id: 'session:archive', title: 'Archive session', group: 'Session', run: vi.fn() },
  ]);
  try {
    const container = await render(
      <SessionMenu
        sessions={[session('current', '2026-11-03T00:00:00Z')]}
        runs={[]}
        projectId="alpha"
        sessionId="current"
        title="Session current"
        onOpen={vi.fn()}
      />,
    );
    await act(async () => container.querySelector<HTMLElement>('h2 button')?.click());
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(visibleText),
    ).toEqual(['Archive session']);
  } finally {
    setCommands('session', null);
  }
});
