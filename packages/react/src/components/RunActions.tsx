import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore, SessionCommand } from '../run/session.ts';
import { CommandReceipts } from './CommandReceipts.tsx';

/** Whole-run Pause/Resume and Cancel. `compact` drops the explanations (the Run page header). */
export function RunActions({
  session,
  compact = false,
}: {
  session: RunSessionStore;
  compact?: boolean;
}) {
  const t = useTranslations('Reins');
  const projection = useStore(session, (s) => s.projection);
  const pending = useStore(session, (s) => s.pendingCommandIds.length > 0);
  const [confirmCancel, setConfirmCancel] = useState(false);
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
      className="flex flex-col gap-2 rounded border border-line p-2 text-xs"
    >
      {compact ? null : (
        <>
          <p>{t('runScope', { runId: projection.runId })}</p>
          <p className="text-muted">{t('safeBoundary')}</p>
        </>
      )}
      {!terminal ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded border border-line px-2 py-1"
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
          </button>
          <button
            type="button"
            className="rounded border border-danger px-2 py-1 text-danger"
            disabled={pending || projection.status === 'cancelling'}
            onClick={() => setConfirmCancel(true)}
          >
            {t('cancelRun')}
          </button>
        </div>
      ) : null}
      {confirmCancel && !terminal ? (
        <div className="flex flex-col gap-2 rounded border border-danger p-2">
          <p>{t('cancelRunExplain')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              className="rounded border border-danger px-2 py-1 text-danger"
              onClick={() => {
                setConfirmCancel(false);
                send({
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
                });
              }}
            >
              {t('confirmCancelRun')}
            </button>
            <button
              type="button"
              className="rounded border border-line px-2 py-1"
              onClick={() => setConfirmCancel(false)}
            >
              {t('keepRunning')}
            </button>
          </div>
        </div>
      ) : null}
      <CommandReceipts session={session} target={`run:${projection.runId}`} />
    </section>
  );
}
