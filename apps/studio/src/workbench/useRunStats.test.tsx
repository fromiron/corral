// @vitest-environment jsdom
import type { RunStats } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunStatsState, useRunStats } from './useRunStats.ts';

type Props = { on: boolean; revision: number };
type Transport = Parameters<typeof useRunStats>[0];
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(() => unmount());
});

/** Mounts the hook and returns what it last returned, plus a way to change its inputs. */
function renderHook(transport: Transport, initial: Props) {
  const result: { current: RunStatsState } = { current: { status: 'off' } };
  function Probe(props: Props) {
    result.current = useRunStats(transport, props.on, 'team', props.revision);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(() => root.unmount());
  act(() => root.render(<Probe {...initial} />));
  return { result, rerender: (props: Props) => act(() => root.render(<Probe {...props} />)) };
}

async function waitFor(check: () => void) {
  for (let i = 0; ; i++) {
    try {
      check();
      return;
    } catch (error) {
      if (i > 50) throw error;
      await act(async () => new Promise((done) => setTimeout(done, 2)));
    }
  }
}

// When the editor reads run stats (docs/specs/features/run-stats.md, items 5–7).

const statsFor = (revision: number): RunStats => ({
  corralId: 'team',
  definitionRevision: revision,
  runs: [],
  totalOutputTokens: 0,
  nodes: {},
});

describe('useRunStats', () => {
  it('reads nothing while off, then the saved revision when turned on', async () => {
    const getRunStats = vi.fn(async (_corralId: string, revision: number) => statsFor(revision));
    const { result, rerender } = renderHook({ getRunStats }, { on: false, revision: 3 });
    expect(result.current).toEqual({ status: 'off' });
    expect(getRunStats).not.toHaveBeenCalled();

    rerender({ on: true, revision: 3 });
    expect(result.current).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', stats: statsFor(3) }));
    expect(getRunStats).toHaveBeenCalledWith('team', 3);
  });

  it('reads again for a new revision and when turned off and on, not on other renders', async () => {
    const getRunStats = vi.fn(async (_corralId: string, revision: number) => statsFor(revision));
    const { result, rerender } = renderHook({ getRunStats }, { on: true, revision: 3 });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ on: true, revision: 3 });
    expect(getRunStats).toHaveBeenCalledTimes(1);

    rerender({ on: true, revision: 4 });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', stats: statsFor(4) }));
    rerender({ on: false, revision: 4 });
    expect(result.current).toEqual({ status: 'off' });
    rerender({ on: true, revision: 4 });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getRunStats).toHaveBeenCalledTimes(3);
  });

  it('drops an answer for a revision that is no longer open', async () => {
    let answerOld: (stats: RunStats) => void = () => {};
    const getRunStats = vi.fn((_corralId: string, revision: number) =>
      revision === 3
        ? new Promise<RunStats>((resolve) => {
            answerOld = resolve;
          })
        : Promise.resolve(statsFor(revision)),
    );
    const { result, rerender } = renderHook({ getRunStats }, { on: true, revision: 3 });
    rerender({ on: true, revision: 4 });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', stats: statsFor(4) }));
    await act(async () => answerOld(statsFor(3)));
    expect(result.current).toEqual({ status: 'ready', stats: statsFor(4) });
  });

  it('reports a failed read', async () => {
    const getRunStats = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook({ getRunStats }, { on: true, revision: 3 });
    await waitFor(() => expect(result.current).toEqual({ status: 'failed' }));
  });
});
