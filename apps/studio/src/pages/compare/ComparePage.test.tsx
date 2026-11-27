// @vitest-environment jsdom

import { linearCorral } from '@corral/testkit';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { projectionWith } from '../../../../../packages/react/src/stories/fixtures.tsx';
import { ComparePage } from './ComparePage.tsx';

const fixture = vi.hoisted(() => ({
  search: {} as { a?: string; b?: string },
  getSnapshot: vi.fn(async () => {
    throw new Error('Not found');
  }),
  services: {},
}));
vi.mock('../../router.tsx', () => ({ compareRoute: { useSearch: () => fixture.search } }));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../prices.ts', () => ({ useModelPrices: () => undefined }));
vi.mock('../../projects.ts', () => ({ currentProject: () => 'project_current' }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    hash,
  }: {
    children: ReactNode;
    to: string;
    params?: { projectId: string };
    hash?: string;
  }) => (
    <a href={`${to.replace('$projectId', params?.projectId ?? '')}${hash ? `#${hash}` : ''}`}>
      {children}
    </a>
  ),
}));
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderPage() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
        <ComparePage />
      </IntlProvider>,
    ),
  );
  return container;
}

it.each([{}, { a: 'run_one' }])(
  'guides an incomplete comparison to the existing project Runs list without querying empty IDs (%j)',
  async (search) => {
    fixture.search = search;
    fixture.services = { transport: { getSnapshot: fixture.getSnapshot }, repository: {} };
    const container = await renderPage();
    expect(fixture.getSnapshot).not.toHaveBeenCalled();
    expect(container.querySelector('a[href="/projects/project_current#runs"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);

it('compares recorded requests and pinned team names even after the current team was renamed', async () => {
  fixture.search = { a: 'run_session', b: 'run_standalone' };
  const renamed = vi.fn(async () => ({ definition: { name: 'Renamed current team' } }));
  const definition = linearCorral(['writer']);
  definition.input.brief = '';
  definition.sourceTeam = { corralId: 'team', name: 'Original team', revision: 1 };
  const summary = {
    status: 'succeeded',
    corralId: 'team',
    projectId: 'project_current',
    startedAt: '2026-10-30T01:00:00Z',
  };
  fixture.services = {
    transport: {
      getSnapshot: async (runId: string) => ({
        projection: projectionWith({ runId, startedAt: summary.startedAt, corralId: 'team' }),
      }),
      listRuns: async () => [
        { ...summary, runId: 'run_standalone', sessionId: null },
        { ...summary, runId: 'run_session', sessionId: 'session' },
      ],
      getRunDefinition: async () => definition,
    },
    repository: {
      get: renamed,
      getSession: async () => ({
        sessionId: 'session',
        title: 'Release notes',
        entries: [{ runId: 'run_session', intent: 'next', text: 'Original request' }],
      }),
    },
  };
  const container = await renderPage();
  expect(container.textContent).toContain('Release notes · Run #1 · Original request');
  expect(container.textContent).toContain('Original team');
  expect(container.textContent).not.toContain('Renamed current team');
  expect(renamed).not.toHaveBeenCalled();
});

const chooseLink = (container: HTMLElement) =>
  container.querySelector('a[href="/projects/project_current#runs"]');
const named = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === name);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

it('shows the kit loading presentation while the two runs are read', async () => {
  fixture.search = { a: 'run_a', b: 'run_b' };
  fixture.services = {
    transport: {
      getSnapshot: () => new Promise(() => {}),
      listRuns: async () => [],
      getRunDefinition: async () => null,
    },
    repository: {},
  };
  const container = await renderPage();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    messages.Compare.loading,
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('names each run that is not found and offers the run picker, with no retry', async () => {
  fixture.search = { a: 'run_gone', b: 'run_lost' };
  fixture.services = {
    transport: {
      getSnapshot: async () => {
        throw new Error('run does not exist');
      },
      listRuns: async () => [],
      getRunDefinition: async () => null,
    },
    repository: {},
  };
  const container = await renderPage();
  await settle();
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(messages.Compare.notFound.replace('{runId}', 'run_gone'));
  expect(alert?.textContent).toContain(messages.Compare.notFound.replace('{runId}', 'run_lost'));
  expect(chooseLink(container)?.textContent).toBe(messages.Compare.chooseRuns);
  expect(named(container, messages.Compare.retry)).toBeUndefined();
});

it('says a failed read failed, offers the run picker and Try again, which reads again', async () => {
  fixture.search = { a: 'run_a', b: 'run_b' };
  let offline = true;
  const getSnapshot = vi.fn(async (runId: string) => {
    if (offline) throw new Error('Failed to fetch');
    return {
      projection: projectionWith({ runId, startedAt: '2026-10-30T01:00:00Z', corralId: 'team' }),
    };
  });
  fixture.services = {
    transport: {
      getSnapshot,
      listRuns: async () => [],
      getRunDefinition: async () => {
        if (offline) throw new Error('Failed to fetch');
        return linearCorral(['writer']);
      },
      getArtifactText: async () => null,
    },
    repository: {},
  };
  const container = await renderPage();
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(messages.Compare.readFailed);
  expect(chooseLink(container)).not.toBeNull();
  offline = false;
  await act(async () => named(container, messages.Compare.retry)?.click());
  await settle();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(getSnapshot.mock.calls.map(([runId]) => runId)).toEqual([
    'run_a',
    'run_b',
    'run_a',
    'run_b',
  ]);
});
