import type {
  CommandError,
  Receipt,
  ReceiptStatus,
  RunCommand,
  RunCommandType,
} from '@corral/contracts';
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { RefreshCw } from '../design-kit/icons.ts';
import { Button, cn, focusRing, fontWeights, Tooltip } from '../design-kit/index.ts';
import type { RunSessionState, RunSessionStore } from '../run/session.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { StatusBadge, StatusDot } from './StatusBadge.tsx';

/** A command these receipts settled: its result already shows where the person acted. */
const SETTLED = new Set<ReceiptStatus>(['applied', 'superseded', 'cancelled']);

/** A receipt still waiting for its boundary; any other open one went wrong. */
const WAITING = new Set<ReceiptStatus>(['accepted', 'queued']);

/**
 * Where a lost response is said, once on the screen: an instruction to one execution in that
 * execution's Reins, whose send goes again under the same command ID; any other command in its
 * run's head, with its retry.
 */
const lostPlace = (command: RunCommand) =>
  command.type === 'steer'
    ? `execution:${command.payload.targetExecutionId}`
    : `run:${command.runId}`;

/**
 * What `target` says of lost responses: the lost commands it keeps a row for, with the retry, and
 * whether the connection's error takes a line of its own. A lost response sets that error too, so
 * the line stands only where its command belongs and no row says it; an error no lost command
 * explains stands in the run's head.
 */
function losses(
  state: Pick<RunSessionState, 'commandError' | 'unconfirmedCommands'>,
  target: string,
) {
  const lost = Object.values(state.unconfirmedCommands);
  const here = lost.filter(({ command }) => lostPlace(command) === target);
  // An execution's Reins keeps no row: its own field sends the instruction again.
  const rows = target.startsWith('run:') ? here : [];
  const line =
    state.commandError !== null &&
    rows.length === 0 &&
    (lost.length === 0 ? target.startsWith('run:') : here.length > 0);
  return { rows, line };
}

const isOpen = (receipt: Receipt) => !SETTLED.has(receipt.status) || receipt.error !== undefined;

/**
 * Whether `CommandReceipts` with `openOnly` has anything to show for `target`: a receipt still
 * waiting or gone wrong, a command whose answer was lost, or the connection's error.
 */
export function useOpenReceipts(session: RunSessionStore, target: string): boolean {
  return useStore(session, (s) => {
    const { rows, line } = losses(s, target);
    return (
      rows.length > 0 ||
      line ||
      Object.values(s.receipts).some((receipt) => receipt.target === target && isOpen(receipt))
    );
  });
}

/** A whole-run control's own name, which says it is the run's; other commands have none yet. */
const NAMES: Partial<Record<RunCommandType, 'pause' | 'resume' | 'cancelRun'>> = {
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancelRun',
};

/** Receipt state comes from the command record, never the HTTP status or a local click. */
export function CommandReceipts({
  session,
  target,
  openOnly = false,
  lines = false,
  iconActions = false,
  actionSize,
}: {
  session: RunSessionStore;
  target: string;
  /** Leaves out settled receipts, keeping those still waiting and those that went wrong. */
  openOnly?: boolean;
  /**
   * Each receipt on one line (its mark, the command's name, then its boundary and state, or
   * its state and reason), cut at the end and whole in the kit tooltip; the group keeps its name
   * but no heading. For a head that carries nothing else.
   */
  lines?: boolean;
  /** With `lines`: the retry shows its icon, its words staying its name and tooltip. */
  iconActions?: boolean;
  /** With `lines`: the size of the line's action, the host's own. */
  actionSize?: ComponentProps<typeof Button>['size'];
}) {
  const t = useTranslations('Reins');
  const failure = useTranslations('Failure');
  const status = useTranslations('Status');
  const receipts = useStore(session, (s) => s.receipts);
  const types = useStore(session, (s) => s.commandTypes);
  const commandError = useStore(session, (s) => s.commandError);
  const unconfirmedCommands = useStore(session, (s) => s.unconfirmedCommands);
  const pending = useStore(session, (s) => s.pendingCommandIds);
  const matching = Object.values(receipts).filter(
    (receipt) => receipt.target === target && (!openOnly || isOpen(receipt)),
  );
  // Said once, in the product's words: the browser's own words never reach the screen.
  const { rows: lost, line: errorLine } = losses({ commandError, unconfirmedCommands }, target);
  const retry = (commandId: string) =>
    void session
      .getState()
      .retryCommand(commandId)
      .catch(() => undefined);
  if (lines) {
    // Why a command went wrong: the cause's sentence when it has one, then the record itself.
    const reason = (error: CommandError) =>
      [
        failure.has(`code.${error.code}`) ? failure(`code.${error.code}`) : null,
        `${error.code}: ${error.message}`,
      ]
        .filter(Boolean)
        .join(' ');
    /** A whole-run control by its own name; any other command by the generic words. */
    const nameOf = (type: RunCommandType | undefined, wholeRun: boolean) => {
      const name = type && wholeRun ? NAMES[type] : undefined;
      return name ? t(name) : null;
    };
    const retryWords = t('retrySameCommand');
    return (
      <div className="flex min-w-0 flex-col gap-1 text-caption" aria-live="polite">
        {errorLine ? (
          <ReceiptLine words={[{ text: t('receiptUnconfirmed'), alert: true, tone: 'danger' }]} />
        ) : null}
        {lost.length > 0 || matching.length > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: a named group of receipt lines, not a form fieldset.
          <div role="group" aria-label={t('receipts')} className="flex min-w-0 flex-col gap-1">
            {lost.map(({ command }) => {
              const name = nameOf(
                command.type,
                command.type !== 'cancel' || command.payload.scope.kind === 'run',
              );
              return (
                <ReceiptLine
                  key={command.commandId}
                  mark={<StatusDot status="delivery_unknown" />}
                  words={[
                    ...(name
                      ? [{ text: name, title: command.commandId }]
                      : [
                          { text: t('receiptRun'), title: command.commandId },
                          { text: command.type },
                        ]),
                    { text: t('receiptUnconfirmed'), alert: true, tone: 'muted' as const },
                  ]}
                  action={
                    <Tooltip content={retryWords} forceOpen={iconActions ? undefined : false}>
                      <Button
                        type="button"
                        variant="tertiary"
                        size={actionSize}
                        className="shrink-0"
                        disabled={pending.includes(command.commandId)}
                        onClick={() => retry(command.commandId)}
                      >
                        {iconActions ? (
                          <>
                            <RefreshCw aria-hidden="true" />
                            <span className="sr-only">{retryWords}</span>
                          </>
                        ) : (
                          retryWords
                        )}
                      </Button>
                    </Tooltip>
                  }
                />
              );
            })}
            {matching.map((receipt) => {
              const name = {
                text:
                  nameOf(types[receipt.commandId], receipt.target.startsWith('run:')) ??
                  t(receipt.target.startsWith('run:') ? 'receiptRun' : 'receiptExecution'),
                title: receipt.commandId,
              };
              const state = status.has(receipt.status) ? status(receipt.status) : receipt.status;
              const tail = receipt.error
                ? reason(receipt.error)
                : t(`boundary.${receipt.requestedBoundary}`);
              // Waiting, the boundary is the news and leads; gone wrong, the state does.
              const waiting = WAITING.has(receipt.status) && !receipt.error;
              return (
                <ReceiptLine
                  key={receipt.commandId}
                  testId={`receipt-${receipt.commandId}`}
                  mark={<StatusDot status={receipt.status} />}
                  words={
                    waiting
                      ? [name, { text: tail }, { text: state, tone: 'muted' }]
                      : [name, { text: state }, { text: tail, tone: 'muted' }]
                  }
                />
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-caption" aria-live="polite">
      {errorLine ? (
        <p role="alert" className="text-danger">
          {t('receiptUnconfirmed')}
        </p>
      ) : null}
      {matching.length > 0 ? (
        <h3 style={{ fontVariationSettings: fontWeights.semibold }}>{t('receipts')}</h3>
      ) : null}
      {lost.map(({ command }) => (
        <div key={command.commandId} className="rounded border border-warning p-2">
          <p title={command.commandId}>
            {t('receiptRun')} · {command.type}
          </p>
          <p role="alert">{t('receiptUnconfirmed')}</p>
          <Button
            type="button"
            disabled={pending.includes(command.commandId)}
            variant="tertiary"
            onClick={() => retry(command.commandId)}
          >
            {t('retrySameCommand')}
          </Button>
        </div>
      ))}
      {matching.map((receipt) => (
        <div
          key={receipt.commandId}
          className="border-b border-border py-2 last:border-0"
          data-testid={`receipt-${receipt.commandId}`}
        >
          <p>
            {/* UX-08: what the command was for, not its ID (kept in the title for support). */}
            <span title={receipt.commandId}>
              {t(receipt.target.startsWith('run:') ? 'receiptRun' : 'receiptExecution')}
            </span>{' '}
            · <StatusBadge status={receipt.status} />
          </p>
          <p className="text-muted-foreground">{t(`boundary.${receipt.requestedBoundary}`)}</p>
          {receipt.error ? (
            <FailureNotice code={receipt.error.code} message={receipt.error.message} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A part of a receipt's line: the command, its state, or the tail (boundary or reason). */
interface LinePart {
  text: string;
  /** The command's ID, kept in the title for support while the line is whole. */
  title?: string;
  /** The tail is muted; the connection's error, with no mark, keeps the danger tone. */
  tone?: 'muted' | 'danger';
  /** Said at once: the response or the connection was lost. */
  alert?: boolean;
}

/**
 * One receipt on one line: its mark, its words cut at the end, and its action. Cut, the words
 * show whole in the kit tooltip, on hover and on keyboard focus, so they take a tab stop.
 */
function ReceiptLine({
  words,
  mark,
  action,
  testId,
}: {
  words: LinePart[];
  mark?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  const text = words.map((part) => part.text).join(' · ');
  const box = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || text === '') return;
    const measure = () => setCut(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div data-slot="receipt-line" data-testid={testId} className="flex min-w-0 items-center gap-2">
      {mark ? (
        <span data-slot="receipt-mark" aria-hidden="true" className="flex shrink-0 items-center">
          {mark}
        </span>
      ) : null}
      {/* Mounted whether cut or not, so the live region around it is not redrawn. */}
      <Tooltip content={text} forceOpen={cut ? undefined : false} className="max-w-xs">
        <span
          ref={box}
          data-slot="receipt-line-text"
          // Cut short, the line takes a tab stop so the keyboard reaches its whole words.
          tabIndex={cut ? 0 : undefined}
          className={cn('min-w-0 truncate', focusRing)}
        >
          {words.map((part, index) => (
            <span key={part.text}>
              {index > 0 ? ' · ' : null}
              <span
                role={part.alert ? 'alert' : undefined}
                // Cut, the whole line is the tooltip; a second, native one would cover it.
                title={cut ? undefined : part.title}
                className={
                  part.tone === 'muted'
                    ? 'text-muted-foreground'
                    : part.tone === 'danger'
                      ? 'text-danger'
                      : undefined
                }
              >
                {part.text}
              </span>
            </span>
          ))}
        </span>
      </Tooltip>
      {action}
    </div>
  );
}
