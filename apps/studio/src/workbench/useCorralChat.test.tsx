// @vitest-environment jsdom
import { emptyProjection } from '@corral/core';
import { createRunSession } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  live: null as ReturnType<typeof createRunSession> | null,
  read: null as { resolve(view: unknown): void; reject(error: unknown): void } | null,
}));
const services = vi.hoisted(() => ({
  transport: {},
  readHistory: async () => null,
  runFor: () => fixture.live,
  retainRun: () => () => {},
}));
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('./readRunView.ts', () => ({
  readRunView: () =>
    new Promise((resolve, reject) => {
      fixture.read = { resolve, reject };
    }),
}));
const { useCorralRun } = await import('./useCorralChat.ts');

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function projection(runId: string, status: 'running' | 'succeeded') {
  const value = emptyProjection(runId);
  value.status = status;
  return value;
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.live = createRunSession({} as never);
  const seen: {
    runId: string;
    status: string | null;
    error: string | null;
    texts?: Record<string, string>;
  }[] = [];
  function Probe({ runId, live }: { runId: string; live: boolean }) {
    const { state } = useCorralRun(runId, live, false);
    seen.push({
      runId,
      status: state.projection?.status ?? null,
      error: state.streamError ?? null,
      ...(Object.keys(state.artifactTexts).length ? { texts: state.artifactTexts } : {}),
    });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  disposals.push(async () => act(async () => root.unmount()));
  const render = (runId: string, live: boolean) =>
    act(async () => root.render(<Probe runId={runId} live={live} />));
  await render('run', true);
  await act(async () =>
    fixture.live?.setState({ runId: 'run', projection: projection('run', 'running') }),
  );
  return { seen, render, latest: () => seen.at(-1) };
}

it('[TC-WBD-007-N] a finishing turn keeps its live view until the finished view loads', async () => {
  const f = await mount();
  expect(f.latest()?.status).toBe('running');
  const loaded = f.seen.length;
  await f.render('run', false);
  // No render between the live and finished views may drop the projection (that remounts the log).
  expect(f.seen.slice(loaded).filter((entry) => entry.status === null)).toEqual([]);
  expect(f.latest()?.status).toBe('running');
  await act(async () =>
    fixture.read?.resolve({ runId: 'run', projection: projection('run', 'succeeded') }),
  );
  expect(f.seen.slice(loaded).filter((entry) => entry.status === null)).toEqual([]);
  expect(f.latest()?.status).toBe('succeeded');
});

it('[TC-WBD-007-F] a failed finished read shows its error instead of the kept live view', async () => {
  const f = await mount();
  await f.render('run', false);
  await act(async () => fixture.read?.reject(new Error('read failed')));
  expect(f.latest()).toEqual({ runId: 'run', status: null, error: 'read failed' });
});

it('[TC-WBD-007-N] another run never shows the previous run as its own', async () => {
  const f = await mount();
  await f.render('other', false);
  expect(f.latest()).toEqual({ runId: 'other', status: null, error: null });
});

it('[TC-WBD-007-N] the finished view keeps result texts the live view already loaded', async () => {
  const f = await mount();
  await act(async () => fixture.live?.setState({ artifactTexts: { result: 'Loaded answer' } }));
  await f.render('run', false);
  await act(async () =>
    fixture.read?.resolve({
      runId: 'run',
      projection: projection('run', 'succeeded'),
      artifactTexts: {},
    }),
  );
  expect(f.latest()?.status).toBe('succeeded');
  expect(f.latest()?.texts).toEqual({ result: 'Loaded answer' });
});
