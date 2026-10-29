import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '../services.tsx';
import { watchRefresh } from './refresh.ts';

/** Discover remote requests even while this tab has no active run. */
export function useSessionRuns(
  sessionId: string,
  selectedRunId: string | undefined,
  revision: number,
) {
  const { transport, repository } = useServices();
  const router = useRouter();
  const [all, setAll] = useState<RunSummary[]>([]);
  const [lost, setLost] = useState(false);
  const refreshRead = useRef(() => {});
  const refresh = useCallback(() => refreshRead.current(), []);
  useEffect(() => {
    void selectedRunId;
    let knownRevision = revision;
    const watcher = watchRefresh(async (current) => {
      try {
        const [runs, session] = await Promise.all([
          transport.listRuns(),
          repository.getSession(sessionId),
        ]);
        if (!current()) return;
        setAll(runs);
        setLost(false);
        if (session && session.revision !== knownRevision) {
          await router.invalidate();
          if (current()) knownRevision = session.revision;
        }
      } catch {
        if (current()) setLost(true);
      }
    }, 1500);
    refreshRead.current = watcher.refresh;
    return watcher.dispose;
  }, [transport, repository, router, sessionId, selectedRunId, revision]);
  const runs = all
    .filter((run) => run.sessionId === sessionId)
    .reverse()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const active = runs.findLast((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? null;
  return { runs, active, refresh, lost };
}
