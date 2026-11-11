import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Pause, Play, Square } from '../design-kit/icons.ts';
import { Button, Popover, PopoverPopup, PopoverTrigger, Tooltip } from '../design-kit/index.ts';
import { useCancelConfirmation } from '../run/cancel-confirmation.ts';
import type { RunSessionStore, SessionCommand } from '../run/session.ts';
import { CommandReceipts } from './CommandReceipts.tsx';

/** Whole-run Pause/Resume and Cancel. `compact` drops the explanations (the Run page header). */
export function RunActions({
  session,
  compact = false,
  showCancel = true,
  narrowIcons = false,
}: {
  session: RunSessionStore;
  compact?: boolean;
  /** A composer with its existing stop control only needs Pause/Resume and receipts here. */
  showCancel?: boolean;
  /**
   * The host's bar is too narrow for words: Pause/Resume and Cancel show only their icons.
   * Their words stay their accessible names and become their tooltips.
   */
  narrowIcons?: boolean;
}) {
  const t = useTranslations('Reins');
  /** A control's words; in a narrow bar its icon stands in and the words stay its name. */
  const label = (icon: ReactNode, words: string) =>
    narrowIcons ? (
      <>
        {icon}
        <span data-run-action-label="" className="sr-only">
          {words}
        </span>
      </>
    ) : (
      words
    );
  // As icons they sit among the bar's other icon buttons and take their look.
  const size = narrowIcons ? 'icon-compact' : 'compact';
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
    return <CommandReceipts session={session} target={`run:${projection.runId}`} openOnly />;
  }
  const send = (command: SessionCommand) => {
    void session
      .getState()
      .sendCommand(command)
      .catch(() => undefined);
  };
  const confirming = showCancel && confirmCancel && !terminal;
  const confirmation = (
    <div
      className={
        compact
          ? 'flex max-w-72 flex-col gap-2 text-caption'
          : 'flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3'
      }
    >
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
  );
  const cancelButton = (
    <Button
      variant="ghost-destructive"
      size={size}
      disabled={pending || projection.status === 'cancelling'}
      onClick={() => setConfirmCancel(true)}
    >
      {label(<Square aria-hidden="true" />, t('cancelRun'))}
    </Button>
  );
  const pauseWords = projection.status === 'paused' ? t('resume') : t('pause');
  return (
    <section
      aria-label={t('runControls')}
      // In a bar, an empty receipts region adds no gap below the buttons: they stay centred.
      className={`flex flex-col gap-2 text-caption ${compact ? 'has-[>[aria-live]:empty]:gap-0' : 'rounded-lg fill-group p-3'}`}
    >
      {compact ? null : (
        <>
          <p>{t('runScope', { runId: projection.runId })}</p>
          <p className="text-muted-foreground">{t('safeBoundary')}</p>
        </>
      )}
      {!terminal ? (
        <div className="flex flex-wrap gap-1">
          <Tooltip content={pauseWords} forceOpen={narrowIcons ? undefined : false}>
            <Button
              variant={narrowIcons ? 'ghost' : 'tertiary'}
              size={size}
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
              {label(
                projection.status === 'paused' ? (
                  <Play aria-hidden="true" />
                ) : (
                  <Pause aria-hidden="true" />
                ),
                pauseWords,
              )}
            </Button>
          </Tooltip>
          {showCancel && compact ? (
            // In a one-line bar the confirmation opens beside the button instead of growing the bar.
            <Popover open={confirming} onOpenChange={setConfirmCancel}>
              <Tooltip
                content={t('cancelRun')}
                forceOpen={narrowIcons && !confirming ? undefined : false}
              >
                <PopoverTrigger render={cancelButton} />
              </Tooltip>
              <PopoverPopup align="end" side="bottom" width="sm" aria-label={t('cancelRun')}>
                {confirmation}
              </PopoverPopup>
            </Popover>
          ) : showCancel ? (
            cancelButton
          ) : null}
        </div>
      ) : null}
      {!compact && confirming ? confirmation : null}
      <CommandReceipts session={session} target={`run:${projection.runId}`} openOnly />
    </section>
  );
}
