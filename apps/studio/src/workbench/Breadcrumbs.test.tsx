// @vitest-environment jsdom
import type { RunSummary, WorkSession } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { setCommands } from '../commandRegistry.ts';
import { SessionMenu } from './Breadcrumbs.tsx';

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
  // The latest run decides a session's status, as in the sidebar: a mark and its name, no
  // words, since the open conversation says the state in words.
  expect(items[2]?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
    messages.Presence.state.succeeded,
  );
  expect(visibleText(items[2] as HTMLElement)).not.toContain(messages.Presence.state.succeeded);
  expect(items[0]?.querySelector('[role="img"]')).toBeNull();
  for (const item of items) expect(item.querySelector('[data-presence-label]')).toBeNull();
  // The item's accessible name carries the state, which the mark alone does not give it.
  expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
    'Session pinned',
    'Session current',
    `Session old, ${messages.Presence.state.succeeded}`,
  ]);
  // Hovering the mark names it too.
  expect(items[2]?.querySelector('[role="img"]')?.getAttribute('title')).toBe(
    messages.Presence.state.succeeded,
  );
  await act(async () => items[0]?.click());
  expect(onOpen).toHaveBeenCalledWith('pinned');
});

it('only chooses a session: the page’s session actions are not in the title menu', async () => {
  const run = vi.fn();
  // The session page registers these with its revision checks (session/SessionActions.tsx);
  // they live in the top bar's more menu, not in the path's menu.
  setCommands('session', [
    { id: 'session:rename', title: 'Rename conversation', group: 'Session', run },
    { id: 'session:criteria', title: 'Completion criteria', group: 'Session', run },
    { id: 'session:pin', title: 'Pin conversation', group: 'Session', run },
    { id: 'session:archive', title: 'Archive conversation', group: 'Session', run },
    { id: 'session:review', title: 'Open the review screen', group: 'Session', run },
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
      expect.stringMatching(/^menuitemradio:Session current/),
      expect.stringMatching(/^menuitemradio:Session old/),
    ]);
    expect(document.querySelector('[role="menu"] [role="separator"]')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  } finally {
    setCommands('session', null);
  }
});
