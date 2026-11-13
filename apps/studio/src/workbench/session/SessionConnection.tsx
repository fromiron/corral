import { createContext, useContext } from 'react';

/**
 * The session page's link to the server. When it is lost, run states are unknown (not assumed
 * finished or cancelled). The composer's activity bar says so; nothing is inserted into the
 * timeline (docs/specs/features/composer-flow.md, "튐 없는 본문" rule 5).
 */
export interface SessionConnection {
  /** The server cannot be reached, so the run states shown may be stale. */
  lost: boolean;
  /** Reads the session's runs again. */
  retry: () => void;
}

export const SessionConnectionContext = createContext<SessionConnection | null>(null);

export function useSessionConnection() {
  return useContext(SessionConnectionContext);
}
