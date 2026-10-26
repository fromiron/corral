import { createContext, type ReactNode, useContext } from 'react';
import { useStore } from 'zustand';
import type { RunSessionState, RunSessionStore } from './session.ts';

export type RunDisplaySnapshot = Pick<RunSessionState, 'projection' | 'events' | 'streams'>;
const RunDisplayContext = createContext<RunDisplaySnapshot | null>(null);

/** Display facts may come from a historical prefix; commands keep their original owner. */
export function RunDisplayProvider({
  snapshot = null,
  children,
}: {
  snapshot?: RunDisplaySnapshot | null;
  children: ReactNode;
}) {
  return <RunDisplayContext.Provider value={snapshot}>{children}</RunDisplayContext.Provider>;
}

export function useRunDisplay<T>(
  session: RunSessionStore,
  selector: (snapshot: RunDisplaySnapshot) => T,
): T {
  const snapshot = useContext(RunDisplayContext);
  return useStore(session, (state) => selector(snapshot ?? state));
}
