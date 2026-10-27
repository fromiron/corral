import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button } from '../design-kit/index.ts';
import { useCancelConfirmation } from '../run/cancel-confirmation.ts';
import type { RunSessionStore, SessionCommand } from '../run/session.ts';
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
  const shownRun = projection?.runId ?? null;
  const terminal = Boolean(projection && TERMINAL_RUN_STATUSES.has(projection.status));
  const [confirmCancel, setConfirmCancel] = useCancelConfirmation(
    shownRun,
    terminal || projection?.status === 'cancelling',
  );
  if (!projection) return null;
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
          <p className="text-muted-foreground">{t('safeBoundary')}</p>
        </>
      )}
      {!terminal ? (
        <div className="flex flex-wrap gap-1">
          <Button
            variant="tertiary"
            size="compact"
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
              size="compact"
              disabled={pending || projection.status === 'cancelling'}
              onClick={() => setConfirmCancel(true)}
            >
              {t('cancelRun')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {showCancel && confirmCancel && !terminal ? (
        <div className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
          <p>{t('cancelRunExplain')}</p>
          <p role="status">{t('cancelNotSent')}</p>
          <div className="flex flex-wrap gap-1">
            <Button
              variant="destructive"
              size="compact"
              disabled={pending}
              onClick={() => {
                const chosen = shownRun;
                setConfirmCancel(false);
                if (session.getState().runId !== chosen) return;
                send({
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
                });
              }}
            >
              {t('confirmCancelRun')}
            </Button>
            <Button variant="tertiary" size="compact" onClick={() => setConfirmCancel(false)}>
              {t('keepRunning')}
            </Button>
          </div>
        </div>
      ) : null}
      <CommandReceipts session={session} target={`run:${projection.runId}`} />
    </section>
  );
}
