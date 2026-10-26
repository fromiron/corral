// @vitest-environment jsdom
import type { VerificationResultView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Checks } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => () => {} }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
afterEach(() => vi.unstubAllGlobals());

function result(sessionId = 'session'): VerificationResultView {
  const hash = 'f'.repeat(64),
    tree = 'a'.repeat(40),
    date = '2026-10-21T00:00:00.000Z';
  return {
    verificationId: `verification_${sessionId}`,
    commandId: 'test',
    name: `Test ${sessionId}`,
    argv: ['test'],
    tree,
    state: 'failed',
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 10,
    output: 'Displayed [redacted] output',
    startedAt: date,
    endedAt: date,
    stale: false,
    report: {
      verificationId: `verification_${sessionId}`,
      sessionId,
      commandId: 'test',
      owner: { kind: 'manual', sessionId },
      tree,
      fingerprint: 'b'.repeat(64),
      configRevision: 3,
      state: 'completed',
      verdict: 'fail',
      exitCode: 1,
      signal: null,
      timedOut: false,
      cleanupConfirmed: true,
      targetUnchanged: true,
      durationMs: 10,
      startedAt: date,
      endedAt: date,
      retainUntil: date,
      output: { text: 'RAW_PRIVATE_OUTPUT', hash, bytes: 18, truncated: true },
    },
  };
}

it('captures the displayed check output and keeps its raw report hash separate', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const entry = result();
  const workspaces = {
    verifications: vi.fn(async () => [entry]),
    verify: vi.fn(),
    cancelVerification: vi.fn(),
  };
  fixture.services = { mode: 'server', workspaceId: 'host', workspaces };
  const onAttach = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Checks
          sessionId="session"
          projectId="project"
          binding={null}
          changed={0}
          onAttach={onAttach}
        />,
      ),
    );
    const attach = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Files.attachCheckOutput',
    );
    expect(attach).toBeDefined();
    expect(onAttach).not.toHaveBeenCalled();
    await act(async () => attach?.click());
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onAttach.mock.calls[0]?.[0]).toMatchObject({
      text: entry.output,
      provenance: {
        kind: 'check',
        hostId: 'host',
        projectId: 'project',
        sessionId: 'session',
        verificationId: entry.verificationId,
        commandId: 'test',
        tree: entry.tree,
        configRevision: 3,
        fingerprint: 'b'.repeat(64),
        outputHash: 'f'.repeat(64),
        outputTruncated: true,
      },
    });
    expect(JSON.stringify(onAttach.mock.calls)).not.toContain('RAW_PRIVATE_OUTPUT');
    expect(onAttach.mock.calls[0]?.[0].sha256).not.toBe(entry.report?.output.hash);
    expect(workspaces.verify).not.toHaveBeenCalled();
    expect(workspaces.cancelVerification).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('a late check response from another session cannot become the current capture', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolveFirst!: (value: VerificationResultView[]) => void;
  const first = new Promise<VerificationResultView[]>((resolve) => {
    resolveFirst = resolve;
  });
  const workspaces = {
    verifications: vi.fn((sessionId: string) =>
      sessionId === 'first' ? first : Promise.resolve([result('second')]),
    ),
  };
  fixture.services = { mode: 'server', workspaceId: 'host', workspaces };
  const onAttach = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (sessionId: string) =>
    root.render(
      <Checks
        sessionId={sessionId}
        projectId="project"
        binding={null}
        changed={0}
        onAttach={onAttach}
      />,
    );
  try {
    await act(async () => render('first'));
    await act(async () => render('second'));
    await act(async () => resolveFirst([result('first')]));
    expect(container.textContent).toContain('Test second');
    expect(container.textContent).not.toContain('Test first');
    const attach = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Files.attachCheckOutput',
    );
    await act(async () => attach?.click());
    expect(onAttach.mock.calls[0]?.[0].provenance.sessionId).toBe('second');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
