import type { RunStatus } from '@corral/contracts';
import { pendingInteractions, type RunSummary } from '@corral/core';
import { RunActions } from '@corral/react';
import {
  AgentStatusPill,
  type AgentStatusPillState,
  Button,
  formatClock,
  Tooltip,
} from '@corral/react/design-kit';
import { Bot } from '@corral/react/icons';
import { useEffect, useId } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';

/** The pill's colour and glyph; only actual active work breathes. */
function pillState(status: RunStatus, waiting: boolean): AgentStatusPillState {
  if (waiting || status === 'awaiting_user') return 'waiting';
  if (status === 'paused' || status === 'pausing') return 'paused';
  if (status === 'succeeded') return 'done';
  if (status === 'failed' || status === 'interrupted') return 'failed';
  if (status === 'cancelled' || status === 'cancelling') return 'stopped';
  return 'running';
}

/**
 * The active run's one place in the top bar: the kit status pill with its state, run number and
 * clock, opening its record (or its response area while it waits), and Pause/Resume/Cancel beside
 * it through the existing RunActions confirmation. It stays reachable while a historical result
 * or document has focus. The breadcrumb names the session; the request this run answers is the
 * pill's accessible name and tooltip (#72).
 */
export function DockRunControls({
  runId,
  runs,
  request,
  viewingOther = false,
  onOpen,
}: {
  runId: string;
  /** The session's runs, oldest first: the pill shows this run's number among them. */
  runs: readonly RunSummary[];
  /** The request that started the run, so the controls say which run they act on (#72). */
  request?: string;
  /** A different, finished run is on screen; the controls still act on this one. */
  viewingOther?: boolean;
  /** Opens this run in the session's run view, where its record and response area are. */
  onOpen: (runId: string) => void;
}) {
  const t = useTranslations('Docking');
  const tw = useTranslations('Workbench');
  const ts = useTranslations('Status');
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
  const startedAt = projection?.startedAt ?? events[0]?.recordedAt ?? null;
  const target = request ? t('activeRunTarget', { request }) : undefined;
  const number = runs.findIndex((run) => run.runId === runId) + 1;
  const runLabel = number ? tw('runNumber', { number }) : undefined;
  const statusLabel = projection
    ? ts.has(projection.status)
      ? ts(projection.status)
      : projection.status
    : '';
  // While the run waits for the person, the pill is the way to its response area.
  const label = waiting ? t('checkNow', { count: waiting }) : statusLabel;
  const accessibleName = (elapsed?: number) =>
    [
      runLabel ? `${label} · ${runLabel}` : label,
      target,
      elapsed === undefined ? null : t('runElapsed', { time: formatClock(elapsed) }),
      waiting ? null : t('openActiveRun'),
    ]
      .filter(Boolean)
      .join('. ');
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
        <span data-testid="active-run-status" className="contents">
          <Tooltip content={target ?? t('activeRun')}>
            <AgentStatusPill
              data-testid="dock-open-active-run"
              // In a narrow bar the pill gives up its words first.
              className="min-w-0"
              size="compact"
              name={t('activeRun')}
              logo={Bot}
              state={pillState(projection.status, waiting > 0)}
              label={label}
              detail={runLabel}
              startedAt={startedAt ? Date.parse(startedAt) : undefined}
              endedAt={projection.endedAt ? Date.parse(projection.endedAt) : undefined}
              // The composer's region announces the run; the pill stays silent.
              announce={false}
              // The pill navigates, with no fold-out panel; no steps, progress or inline
              // approval are passed.
              onActivate={() => onOpen(runId)}
              labels={{
                paused: (value) => value,
                toggle: ({ elapsed }) => accessibleName(elapsed),
              }}
            />
          </Tooltip>
        </span>
      ) : (
        <Button
          variant="ghost"
          size="compact"
          data-testid="dock-open-active-run"
          onClick={() => onOpen(runId)}
        >
          {t('openActiveRun')}
        </Button>
      )}
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
      <div className="shrink-0">
        <RunActions session={session} compact narrowIcons />
      </div>
    </section>
  );
}
