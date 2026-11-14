// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WORKSPACE_CHANGED, WorkingCopyPanel } from './FilesViews.tsx';

const fixture = vi.hoisted(() => ({ copy: null as unknown }));
vi.mock('../services.tsx', () => {
  const workspaces = {
    binding: async () => ({ trusted: true, status: { head: 'main', changed: 0 } }),
    worktree: async () => fixture.copy,
  };
  return { useServices: () => ({ workspaces }) };
});
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../workbench/DevelopmentMode.tsx', () => ({ DevelopmentMode: () => null }));
vi.mock('../workbench/CheckpointPanel.tsx', () => ({ CheckpointPanel: () => null }));
vi.mock('../workbench/CopyRemovalDialog.tsx', () => ({ CopyRemovalDialog: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { sessionId: string };
    children?: ReactNode;
  }) => (
    <a {...props} href={to.replace('$sessionId', params?.sessionId ?? '')}>
      {children}
    </a>
  ),
}));

it('without a copy, the panel is the shared empty view with the one next step inside it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.copy = null;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WorkingCopyPanel sessionId="session" projectId="project" />
        </IntlProvider>,
      ),
    );
    const region = container.querySelector('section');
    expect(region?.getAttribute('aria-label')).toBe(messages.Files.copyHeading);
    const empty = region?.querySelector('[data-slot="empty-view"]');
    expect(empty?.textContent).toContain(messages.Files.noCopyTitle);
    // The step sits inside the dashed empty state, not after it.
    const frame = empty?.querySelector('[data-slot="empty-state"]');
    expect(frame?.className).toContain('border-dashed');
    const make = frame?.lastElementChild;
    expect(make?.tagName).toBe('BUTTON');
    expect(make?.textContent).toBe('Make a working copy from main');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('an open copy card follows creation and removal from another entry point', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.copy = null;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WorkingCopyPanel sessionId="session" projectId="project" />
        </IntlProvider>,
      ),
    );
    expect(container.querySelector('a[href="/sessions/session/review"]')).toBeNull();
    fixture.copy = { baseCommit: 'a'.repeat(40), missing: false };
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.querySelector('a[href="/sessions/session/review"]')).not.toBeNull();
    fixture.copy = null;
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.querySelector('a[href="/sessions/session/review"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

// glossary.md, "설명이 붙는 용어": the Paddock's title explains the term by one icon right after
// it; without a Paddock, the empty state's title is the place.
const terms = messages.Terms as Record<string, string | { name: string; meaning: string }>;
const about = messages.Terms.about.replace('{term}', 'Paddock');
const described = (hint: Element) =>
  document.getElementById(hint.getAttribute('aria-describedby') ?? '')?.textContent;

it.each([
  ['without a Paddock', null, () => messages.Files.noCopyTitle, '[data-slot="empty-state"] *'],
  [
    'with a Paddock',
    { baseCommit: 'a'.repeat(40), missing: false },
    () => messages.Files.copyHeading,
    'h3#copy-heading',
  ],
])('%s, explains the term once, right after its title', async (_state, copy, title, selector) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.copy = copy;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WorkingCopyPanel sessionId="session" projectId="project" />
        </IntlProvider>,
      ),
    );
    const hints = [...container.querySelectorAll('[data-term-hint]')];
    expect(hints).toHaveLength(1);
    const hint = hints[0] as HTMLElement;
    expect(hint.dataset.termHint).toBe('paddock');
    expect(hint.getAttribute('aria-label')).toBe(about);
    expect(described(hint)).toBe((terms.paddock as { meaning: string } | undefined)?.meaning);
    const heading = [...container.querySelectorAll(selector)].find(
      (element) => element.textContent === title(),
    );
    // A sibling right after the title, so the title still reads as itself.
    expect(heading).toBeDefined();
    expect(heading?.contains(hint)).toBe(false);
    expect(heading?.nextElementSibling).toBe(hint);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
