// @vitest-environment jsdom
import { emptyProjection, type RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionStore } from '../../../../../packages/react/src/stories/fixtures.tsx';
import type { RunRecord } from './entryMeta.ts';
import { useRunRecords } from './runRecords.ts';

// An instruction's state comes from its run's record: the live store while the run goes, one
// read once it has ended, and never a timer.

const fixture = vi.hoisted(() => {
  const value = {
    store: null as unknown as ReturnType<typeof sessionStore>,
    getSnapshot: vi.fn(),
    getRunDefinition: vi.fn(async () => null),
    services: null as unknown,
  };
  value.services = {
    runFor: () => value.store,
    transport: {
      getSnapshot: (runId: string) => value.getSnapshot(runId),
      getRunDefinition: () => value.getRunDefinition(),
    },
  };
  return value;
});
vi.mock('../../services.tsx', () => ({
  // One services object, as the app's provider gives.
  useServices: () => fixture.services,
}));

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.getSnapshot.mockReset();
  fixture.getSnapshot.mockImplementation(async (runId: string) => {
    const projection = emptyProjection(runId);
    projection.status = 'succeeded';
    return { projection };
  });
  fixture.store = sessionStore({ runId: null, projection: null });
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const summary = (runId: string, status: RunSummary['status']): RunSummary => ({
  runId,
  status,
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-11-09T09:00:00Z',
});

async function mount(runs: RunSummary[]) {
  const seen: ReadonlyMap<string, RunRecord>[] = [];
  function Probe({ list }: { list: RunSummary[] }) {
    seen.push(
      useRunRecords(
        list.map((run) => run.runId),
        list,
      ),
    );
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  cleanup.push(() => root.unmount());
  await act(async () => root.render(<Probe list={runs} />));
  return {
    last: () => seen.at(-1) as ReadonlyMap<string, RunRecord>,
    rerender: (list: RunSummary[]) => act(async () => root.render(<Probe list={list} />)),
  };
}

it('a running run is followed through its live store, not polled', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  fixture.store.setState({ runId: 'run_live', projection });
  const f = await mount([summary('run_live', 'running')]);
  expect(f.last().get('run_live')?.projection).toBe(projection);
  // Its next fact arrives through the store.
  const next = { ...projection, seq: 9 };
  await act(async () => fixture.store.setState({ projection: next }));
  expect(f.last().get('run_live')?.projection).toBe(next);
  expect(fixture.getSnapshot).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();
});

it('an ended run is read once, and its record stays until the read replaces it', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  fixture.store.setState({ runId: 'run_live', projection });
  const f = await mount([summary('run_live', 'running')]);
  // The run ends: one read, and nothing in between says less than before.
  await f.rerender([summary('run_live', 'succeeded')]);
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(1);
  expect(f.last().get('run_live')?.projection.status).toBe('succeeded');
  // Another instruction to another run reads that run alone.
  await f.rerender([summary('run_live', 'succeeded'), summary('run_old', 'failed')]);
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(2);
  expect(fixture.getSnapshot).toHaveBeenLastCalledWith('run_old');
  expect(interval).not.toHaveBeenCalled();
});

it('a running run whose store has not opened is read once to fill in, then the store wins', async () => {
  const f = await mount([summary('run_live', 'running')]);
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(1);
  expect(f.last().get('run_live')?.projection.status).toBe('succeeded');
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  await act(async () => fixture.store.setState({ runId: 'run_live', projection }));
  expect(f.last().get('run_live')?.projection).toBe(projection);
});
