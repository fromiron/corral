// @vitest-environment jsdom
import type { ProjectSummary } from '@corral/core';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TopbarPath } from './TopbarPath.tsx';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

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
});

async function render(props: Partial<ComponentProps<typeof TopbarPath>>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
