// @vitest-environment jsdom
import type { RunSummary } from '@corral/core';
import { createMemoryHistory } from '@tanstack/react-router';
import { expect, it, vi } from 'vitest';
import { createStudioRouter } from './router.tsx';

// A session's run lives in that session's run history (docs/specs/workbench.md): `/runs/:runId`
// replaces itself with the session's run tab and keeps what it showed. A run without a session
// (an editor test run) keeps its own page, and a failed lookup never guesses a session.

const summary = (runId: string, sessionId: string | null): RunSummary => ({
  runId,
  sessionId,
  status: 'succeeded',
  corralId: 'corral_a',
  startedAt: '2026-11-10T09:00:00.000Z',
  projectId: 'default',
});

async function open(
  entries: string[],
  listRuns: () => Promise<RunSummary[]>,
  options: { runLookupMs?: number } = {},
) {
  const services = {
    transport: { listRuns: vi.fn(listRuns) },
    repository: {
      getSession: vi.fn(async (sessionId: string) => ({
        sessionId,
        projectId: 'default',
        title: 'Session',
        entries: [],
      })),
      listProjects: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
  };
  const router = createStudioRouter(services as never, options);
  const history = createMemoryHistory({
    initialEntries: entries,
    initialIndex: entries.length - 1,
  });
  router.update({ ...router.options, history });
  await router.load();
  return { router, history, services };
}

it('replaces a session run address with that session’s run history, keeping its view and result', async () => {
  const { router, history } = await open(
    ['/inbox', '/runs/run_a?view=results&result=artv_report'],
    async () => [summary('run_other', 'session_wrong'), summary('run_a', 'session_a')],
  );
  expect(router.state.location.pathname).toBe('/sessions/session_a');
  expect(router.state.location.search).toEqual({
    panel: 'run',
    run: 'run_a',
    view: 'results',
    result: 'artv_report',
  });
  // Replaced, not pushed: Back leaves for the previous screen instead of bouncing.
  expect(history.length).toBe(2);
  history.back();
  await router.load();
  expect(router.state.location.pathname).toBe('/inbox');
});

it('keeps the inspected execution and an opened artifact', async () => {
  const { router } = await open(
    ['/runs/run_a?execution=exec_waiting&artifact=artv_draft'],
    async () => [summary('run_a', 'session_a')],
  );
  expect(router.state.location.pathname).toBe('/sessions/session_a');
  expect(router.state.location.search).toEqual({
    panel: 'run',
    run: 'run_a',
    execution: 'exec_waiting',
    artifact: 'artv_draft',
  });
});

it('keeps a run without a session on its own page', async () => {
  const { router } = await open(['/runs/run_test?view=results'], async () => [
    summary('run_test', null),
    summary('run_other', 'session_a'),
  ]);
  expect(router.state.location.pathname).toBe('/runs/run_test');
  expect(router.state.location.search).toEqual({ view: 'results' });
});

it('stays on the run page when the run is not listed or the lookup fails', async () => {
  const missing = await open(['/runs/run_gone'], async () => [summary('run_a', 'session_a')]);
  expect(missing.router.state.location.pathname).toBe('/runs/run_gone');
  const failed = await open(['/runs/run_a'], async () => {
    throw new Error('offline');
  });
  expect(failed.router.state.location.pathname).toBe('/runs/run_a');
});

it('a slow lookup opens the run page after its wait, and its late answer moves nothing', async () => {
  let answer: (runs: RunSummary[]) => void = () => {};
  const { router } = await open(
    ['/inbox', '/runs/run_a?view=results'],
    () =>
      new Promise<RunSummary[]>((resolve) => {
        answer = resolve;
      }),
    { runLookupMs: 20 },
  );
  expect(router.state.location.pathname).toBe('/runs/run_a');
  expect(router.state.status).toBe('idle');
  expect(router.state.matches.at(-1)?.routeId).toBe('/runs/$runId');
  answer([summary('run_a', 'session_a')]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(router.state.location.pathname).toBe('/runs/run_a');
  expect(router.state.location.search).toEqual({ view: 'results' });
});

it('a lookup answered within the wait still moves to the session', async () => {
  const { router } = await open(
    ['/runs/run_a'],
    () =>
      new Promise<RunSummary[]>((resolve) =>
        setTimeout(() => resolve([summary('run_a', 'session_a')]), 5),
      ),
    { runLookupMs: 500 },
  );
  expect(router.state.location.pathname).toBe('/sessions/session_a');
});

it('looks the session up once when only the run page’s own address changes', async () => {
  const { router, services } = await open(['/runs/run_test'], async () => [
    summary('run_test', null),
  ]);
  expect(services.transport.listRuns).toHaveBeenCalledTimes(1);
  await router.navigate({
    to: '/runs/$runId',
    params: { runId: 'run_test' },
    search: { view: 'results' },
  });
  expect(router.state.location.search).toEqual({ view: 'results' });
  expect(services.transport.listRuns).toHaveBeenCalledTimes(1);
});
