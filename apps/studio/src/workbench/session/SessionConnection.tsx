import { Button } from '@corral/react/design-kit';
import { createContext, useContext } from 'react';
import { useTranslations } from 'use-intl';

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

/**
 * One line at the top of the composer surface, where the activity bar will say the same; it
 * stays until then so the lost connection is never silent.
 */
export function ConnectionNotice() {
  const ts = useTranslations('Sessions');
  const connection = useSessionConnection();
  if (!connection?.lost) return null;
  return (
    <div
      role="alert"
      data-testid="connection-lost"
      className="flex min-w-0 items-center gap-2 px-2 pb-1 text-caption text-danger"
    >
      <span className="min-w-0 truncate" title={ts('connectionLost')}>
        {ts('connectionLost')}
      </span>
      <Button variant="tertiary" size="compact" onClick={connection.retry}>
        {ts('retry')}
      </Button>
    </div>
  );
}
