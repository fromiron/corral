import { createRunSession } from '@corral/react';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { readRunView } from './readRunView.ts';

/** Reading another turn must not replace the active run's command/retry state. */
export function useCorralRun(runId: string, live: boolean, details: boolean) {
  const { transport, readHistory, runFor, retainRun } = useServices();
  const own = useMemo(() => {
    void runId;
    return createRunSession(transport);
  }, [transport, runId]);
  // WorkTab owns the live store and its transport. A card may mount before that owner's
  // open() resolves; starting an independent subscription during that gap duplicates it.
  const store = live ? runFor(runId) : own;
  const readDetails = !live && details;
  const state = useStore(store);
  const last = useRef<{ runId: string; store: typeof store; state: typeof state } | null>(null);
  useEffect(() => {
    if (live) {
      const release = retainRun(runId);
      void store.getState().open(runId);
      return release;
    }
    let current = true;
    void readRunView(transport, readHistory, runId, readDetails).then(
      (view) => {
        if (current)
          own.setState({
            ...view,
            // Result texts are per version and immutable: keep what the live view already
            // read, so a finishing turn does not blank its answer while reading it again.
            artifactTexts: {
              ...(last.current?.runId === runId ? last.current.state.artifactTexts : {}),
              ...own.getState().artifactTexts,
              ...view.artifactTexts,
            },
          });
      },
      (error: unknown) => {
        if (current)
          own.setState({
            runId,
            streamError: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      current = false;
      own.getState().dispose();
    };
  }, [own, store, runId, transport, readHistory, live, readDetails, retainRun]);
  useEffect(() => () => own.getState().dispose(), [own]);
  const current = state.runId === runId ? state : null;
  // A finishing turn swaps the live store for a finished snapshot that loads asynchronously.
  // Keep the last loaded view of this run meanwhile, so its work log stays mounted.
  if (current?.projection) last.current = { runId, store, state: current };
  const kept = last.current;
  if (!current?.projection && !current?.streamError && kept?.runId === runId)
    return { store: kept.store, state: kept.state };
  return {
    store,
    state: current ?? { ...state, projection: null, definition: null, streamError: null },
  };
}
