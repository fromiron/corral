import type { RuntimeTransport } from '@corral/core';
import { createRunSession, type RunRecovery, type RunSessionStore } from '@corral/react';

/** Each services instance belongs to one host transport. Never retarget a run's store. */
export function createRunSessions(transport: RuntimeTransport, recovery?: RunRecovery) {
  const runs = new Map<string, RunSessionStore>();
  const drafts = new Map<string, RunSessionStore>();
  const references = new Map<string, number>();
  // Told when a run starts or stops being followed. After the change, never inside a render.
  const watchers = new Set<() => void>();
  const changed = () =>
    queueMicrotask(() => {
      for (const watcher of [...watchers]) watcher();
    });
  return {
    runFor(runId: string) {
      let store = runs.get(runId);
      if (!store) {
        store = createRunSession(transport, undefined, recovery);
        runs.set(runId, store);
      }
      return store;
    },
    sessionFor(sessionId: string) {
      let store = drafts.get(sessionId);
      if (!store) {
        store = createRunSession(transport, undefined, recovery);
        drafts.set(sessionId, store);
      }
      return store;
    },
    /**
     * The run's store while a view follows it (retained), so its state is the run's own and live;
     * null otherwise: a store no view holds any more stopped following its run and may be stale.
     */
    liveRun(runId: string): RunSessionStore | null {
      return references.has(runId) ? (runs.get(runId) ?? null) : null;
    },
    /** Calls `listener` after a run starts or stops being followed; returns the way to stop. */
    watchRuns(listener: () => void) {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
    retainRun(runId: string) {
      const first = !references.has(runId);
      references.set(runId, (references.get(runId) ?? 0) + 1);
      if (first) changed();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (references.get(runId) ?? 1) - 1;
        if (remaining > 0) references.set(runId, remaining);
        else {
          references.delete(runId);
          const store = runs.get(runId);
          // React moves a view by releasing and retaining it in the same commit.
          queueMicrotask(() => {
            if (!references.has(runId) && runs.get(runId) === store) store?.getState().dispose();
          });
          changed();
        }
      };
    },
    dispose() {
      for (const store of [...runs.values(), ...drafts.values()]) store.getState().dispose();
      runs.clear();
      drafts.clear();
      references.clear();
      watchers.clear();
    },
  };
}
