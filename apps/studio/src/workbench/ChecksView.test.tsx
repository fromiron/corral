// @vitest-environment jsdom
import type { VerificationResultView, WorkspaceBindingView } from '@corral/client';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Checks } from './ChecksView.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

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
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values?.name ? `${namespace}.${key}:${values.name}` : `${namespace}.${key}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(
  results: VerificationResultView[],
  commands: WorkspaceBindingView['verifyCommands'] = [],
  verify = vi.fn(async () => ({})),
  folderFailed?: string,
  readFailureSaid = false,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = {
    mode: 'server',
    workspaceId: 'host',
    workspaces: { verifications: async () => results, verify },
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
        binding={folderFailed ? null : ({ verifyCommands: commands } as WorkspaceBindingView)}
        {...(folderFailed ? { folderFailed, readFailureSaid } : {})}
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

// docs/specs/workbench.md: a failed folder read is never taken as "none".
it('a failed folder read says why and offers Try again where the checks would be', async () => {
  const container = await mount([], [], undefined, 'offline');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Files.folderReadFailed');
  expect(container.querySelector('[data-testid="checks-empty"]')).toBeNull();
  const asked = vi.fn();
  window.addEventListener(WORKSPACE_CHANGED, asked);
  cleanups.push(async () => window.removeEventListener(WORKSPACE_CHANGED, asked));
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Files.retry')
      ?.click(),
  );
  expect(asked).toHaveBeenCalledOnce();
});

it('says nothing where the host already said the folder link could not be read', async () => {
  const container = await mount([], [], undefined, 'offline', true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[data-testid="checks-empty"]')).toBeNull();
});

it('keeps the records it read while the folder link cannot be read', async () => {
  const container = await mount([record(['true'])], [], undefined, 'offline');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Files.folderReadFailed');
  expect(container.querySelectorAll('[data-testid="check-result"]')).toHaveLength(1);
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
  // A completed run is the normal case: the verdict says the outcome, not "Completed" too.
  for (const row of [failedRow, passedRow])
    expect(part(row, 'Files.checkReportState.completed')).toBeUndefined();
  const fail = part(failedRow, 'Files.checkVerdict.fail');
  expect(fail?.className).toContain('text-destructive');
  expect(fail?.querySelector('svg')).not.toBeNull();
  const pass = part(passedRow, 'Files.checkVerdict.pass');
  expect(pass?.className).toContain('text-success');
  expect(pass?.querySelector('svg')).not.toBeNull();
});

it('names the run state beside the verdict only when the run did not complete', async () => {
  const container = await mount([
    {
      ...record(['node', '-e', '0']),
      state: 'failed',
      report: {
        verificationId: 'verification_1',
        owner: { kind: 'manual', sessionId: 'session' },
        sessionId: 'session',
        commandId: 'readme',
        configRevision: 1,
        fingerprint: 'f'.repeat(64),
        tree: 'a'.repeat(40),
        state: 'error',
        verdict: 'not_evaluated',
        exitCode: null,
        signal: null,
        timedOut: false,
        cleanupConfirmed: true,
        targetUnchanged: true,
        durationMs: 12,
        startedAt: '2026-11-10T01:02:00.000Z',
        endedAt: '2026-11-10T01:02:01.000Z',
        retainUntil: '2026-12-10T01:02:01.000Z',
        output: { text: '', bytes: 0, hash: 'c'.repeat(64), truncated: false },
      },
    } as VerificationResultView,
  ]);
  const row = container.querySelector('[data-testid="check-result"]');
  const error = [...(row?.querySelectorAll('span') ?? [])].find(
    (span) => span.textContent === 'Files.checkReportState.error',
  );
  expect(error?.className).toContain('text-destructive');
  expect(row?.textContent).toContain('Files.checkVerdict.not_evaluated');
});

it('runs a check from its own row once it has one, and from the bar above until then', async () => {
  const verify = vi.fn(async () => ({}));
  const container = await mount(
    [record(['node', '-e', '0'])],
    [
      { id: 'readme', name: 'README has a title', argv: ['node'], timeoutMs: 1000 },
      { id: 'lint', name: 'Lint', argv: ['node'], timeoutMs: 1000 },
    ],
    verify,
  );
  const row = container.querySelector<HTMLElement>('[data-testid="check-result"]');
  const named = (scope: Element | null | undefined, name: string) =>
    [...(scope?.querySelectorAll('button') ?? [])].filter(
      (button) => (button.getAttribute('aria-label') ?? button.textContent) === name,
    );
  // The row's own Run, named for its check; the bar above keeps only the check without a row.
  const rowRun = named(row, 'Files.runCheck:README has a title');
  expect(rowRun).toHaveLength(1);
  expect(named(container, 'Files.runCheck:README has a title')).toHaveLength(1);
  expect(named(container, 'Files.runCheck:Lint')).toHaveLength(1);
  expect(row?.contains(named(container, 'Files.runCheck:Lint')[0] ?? null)).toBe(false);
  await act(async () => rowRun[0]?.click());
  expect(verify).toHaveBeenCalledWith('session', 'readme');
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

async function show(
  props: Partial<Parameters<typeof Checks>[0]>,
  workspaces: Record<string, unknown> | null = { verifications: async () => [], verify: vi.fn() },
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = workspaces
    ? { mode: 'server', workspaceId: 'host', workspaces }
    : { mode: 'browser' };
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
        binding={null}
        changed={0}
        titled={false}
        {...props}
      />,
    ),
  );
  await act(async () => {});
  return container;
}
const emptyState = (container: HTMLElement) =>
  container.querySelector('[data-testid="checks-empty"]');
const alerts = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);
const rows = (container: HTMLElement) => container.querySelectorAll('[data-testid="check-result"]');
const again = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].filter(
    (button) => button.textContent === 'Files.retry',
  );
const reads = () => vi.fn<() => Promise<VerificationResultView[]>>();

// docs/specs/workbench.md: what is not read yet, or could not be read, is never shown as none.
it('does not say there are no checks while the folder link is being read', async () => {
  const container = await show({ binding: undefined });
  expect(emptyState(container)).toBeNull();
});

it('does not say there are no checks before the records are read', async () => {
  const container = await show({}, { verifications: () => new Promise(() => {}), verify: vi.fn() });
  expect(emptyState(container)).toBeNull();
});

it('says there are no checks where there is no service to read them from', async () => {
  const container = await show({}, null);
  expect(emptyState(container)).not.toBeNull();
});

it('a failed read of the records says why and offers Try again, never "no checks"', async () => {
  const verifications = reads()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([record(['true'])]);
  const container = await show({}, { verifications, verify: vi.fn() });
  expect(alerts(container)).toEqual(['Files.checksReadFailed']);
  expect(emptyState(container)).toBeNull();
  await act(async () => again(container)[0]?.click());
  await act(async () => {});
  expect(alerts(container)).toEqual([]);
  expect(rows(container)).toHaveLength(1);
});

it('keeps the rows and goes on reading a running check when a later read fails', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  cleanups.push(async () => {
    vi.useRealTimers();
  });
  const verifications = reads()
    .mockResolvedValueOnce([{ ...record(['true']), state: 'running' }])
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([record(['true'])]);
  const container = await show({}, { verifications, verify: vi.fn() });
  expect(rows(container)).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(alerts(container)).toEqual(['Files.checksReadFailed']);
  expect(rows(container)).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(alerts(container)).toEqual([]);
  expect(verifications).toHaveBeenCalledTimes(3);
});

it('says one failure when the folder link and the records both cannot be read, and Try again reads both', async () => {
  const verifications = reads().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  const container = await show({ folderFailed: 'offline' }, { verifications, verify: vi.fn() });
  expect(alerts(container)).toEqual(['Files.folderReadFailed']);
  expect(again(container)).toHaveLength(1);
  const asked = vi.fn();
  window.addEventListener(WORKSPACE_CHANGED, asked);
  cleanups.push(async () => window.removeEventListener(WORKSPACE_CHANGED, asked));
  await act(async () => again(container)[0]?.click());
  expect(asked).toHaveBeenCalledOnce();
  expect(verifications).toHaveBeenCalledTimes(2);
});

it('adds no failure of its own under one the host already says', async () => {
  const verifications = reads().mockRejectedValue(new Error('offline'));
  const container = await show(
    { folderFailed: 'offline', readFailureSaid: true },
    { verifications, verify: vi.fn() },
  );
  expect(alerts(container)).toEqual([]);
  expect(emptyState(container)).toBeNull();
});
