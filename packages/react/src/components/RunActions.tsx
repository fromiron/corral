import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Pause, Play, Square } from '../design-kit/icons.ts';
import { Button, Popover, PopoverPopup, PopoverTrigger, Tooltip } from '../design-kit/index.ts';
import { useCancelConfirmation } from '../run/cancel-confirmation.ts';
import type { RunSessionStore, SessionCommand } from '../run/session.ts';
import { CommandReceipts } from './CommandReceipts.tsx';

/** Below Tailwind's sm breakpoint, where a narrow bar shows the controls as icons. */
const NARROW = '(max-width: 639.98px)';

function useNarrow(enabled: boolean) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [enabled]);
  return enabled && narrow;
}

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
   * Below the sm breakpoint, Pause/Resume and Cancel show only their icons; their words stay
   * their accessible names and become their tooltips.
   */
  narrowIcons?: boolean;
}) {
  const t = useTranslations('Reins');
  const narrow = useNarrow(narrowIcons);
  /** A control's words; in a narrow bar its icon stands in and the words stay its name. */
  const label = (icon: ReactNode, words: string) =>
    narrowIcons ? (
      <>
        {icon}
        <span data-run-action-label="" className="max-sm:sr-only">
          {words}
        </span>
      </>
    ) : (
      words
    );
  const iconOnly = narrowIcons ? 'max-sm:w-7 max-sm:px-0' : undefined;
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
          ? 'flex max-w-72 flex-col gap-2 text-xs'
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
      size="compact"
      className={iconOnly}
      disabled={pending || projection.status === 'cancelling'}
      onClick={() => setConfirmCancel(true)}
    >
      {label(<Square aria-hidden="true" className="sm:hidden" />, t('cancelRun'))}
    </Button>
  );
  const pauseWords = projection.status === 'paused' ? t('resume') : t('pause');
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
          <Tooltip content={pauseWords} forceOpen={narrow ? undefined : false}>
            <Button
              variant="tertiary"
              size="compact"
              className={iconOnly}
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
                  <Play aria-hidden="true" className="sm:hidden" />
                ) : (
                  <Pause aria-hidden="true" className="sm:hidden" />
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
                forceOpen={narrow && !confirming ? undefined : false}
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
