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
  RECORD_RETRY,
  recordRetry,
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
  /** Whether the run list has been read (false right after the app starts). */
  listed?: boolean;
  started?: () => number;
  onWatchedExpiry?: () => void;
}
async function mount(initial: Shown) {
  const seen: {
    records: ReadonlyMap<string, RunRecord>;
    watched: ReadonlyMap<string, WatchedExpiry>;
  }[] = [];
  function Row({ runId, shown }: { runId: string; shown: Shown }) {
    useRecordRead(runId, shown.list, shown.listed ?? true);
    return null;
  }
  function Probe({ shown }: { shown: Shown }) {
    seen.push(
      useRunRecords(
        [...shown.list.map((run) => run.runId), ...shown.drawn],
        shown.list,
        {
          started: shown.started ?? (() => 0),
          onWatchedExpiry: shown.onWatchedExpiry ?? (() => {}),
        },
      ),
    );
    return shown.drawn.map((runId) => <Row key={runId} runId={runId} shown={shown} />);
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
  const next = { ...projection, lastSeq: 9 };
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

// Right after the app starts the run list is not read yet: a run missing from it may be going.
const steerAt = (status: DirectiveView['status']) =>
  ({
    directiveId: 'directive_a',
    status,
    commandId: 'cmd_a',
    targetExecutionId: 'exec_a',
  }) as DirectiveView;
function projectionOf(
  runStatus: RunSummary['status'],
  directive: DirectiveView['status'],
  seq: number,
) {
  const projection = emptyProjection('run_live');
  projection.status = runStatus;
  projection.lastSeq = seq;
  projection.directives.directive_a = steerAt(directive);
  return projection;
}

for (const [ending, runStatus, last] of [
  ['read', 'succeeded', 'delivered'],
  ['carried', 'succeeded', 'expired'],
  ['failed', 'failed', 'expired'],
] as const) {
  it(`drawn before the run list is read, a going run's instruction ends ${ending} as its ended record says`, async () => {
    // The server's record: going, the instruction waiting; later, ended.
    let server = projectionOf('running', 'queued', 3);
    fixture.getSnapshot.mockImplementation(async () => ({ projection: server }));
    const f = await mount({ list: [], listed: false, drawn: ['run_live'] });
    // Not known to have ended: not read as ended.
    expect(fixture.getSnapshot).not.toHaveBeenCalled();
    // The list comes: going, followed through its live store.
    fixture.store.setState({ runId: 'run_live', projection: projectionOf('running', 'queued', 4) });
    await f.rerender({ list: [summary('run_live', 'running')], drawn: ['run_live'] });
    expect(f.last().records.get('run_live')?.projection.lastSeq).toBe(4);
    // It ends; its live store last showed the instruction still waiting.
    server = projectionOf(runStatus, last, 9);
    await f.rerender({ list: [summary('run_live', runStatus)], drawn: ['run_live'] });
    expect(fixture.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.last().records.get('run_live')?.projection.directives.directive_a?.status).toBe(
      last,
    );
  });
}

it('a run gone from a read list is read as ended, so its instruction does not stay unknown', async () => {
  const f = await mount({ list: [], listed: true, drawn: ['run_gone'] });
  expect(fixture.getSnapshot.mock.calls).toEqual([['run_gone']]);
  expect(f.last().records.get('run_gone')?.projection.status).toBe('succeeded');
});

it('a read record not newer than the live store’s last does not replace it', async () => {
  fixture.store.setState({
    runId: 'run_live',
    projection: projectionOf('running', 'delivered', 8),
  });
  fixture.getSnapshot.mockImplementation(async () => ({
    projection: projectionOf('succeeded', 'queued', 5),
  }));
  const f = await mount({ list: [summary('run_live', 'running')], drawn: ['run_live'] });
  await f.rerender({ list: [summary('run_live', 'succeeded')], drawn: ['run_live'] });
  expect(f.last().records.get('run_live')?.projection.lastSeq).toBe(8);
});

it('a read that comes back with the run still going is not kept as its ended record', async () => {
  fixture.getSnapshot.mockImplementation(async () => ({
    projection: projectionOf('running', 'queued', 2),
  }));
  const f = await mount({ list: [summary('run_live', 'succeeded')], drawn: ['run_live'] });
  expect(f.last().records.has('run_live')).toBe(false);
});

function fakeLater() {
  const waits: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const original = recordRetry.later;
  recordRetry.later = (ms, run) => {
    const wait = { ms, run, cancelled: false };
    waits.push(wait);
    return () => {
      wait.cancelled = true;
    };
  };
  cleanup.push(() => {
    recordRetry.later = original;
  });
  return waits;
}

it('a failed read is asked again while its row is drawn, later each time, a few times', async () => {
  const waits = fakeLater();
  fixture.getSnapshot.mockRejectedValue(new Error('offline'));
  const list = [summary('run_a', 'succeeded')];
  const f = await mount({ list, drawn: ['run_a'] });
  for (let attempt = 0; attempt < RECORD_RETRY.attempts; attempt += 1) {
    const wait = waits.at(-1);
    expect(wait?.ms).toBe(RECORD_RETRY.firstMs * 2 ** attempt);
    await act(async () => wait?.run());
  }
  expect(fixture.getSnapshot).toHaveBeenCalledTimes(RECORD_RETRY.attempts + 1);
  // No more after the last; the line stays as it is.
  expect(waits).toHaveLength(RECORD_RETRY.attempts);
  expect(f.last().records.has('run_a')).toBe(false);
  // Drawn again later, asked again; it comes back.
  fixture.getSnapshot.mockImplementation(async (runId: string) => ended(runId));
  await f.rerender({ list, drawn: [] });
  await f.rerender({ list, drawn: ['run_a'] });
  expect(f.last().records.get('run_a')?.projection.status).toBe('succeeded');
});

it('a row no longer drawn does not ask again', async () => {
  const waits = fakeLater();
  fixture.getSnapshot.mockRejectedValueOnce(new Error('offline'));
  const list = [summary('run_a', 'succeeded')];
  const f = await mount({ list, drawn: ['run_a'] });
  expect(waits).toHaveLength(1);
  await f.rerender({ list, drawn: [] });
  expect(waits.map((wait) => wait.cancelled)).toEqual([true]);
});

it('an ended run keeps only what its meta lines read', async () => {
  const projection = projectionOf('succeeded', 'delivered', 9);
  projection.directives.directive_a = {
    ...steerAt('delivered'),
    delivery: 'interrupt',
    modelCallId: 'call_2',
  } as DirectiveView;
  projection.executionOrder = ['exec_other', 'exec_a'];
  projection.executions = {
    exec_a: { executionId: 'exec_a', nodeId: 'writer', status: 'succeeded' },
    exec_other: { executionId: 'exec_other', nodeId: 'reviewer', status: 'succeeded' },
  } as unknown as typeof projection.executions;
  projection.modelCalls = {
    call_1: { modelCallId: 'call_1', executionId: 'exec_a', interrupted: true },
    call_2: { modelCallId: 'call_2', executionId: 'exec_a' },
    call_3: { modelCallId: 'call_3', executionId: 'exec_other' },
  } as unknown as typeof projection.modelCalls;
  fixture.getSnapshot.mockImplementation(async () => ({ projection }));
  fixture.getRunDefinition.mockImplementation(
    async () =>
      ({
        nodes: [
          { id: 'writer', type: 'agent', label: 'Writer', instructions: 'long' },
          { id: 'reviewer', type: 'agent', label: 'Reviewer' },
        ],
      }) as never,
  );
  const f = await mount({ list: [summary('run_live', 'succeeded')], drawn: ['run_live'] });
  const kept = f.last().records.get('run_live');
  expect(Object.keys(kept?.projection.executions ?? {})).toEqual(['exec_a']);
  expect(Object.keys(kept?.projection.modelCalls ?? {})).toEqual(['call_1', 'call_2']);
  expect(kept?.projection.directives.directive_a?.status).toBe('delivered');
  expect(kept?.definition?.nodes).toEqual([{ id: 'writer', type: 'agent', label: 'Writer' }]);
});
