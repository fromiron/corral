// @vitest-environment jsdom
import type { RunSummary, WorkSession } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunList } from './RunList.tsx';

const fixture = vi.hoisted(() => ({ transport: { getRunDefinition: vi.fn(async () => null) } }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: ReactNode; params: { runId: string } }) => (
    <a href={`/runs/${params.runId}`}>{children}</a>
  ),
}));
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('shows the request and session run number, preserves exact identity in a closed disclosure and selects that run', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const run: RunSummary = {
    runId: 'run_exact_identity',
    sessionId: 'session',
    corralId: 'auto_internal',
    projectId: 'project',
    status: 'succeeded',
    startedAt: '2026-10-30T01:00:00Z',
  };
  const session = {
    sessionId: 'session',
    title: 'Release notes',
    entries: [{ runId: run.runId, intent: 'next', text: 'Review the release' }],
  } as WorkSession;
  const onPick = vi.fn();
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
        <RunList runs={[run]} sessions={[session]} picked={[]} onPick={onPick} />
      </IntlProvider>,
    ),
  );
  expect(container.querySelector('a')?.textContent).toBe(
    'Release notes · Run #1 · Review the release',
  );
  expect(container.querySelector('time')?.dateTime).toBe(run.startedAt);
  const details = container.querySelector('details');
  expect(details?.open).toBe(false);
  expect(details?.querySelector('code')?.textContent).toBe(run.runId);
  expect(fixture.transport.getRunDefinition).not.toHaveBeenCalled();
  const checkbox = container.querySelector<HTMLElement>('[role="checkbox"]');
  if (!checkbox) throw new Error('Run comparison checkbox missing');
  await act(async () => checkbox.click());
  expect(onPick).toHaveBeenCalledWith(run.runId, true);
});
