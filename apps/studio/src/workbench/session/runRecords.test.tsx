// @vitest-environment jsdom
import { type DirectiveView, emptyProjection, type RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionStore } from '../../../../../packages/react/src/stories/fixtures.tsx';
import type { RunRecord } from './entryMeta.ts';
import {
  forgetRunRecords,
  RECORD_READS_AT_ONCE,
  useRecordRead,
  useRunRecords,
  type WatchedExpiry,
} from './runRecords.ts';

// An instruction's state comes from its run's record: the live store while the run goes; for an
// ended run, one read when its message is drawn, kept while the app runs; never a timer.

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

const ended = (runId: string) => {
  const projection = emptyProjection(runId);
  projection.status = 'succeeded';
  return { projection };
};
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  forgetRunRecords();
  fixture.getSnapshot.mockReset();
  fixture.getSnapshot.mockImplementation(async (runId: string) => ended(runId));
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

interface Shown {
  list: RunSummary[];
  /** Runs whose message is drawn (in the window). */
  drawn: string[];
  started?: () => number;
  onWatchedExpiry?: () => void;
}
async function mount(initial: Shown) {
  const seen: {
    records: ReadonlyMap<string, RunRecord>;
    watched: ReadonlyMap<string, WatchedExpiry>;
  }[] = [];
  function Row({ runId }: { runId: string }) {
    useRecordRead(runId, true);
    return null;
  }
  function Probe({ shown }: { shown: Shown }) {
    seen.push(
      useRunRecords(
        shown.list.map((run) => run.runId),
        shown.list,
        {
          started: shown.started ?? (() => 0),
          onWatchedExpiry: shown.onWatchedExpiry ?? (() => {}),
        },
      ),
    );
    return shown.drawn.map((runId) => <Row key={runId} runId={runId} />);
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  let mounted = true;
  cleanup.push(() => {
    if (mounted) root.unmount();
  });
  await act(async () => root.render(<Probe shown={initial} />));
  return {
    last: () => seen.at(-1) as (typeof seen)[number],
    rerender: (shown: Shown) => act(async () => root.render(<Probe shown={shown} />)),
    unmount: () => {
      mounted = false;
      act(() => root.unmount());
    },
  };
}

it('an ended run is not read until its message is drawn, and then once', async () => {
  const list = [summary('run_a', 'succeeded'), summary('run_b', 'succeeded')];
  const f = await mount({ list, drawn: [] });
  expect(fixture.getSnapshot).not.toHaveBeenCalled();
  await f.rerender({ list, drawn: ['run_a'] });
  expect(fixture.getSnapshot.mock.calls).toEqual([['run_a']]);
  expect(f.last().records.get('run_a')?.projection.status).toBe('succeeded');
  expect(f.last().records.has('run_b')).toBe(false);
});

it('a session opened again uses what was read: an ended run’s record does not change', async () => {
  const list = [summary('run_a', 'succeeded')];
  const first = await mount({ list, drawn: ['run_a'] });
  first.unmount();
  const again = await mount({ list, drawn: ['run_a'] });
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(1);
  expect(again.last().records.get('run_a')?.projection.status).toBe('succeeded');
});

it('a read whose list changed meanwhile still lands, so the line is not left empty', async () => {
  let land!: () => void;
  fixture.getSnapshot.mockImplementationOnce(
    (runId: string) => new Promise((resolve) => (land = () => resolve(ended(runId)))),
  );
  const list = [summary('run_a', 'succeeded')];
  const f = await mount({ list, drawn: ['run_a'] });
  // The list changes while the read is out, and comes back.
  await f.rerender({ list: [summary('run_b', 'succeeded')], drawn: [] });
  await act(async () => land());
  await f.rerender({ list, drawn: ['run_a'] });
  expect(f.last().records.get('run_a')?.projection.status).toBe('succeeded');
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(1);
});

it('a failed read is asked again when its row is drawn again', async () => {
  fixture.getSnapshot.mockRejectedValueOnce(new Error('offline'));
  const list = [summary('run_a', 'succeeded')];
  const f = await mount({ list, drawn: ['run_a'] });
  expect(f.last().records.has('run_a')).toBe(false);
  await f.rerender({ list, drawn: [] });
  await f.rerender({ list, drawn: ['run_a'] });
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(2);
  expect(f.last().records.get('run_a')?.projection.status).toBe('succeeded');
});

it('no more than a few records are read at once; the rest wait their turn', async () => {
  const lands: (() => void)[] = [];
  fixture.getSnapshot.mockImplementation(
    (runId: string) => new Promise((resolve) => lands.push(() => resolve(ended(runId)))),
  );
  const list = Array.from({ length: 10 }, (_, index) => summary(`run_${index}`, 'succeeded'));
  const f = await mount({ list, drawn: list.map((run) => run.runId) });
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(RECORD_READS_AT_ONCE);
  await act(async () => lands[0]?.());
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(RECORD_READS_AT_ONCE + 1);
  while (lands.length < list.length || lands.some(Boolean)) {
    const next = lands.shift();
    if (!next) break;
    await act(async () => next());
  }
  expect(f.last().records.size).toBe(list.length);
});

it('a running run is followed through its live store, not polled', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  fixture.store.setState({ runId: 'run_live', projection });
  const f = await mount({ list: [summary('run_live', 'running')], drawn: [] });
  expect(f.last().records.get('run_live')?.projection).toBe(projection);
  const next = { ...projection, seq: 9 };
  await act(async () => fixture.store.setState({ projection: next }));
  expect(f.last().records.get('run_live')?.projection).toBe(next);
  expect(fixture.getSnapshot).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();
});

it('an instruction seen to expire while watched is held with what it was, and the session is read', async () => {
  const directive = (status: DirectiveView['status']) =>
    ({ directiveId: 'directive_a', status, commandId: 'cmd_a' }) as DirectiveView;
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  projection.directives.directive_a = directive('queued');
  fixture.store.setState({ runId: 'run_live', projection });
  const onWatchedExpiry = vi.fn();
  let started = 3;
  const shown = {
    list: [summary('run_live', 'running')],
    drawn: [],
    started: () => started,
    onWatchedExpiry,
  };
  const f = await mount(shown);
  expect(f.last().watched.size).toBe(0);
  started = 4;
  await act(async () =>
    fixture.store.setState({
      projection: { ...projection, directives: { directive_a: directive('expired') } },
    }),
  );
  expect(f.last().watched.get('directive_a')).toEqual({ at: 4, before: 'queued' });
  expect(onWatchedExpiry).toHaveBeenCalledTimes(1);
});

it('an instruction already expired when first seen is not held', async () => {
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  projection.directives.directive_a = {
    directiveId: 'directive_a',
    status: 'expired',
  } as DirectiveView;
  fixture.store.setState({ runId: 'run_live', projection });
  const onWatchedExpiry = vi.fn();
  const f = await mount({ list: [summary('run_live', 'running')], drawn: [], onWatchedExpiry });
  expect(f.last().watched.size).toBe(0);
  expect(onWatchedExpiry).not.toHaveBeenCalled();
});
