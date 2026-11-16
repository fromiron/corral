// @vitest-environment jsdom
import type { RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionRuns } from './useSessionRuns.ts';

const fixture = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getSession: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));
const services = {
  transport: { listRuns: fixture.listRuns },
  repository: { getSession: fixture.getSession },
};
const router = { invalidate: fixture.invalidate };
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('discovers another tab’s new request from idle and revalidates changed session entries', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let revision = 1;
  const entries: unknown[] = [];
  let runs: RunSummary[] = [];
  fixture.listRuns.mockImplementation(async () => runs);
  fixture.getSession.mockImplementation(async () => ({ revision, entries }));
  function View() {
    const value = useSessionRuns('session', undefined, 1, []);
    return (
      <p>
        {value.runs.map((run) => run.runId).join(',')}:{value.lost ? 'lost' : 'connected'}
      </p>
    );
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<View />));
  expect(container.textContent).toBe(':connected');
  revision = 2;
  runs = [
    {
      runId: 'remote',
      sessionId: 'session',
      status: 'succeeded',
      startedAt: '2026-10-29T00:00:00Z',
    } as RunSummary,
  ];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(container.textContent).toBe('remote:connected');
  expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  fixture.listRuns.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.textContent).toBe('remote:lost');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(container.textContent).toBe('remote:connected');
  revision = 3;
  fixture.invalidate.mockRejectedValueOnce(new Error('Loader went offline'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.textContent).toBe('remote:lost');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(fixture.invalidate).toHaveBeenCalledTimes(3);
  expect(container.textContent).toBe('remote:connected');
});

// A named session's subsequent requests do not change its settings revision.
it('refreshes appended and settled entries with unchanged revision and timestamp', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const initial = { revision: 3, updatedAt: 'same-clock-tick', entries: [] };
  let session: unknown = initial;
  fixture.listRuns.mockResolvedValue([]);
  fixture.getSession.mockImplementation(async () => session);
  function View() {
    useSessionRuns('named', undefined, initial.revision, initial.entries);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<View />));
  expect(fixture.invalidate).not.toHaveBeenCalled();
  session = { ...initial, entries: [{ entryId: 'second', state: 'queued' }] };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  session = { ...initial, entries: [{ entryId: 'second', state: 'started', runId: 'new' }] };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(2);
});

// A meta line holding an instruction seen to expire waits for a session read asked after it
// (features/composer-flow.md "보낸 메시지의 메타 줄"). A read that found the session changed
// counts once the page shows what it found, not while the page still shows the session before.
it('a read that changed the session counts once the page shows that session', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const before = { revision: 1, entries: [] };
  const after = { revision: 1, entries: [{ entryId: 'carried', state: 'started' }] };
  let session: unknown = before;
  fixture.listRuns.mockResolvedValue([]);
  fixture.getSession.mockImplementation(async () => session);
  const reads: number[] = [];
  function View({ shown }: { shown: typeof before | typeof after }) {
    const value = useSessionRuns('carry', undefined, shown.revision, shown.entries as never);
    reads.push(value.sessionReads.read);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<View shown={before} />));
  const unchanged = reads.at(-1) as number;
  expect(unchanged).toBeGreaterThan(0);
  // The server saved the carried request; the router has not loaded it yet.
  session = after;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  expect(reads.at(-1)).toBe(unchanged);
  // The page now shows what that read found.
  await act(async () => root.render(<View shown={after} />));
  expect(reads.at(-1)).toBeGreaterThan(unchanged);
});

it('does not count a listing asked before it subscribed as the answer after the entry, and asks for one at once', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const run = (runId: string, startedAt: string) =>
    ({ runId, sessionId: 'session', status: 'succeeded', startedAt }) as RunSummary;
  const first = run('first', '2026-10-29T00:00:00Z');
  let runs: RunSummary[] = [first];
  fixture.listRuns.mockImplementation(async () => runs);
  fixture.getSession.mockImplementation(async () => ({ revision: 1, entries: [] }));
  function View({ id }: { id: string }) {
    const value = useSessionRuns(id, undefined, 1, []);
    return (
      <p>
        {value.runs.map((r) => r.runId).join(',')}:{value.listed ? 'listed' : 'waiting'}
      </p>
    );
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  // Another consumer of the same list keeps it alive (the sidebar).
  const other = document.createElement('div');
  const otherRoot = createRoot(other);
  disposals.push(async () => {
    await act(async () => otherRoot.unmount());
  });
  await act(async () => otherRoot.render(<View id="elsewhere" />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // The conversation is entered between two listings; the run list then changes.
  runs = [first, run('second', '2026-10-29T00:01:00Z')];
  await act(async () => root.render(<View id="session" />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // The repeated answer is not the answer after the entry: the conversation asks for one at
  // once instead of waiting for the next listing on the clock.
  expect(fixture.listRuns).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(container.textContent).toBe('first,second:listed');
});

it('a listing already on its way when the conversation is entered is not its answer: it lists once more after it, and only then counts', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const run = (runId: string, startedAt: string) =>
    ({ runId, sessionId: 'session', status: 'succeeded', startedAt }) as RunSummary;
  const first = run('first', '2026-10-29T00:00:00Z');
  const second = run('second', '2026-10-29T00:01:00Z');
  // Each listing waits until the test answers it.
  const answers: ((runs: RunSummary[]) => void)[] = [];
  fixture.listRuns.mockImplementation(
    () =>
      new Promise<RunSummary[]>((resolve) => {
        answers.push(resolve);
      }),
  );
  fixture.getSession.mockImplementation(async () => ({ revision: 1, entries: [] }));
  function View({ id }: { id: string }) {
    const value = useSessionRuns(id, undefined, 1, []);
    return (
      <p>
        {value.runs.map((r) => r.runId).join(',')}:{value.listed ? 'listed' : 'waiting'}
      </p>
    );
  }
  // Another consumer keeps the list alive; its first listing is on its way.
  const other = createRoot(document.createElement('div'));
  disposals.push(async () => {
    await act(async () => other.unmount());
  });
  await act(async () => other.render(<View id="elsewhere" />));
  expect(fixture.listRuns).toHaveBeenCalledTimes(1);

  const container = document.createElement('div');
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<View id="session" />));
  // The listing asked before the entry answers, with what it found then.
  await act(async () => {
    answers[0]?.([first]);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(container.textContent).toBe('first:waiting');
  // One listing more, asked after the entry; it is the answer.
  expect(fixture.listRuns).toHaveBeenCalledTimes(2);
  await act(async () => {
    answers[1]?.([first, second]);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(container.textContent).toBe('first,second:listed');
  expect(fixture.listRuns).toHaveBeenCalledTimes(2);
});

it('a conversation entered again faster than one listing is not listed with the earlier list', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const answers: ((runs: RunSummary[]) => void)[] = [];
  fixture.listRuns.mockImplementation(
    () =>
      new Promise<RunSummary[]>((resolve) => {
        answers.push(resolve);
      }),
  );
  fixture.getSession.mockImplementation(async () => ({ revision: 1, entries: [] }));
  const shown: string[] = [];
  function View({ id }: { id: string }) {
    const value = useSessionRuns(id, undefined, 1, []);
    shown.push(`${id}:${value.listed ? 'listed' : 'waiting'}`);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<View id="a" />));
  await act(async () => {
    answers[0]?.([]);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(shown.at(-1)).toBe('a:listed');
  // To B and straight back to A, before any listing answers.
  await act(async () => root.render(<View id="b" />));
  shown.length = 0;
  await act(async () => root.render(<View id="a" />));
  expect(shown.filter((value) => value === 'a:listed')).toEqual([]);
});
