import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { canonicalJson, type RunSummary, type SessionEntry } from '@corral/core';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '../services.tsx';
import { watchRunList } from './runList.ts';

/** Discover remote requests even while this tab has no active run. */
export function useSessionRuns(
  sessionId: string,
  selectedRunId: string | undefined,
  revision: number,
  entries: readonly SessionEntry[],
) {
  const { transport, repository } = useServices();
  const router = useRouter();
  const [all, setAll] = useState<RunSummary[]>([]);
  const [lost, setLost] = useState(false);
  // The selection the last answered listing was asked for: a run requested after it may be too
  // new to be listed yet.
  const [listedFor, setListedFor] = useState<string | null>(null);
  const request = `${sessionId}:${selectedRunId ?? ''}`;
  const refreshRead = useRef(() => {});
  const refresh = useCallback(() => refreshRead.current(), []);
  const persistedState = canonicalJson([revision, entries]);
  useEffect(() => {
    void selectedRunId;
    const asked = request;
    let knownState = persistedState;
    const watcher = watchRunList(transport, async (result, current) => {
      try {
        if ('error' in result) throw result.error;
        const { runs } = result;
        const session = await repository.getSession(sessionId);
        if (!current()) return;
        const nextState = session ? canonicalJson([session.revision, session.entries]) : null;
        if (nextState && nextState !== knownState) {
          await router.invalidate();
          if (current()) knownState = nextState;
        }
        // Publish run transitions after their request records are revalidated.
        if (!current()) return;
        setAll(runs);
        setListedFor(asked);
        setLost(false);
      } catch {
        if (current()) setLost(true);
      }
    });
    refreshRead.current = watcher.refresh;
    return watcher.dispose;
  }, [transport, repository, router, sessionId, selectedRunId, persistedState, request]);
  const runs = all
    .filter((run) => run.sessionId === sessionId)
    .reverse()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const active = runs.findLast((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? null;
  return { runs, active, refresh, lost, listed: listedFor === request };
}
