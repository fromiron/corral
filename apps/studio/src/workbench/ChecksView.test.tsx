// @vitest-environment jsdom
import type { VerificationResultView, WorkspaceBindingView } from '@corral/client';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Checks } from './ChecksView.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    ...rest
  }: {
    children?: ReactNode;
    to: string;
    search?: Record<string, string>;
  }) => (
    <a
      href={`${to}?${new URLSearchParams(search).toString()}`}
      aria-label={(rest as { 'aria-label'?: string })['aria-label']}
    >
      {children}
    </a>
  ),
}));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(
  results: VerificationResultView[],
  commands: WorkspaceBindingView['verifyCommands'] = [],
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = {
    mode: 'server',
    workspaceId: 'host',
    workspaces: { verifications: async () => results },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <Checks
        sessionId="session"
        projectId="project_a"
        binding={{ verifyCommands: commands } as WorkspaceBindingView}
        changed={0}
        titled={false}
      />,
    ),
  );
  await act(async () => {});
  return container;
}

const record = (argv: string[]): VerificationResultView => ({
  verificationId: 'verification_1',
  commandId: 'readme',
  name: 'README has a title',
  argv,
  tree: 'a'.repeat(40),
  state: 'passed',
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 354,
  output: 'README has a title',
  startedAt: '2026-11-10T01:02:00.000Z',
  endedAt: '2026-11-10T01:02:01.000Z',
  stale: false,
});

it('with no checks, the empty state opens the project tools settings of this project', async () => {
  const container = await mount([]);
  const empty = container.querySelector('[data-testid="checks-empty"]');
  expect(empty?.textContent).toContain('Files.noChecks');
  const link = empty?.querySelector('a');
  expect(link?.textContent).toBe('Checks.openProjectTools');
  const url = new URL(link?.getAttribute('href') ?? '', 'http://corral.local');
  expect(url.pathname).toBe('/settings');
  expect(url.searchParams.get('section')).toBe('workspace');
  expect(url.searchParams.get('projectId')).toBe('project_a');
  // One empty state, and nothing else to read.
  expect(container.querySelectorAll('[data-testid="check-result"]')).toHaveLength(0);
});

it('shows a record command with the quoting a shell needs to read the same arguments', async () => {
  const container = await mount(
    [record(['node', '-e', "console.log('README has a title')"])],
    [{ id: 'readme', name: 'README has a title', argv: ['node'], timeoutMs: 1000 }],
  );
  expect(container.querySelector('[data-testid="checks-empty"]')).toBeNull();
  expect(container.querySelector('[data-testid="check-result"] code')?.textContent).toBe(
    `node -e "console.log('README has a title')"`,
  );
  // The project tools stay one step away once checks exist.
  expect(container.querySelector('a[aria-label="Checks.openProjectTools"]')).not.toBeNull();
});
