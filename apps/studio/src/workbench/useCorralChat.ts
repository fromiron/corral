import { createRunSession } from '@corral/react';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { readRunView } from './readRunView.ts';

/** Reading another turn must not replace the active run's command/retry state. */
export function useCorralRun(runId: string, live: boolean, details: boolean) {
  const { transport, readHistory } = useServices();
  const store = useMemo(() => {
    void runId;
    return createRunSession(transport);
  }, [transport, runId]);
  const readDetails = !live && details;
  useEffect(() => {
    let current = true;
    if (live) void store.getState().open(runId);
    else
      void readRunView(transport, readHistory, runId, readDetails).then(
        (view) => {
          if (current)
            store.setState({
              ...view,
              artifactTexts: { ...store.getState().artifactTexts, ...view.artifactTexts },
            });
        },
        (error: unknown) => {
          if (current)
            store.setState({ streamError: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      current = false;
      store.getState().dispose();
    };
  }, [store, runId, transport, readHistory, live, readDetails]);
  const state = useStore(store);
  return { store, state };
}
