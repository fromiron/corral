import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore, SessionCommand } from '../run/session.ts';
import { Button } from '../ui/button.tsx';
import { CommandReceipts } from './CommandReceipts.tsx';

/** Whole-run Pause/Resume and Cancel. `compact` drops the explanations (the Run page header). */
export function RunActions({
  session,
  compact = false,
  showCancel = true,
}: {
  session: RunSessionStore;
  compact?: boolean;
  /** A composer with its existing stop control only needs Pause/Resume and receipts here. */
  showCancel?: boolean;
}) {
  const t = useTranslations('Reins');
  const projection = useStore(session, (s) => s.projection);
  const pending = useStore(session, (s) => s.pendingCommandIds.length > 0);
  // The run the confirmation was opened for (CR-046 P18): a view that follows another run
  // drops it, so confirming can never cancel a run the person did not choose.
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const shownRun = projection?.runId ?? null;
  useEffect(() => {
    setConfirmCancel((open) => (open === shownRun ? open : null));
  }, [shownRun]);
  if (!projection) return null;
  const terminal = TERMINAL_RUN_STATUSES.has(projection.status);
  // A finished run in the page header has no controls: only its receipts, if any.
  if (compact && terminal) {
    return <CommandReceipts session={session} target={`run:${projection.runId}`} />;
  }
  const send = (command: SessionCommand) => {
    void session
      .getState()
      .sendCommand(command)
      .catch(() => undefined);
  };
  return (
    <section
      aria-label={t('runControls')}
      className={`flex flex-col gap-2 text-xs ${compact ? '' : 'rounded-lg fill-group p-3'}`}
    >
      {compact ? null : (
        <>
          <p>{t('runScope', { runId: projection.runId })}</p>
          <p className="text-muted">{t('safeBoundary')}</p>
        </>
      )}
      {!terminal ? (
        <div className="flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="xs"
            disabled={
              pending || projection.status === 'pausing' || projection.status === 'cancelling'
            }
            onClick={() =>
              send({
                type: projection.status === 'paused' ? 'resume' : 'pause',
                payload: { scope: 'run' },
              })
            }
          >
            {projection.status === 'paused' ? t('resume') : t('pause')}
          </Button>
          {showCancel ? (
            <Button
              variant="ghost-destructive"
              size="xs"
              disabled={pending || projection.status === 'cancelling'}
              onClick={() => setConfirmCancel(projection.runId)}
            >
              {t('cancelRun')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {showCancel && confirmCancel === projection.runId && !terminal ? (
        <div className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
          <p>{t('cancelRunExplain')}</p>
          <div className="flex flex-wrap gap-1">
            <Button
              variant="destructive"
              size="xs"
              disabled={pending}
              onClick={() => {
                const chosen = confirmCancel;
                setConfirmCancel(null);
                if (session.getState().runId !== chosen) return;
                send({
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
                });
              }}
            >
              {t('confirmCancelRun')}
            </Button>
            <Button variant="outline" size="xs" onClick={() => setConfirmCancel(null)}>
              {t('keepRunning')}
            </Button>
          </div>
        </div>
      ) : null}
      <CommandReceipts session={session} target={`run:${projection.runId}`} />
    </section>
  );
}
