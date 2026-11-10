// @vitest-environment jsdom
import type { ProjectSummary, WorkSession } from '@corral/core';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TopbarPath } from './TopbarPath.tsx';
import { TOPBAR_TIERS, topbarLayout } from './topbarTier.ts';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
// The bar's tier is measured in the browser; here a test names the tier it is at.
const fixture = vi.hoisted(() => ({ tier: 0 }));
vi.mock('./TopbarSlot.tsx', async (original) => ({
  ...(await original<typeof import('./TopbarSlot.tsx')>()),
  useTopbarLayout: () => topbarLayout(fixture.tier),
}));

const createdAt = '2026-11-01T00:00:00.000Z';
const alpha: ProjectSummary = {
  projectId: 'alpha',
  name: 'Alpha',
  description: '',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
};

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  fixture.tier = 0;
});

async function render(props: Partial<ComponentProps<typeof TopbarPath>>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
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
        <TopbarPath
          pathname="/"
          projects={[alpha]}
          sessions={[]}
          runs={[]}
          pageTitle=""
          onOpenSession={() => {}}
          crumbs={() => {}}
          {...props}
        />
      </IntlProvider>,
    ),
  );
  return container;
}

it.each([
  ['/inbox', 'Needs you'],
  ['/library/teams', 'Library'],
  ['/schedules', 'Automation'],
  ['/preview/task-board', 'Feature previews'],
  ['/projects', 'All projects'],
])(
  'starts the path on %s with the page name instead of the project placeholder',
  async (pathname, name) => {
    const container = await render({ pathname });
    const nav = container.querySelector('nav');
    expect(nav?.textContent?.trim()).toBe(name);
    expect(nav?.textContent).not.toContain('All projects…');
    expect(nav?.querySelector('button[aria-label="Go to project"]')).toBeNull();
  },
);

it('keeps the project menu at the start of a project’s path', async () => {
  const container = await render({ pathname: '/projects/alpha', projectId: 'alpha' });
  const switcher = container.querySelector('nav button[aria-label="Go to project"]');
  expect(switcher?.textContent).toContain('Alpha');
});

const session = {
  sessionId: 'current',
  projectId: 'alpha',
  title: 'Fix the login redirect',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  entries: [],
} as unknown as WorkSession;

it.each(TOPBAR_TIERS.map((tier, index) => [tier, index] as const))(
  'keeps the open session’s name in the path at the %s tier',
  async (_tier, index) => {
    fixture.tier = index;
    const container = await render({
      pathname: '/sessions/current',
      projectId: 'alpha',
      sessionId: 'current',
      sessions: [session],
      pageTitle: session.title,
    });
    const name = container.querySelector('nav [data-crumb="current"]');
    expect(name?.tagName).toBe('H2');
    expect(name?.querySelector('[data-crumb-label]')?.textContent).toBe('Fix the login redirect');
    // The project stays reachable: by name while there is room, then as its icon.
    const project = container.querySelector('nav button[aria-label="Go to project"]');
    expect(project?.getAttribute('data-crumb')).toBe('project');
    if (topbarLayout(index).project === 'name') expect(project?.textContent).toContain('Alpha');
    else {
      expect(project?.textContent).toBe('');
      expect(project?.querySelector('svg')).not.toBeNull();
    }
  },
);

it('keeps a page’s own name at the narrowest tier', async () => {
  fixture.tier = TOPBAR_TIERS.length - 1;
  const container = await render({ pathname: '/inbox' });
  const name = container.querySelector('nav [data-crumb="current"]');
  expect(name?.textContent).toBe('Needs you');
  expect(name?.getAttribute('aria-current')).toBe('page');
});
