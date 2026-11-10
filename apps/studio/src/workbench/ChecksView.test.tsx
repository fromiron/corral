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
  // The shared empty view, as every empty part of Changes uses it.
  expect(empty?.getAttribute('data-slot')).toBe('empty-view');
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

it('colours the verdict, not the run state: a completed check that failed reads Fail in red', async () => {
  const report = (verdict: 'pass' | 'fail') =>
    ({
      verificationId: `verification_${verdict}`,
      owner: { kind: 'manual', sessionId: 'session' },
      sessionId: 'session',
      commandId: 'readme',
      configRevision: 1,
      fingerprint: 'f'.repeat(64),
      tree: 'a'.repeat(40),
      state: 'completed',
      verdict,
      exitCode: verdict === 'pass' ? 0 : 1,
      signal: null,
      timedOut: false,
      cleanupConfirmed: true,
      targetUnchanged: true,
      durationMs: 354,
      startedAt: '2026-11-10T01:02:00.000Z',
      endedAt: '2026-11-10T01:02:01.000Z',
      retainUntil: '2026-12-10T01:02:01.000Z',
      output: { text: '', bytes: 0, hash: 'c'.repeat(64), truncated: false },
    }) as const;
  const container = await mount([
    {
      ...record(['node', '-e', 'process.exit(1)']),
      verificationId: 'verification_fail',
      state: 'failed',
      exitCode: 1,
      report: report('fail'),
    },
    { ...record(['node', '-e', '0']), verificationId: 'verification_pass', report: report('pass') },
  ]);
  const [failedRow, passedRow] = [
    ...container.querySelectorAll<HTMLElement>('[data-testid="check-result"]'),
  ];
  const part = (row: HTMLElement | undefined, text: string) =>
    [...(row?.querySelectorAll<HTMLElement>('span') ?? [])].find(
      (span) => span.textContent === text,
    );
  for (const row of [failedRow, passedRow]) {
    const state = part(row, 'Files.checkReportState.completed');
    expect(state).toBeDefined();
    expect(state?.className).not.toMatch(/text-(destructive|success)/);
  }
  const fail = part(failedRow, 'Files.checkVerdict.fail');
  expect(fail?.className).toContain('text-destructive');
  expect(fail?.querySelector('svg')).not.toBeNull();
  const pass = part(passedRow, 'Files.checkVerdict.pass');
  expect(pass?.className).toContain('text-success');
  expect(pass?.querySelector('svg')).not.toBeNull();
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
