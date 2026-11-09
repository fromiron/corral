import { pendingInteractions } from '@corral/core';
import { AgentStatusText, RunActions } from '@corral/react';
import { Button, formatClock, Tooltip, useNow } from '@corral/react/design-kit';
import { useEffect, useId } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';

/**
 * The active run's one place in the top bar: its status and elapsed time, the way into its record,
 * and Pause/Resume/Cancel. It stays reachable while a historical result or document has focus.
 * The breadcrumb already names the session; the request this run answers is the controls'
 * description and the status tooltip, so the bar does not repeat it as text (#72).
 */
export function DockRunControls({
  runId,
  request,
  viewingOther = false,
  onOpen,
}: {
  runId: string;
  /** The request that started the run, so the controls say which run they act on (#72). */
  request?: string;
  /** A different, finished run is on screen; the controls still act on this one. */
  viewingOther?: boolean;
  onOpen: (runId: string) => void;
}) {
  const t = useTranslations('Docking');
  const { runFor, retainRun } = useServices();
  const session = runFor(runId);
  const projection = useStore(session, (state) => state.projection);
  const events = useStore(session, (state) => state.events);
  const error = useStore(session, (state) => state.streamError);
  const describedBy = useId();
  useEffect(() => {
    const release = retainRun(runId);
    void session.getState().open(runId);
    return release;
  }, [session, runId, retainRun]);
  const waiting = pendingInteractions(events, projection).length;
  const startedAt = events[0] ? Date.parse(events[0].recordedAt) : null;
  const now = useNow(1000, startedAt !== null);
  const target = request ? t('activeRunTarget', { request }) : undefined;
  return (
    <section
      aria-label={t('activeRun')}
      aria-describedby={target ? describedBy : undefined}
      className="order-first flex min-w-0 items-center gap-2"
    >
      {target ? (
        <span id={describedBy} className="sr-only">
          {target}
        </span>
      ) : null}
      {projection ? (
        <Tooltip content={target ?? t('activeRun')}>
          <span data-testid="active-run-status" className="inline-flex items-center gap-1.5">
            <AgentStatusText kind="run" status={projection.status} />
            {startedAt !== null ? (
              <span className="text-caption text-muted-foreground tabular-nums">
                {formatClock(Math.max(0, now - startedAt))}
              </span>
            ) : null}
          </span>
        </Tooltip>
      ) : null}
      {viewingOther ? (
        <span role="note" className="sr-only">
          {t('activeRunNotViewed')}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-caption text-danger">
          {t('runDisconnected')}
        </span>
      ) : null}
      <Button
        variant={waiting ? 'secondary' : 'ghost'}
        size="compact"
        data-testid="dock-open-active-run"
        onClick={() => onOpen(runId)}
      >
        {waiting ? t('pendingActions', { count: waiting }) : t('openActiveRun')}
      </Button>
      <RunActions session={session} compact />
    </section>
  );
}
