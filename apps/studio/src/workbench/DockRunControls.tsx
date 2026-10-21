import { pendingInteractions } from '@corral/core';
import { RunActions, StatusBadge } from '@corral/react';
import { Button } from '@corral/react/ui';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';

/** The active run stays reachable even while a historical result or document has focus. */
export function DockRunControls({
  runId,
  onOpen,
}: {
  runId: string;
  onOpen: (runId: string) => void;
}) {
  const t = useTranslations('Docking');
  const { runFor, retainRun } = useServices();
  const session = runFor(runId);
  const projection = useStore(session, (state) => state.projection);
  const events = useStore(session, (state) => state.events);
  const error = useStore(session, (state) => state.streamError);
  useEffect(() => {
    const release = retainRun(runId);
    void session.getState().open(runId);
    return release;
  }, [session, runId, retainRun]);
  const waiting = pendingInteractions(events, projection).length;
  return (
    <section aria-label={t('activeRun')} className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        data-testid="dock-open-active-run"
        onClick={() => onOpen(runId)}
      >
        {waiting ? t('pendingActions', { count: waiting }) : t('openActiveRun')}
      </Button>
      {projection ? <StatusBadge status={projection.status} /> : null}
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {t('runDisconnected')}
        </span>
      ) : null}
      <RunActions session={session} compact />
    </section>
  );
}
