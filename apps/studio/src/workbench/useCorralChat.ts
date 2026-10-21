import { createRunSession } from '@corral/react';
import { useEffect, useMemo } from 'react';
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
            artifactTexts: { ...own.getState().artifactTexts, ...view.artifactTexts },
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
  const state = useStore(store);
  return {
    store,
    state:
      state.runId === runId
        ? state
        : { ...state, projection: null, definition: null, streamError: null },
  };
}
