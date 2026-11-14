import type { CommandError } from '@corral/contracts';
import type { SessionEntry } from '@corral/core';
import {
  Button,
  MetaDot,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  SizeScope,
} from '@corral/react/design-kit';
import { isValidElement, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { editRequest, RefusalActions } from '../RefusalHelp.tsx';
import { refusalKind } from '../refusal.ts';
import { openAdvisorControl } from './composer/AdvisorControl.tsx';
import { entryKind, type SteerMeta } from './entryMeta.ts';

// The always-shown end of a sent message's meta line: what became of it, on one line. Text
// that does not fit is cut with its whole words in the title; buttons never wrap or shrink.

const Text = ({ children, danger = false }: { children: string; danger?: boolean }) => (
  <span className={`min-w-0 truncate ${danger ? 'text-danger' : ''}`} title={children}>
    {children}
  </span>
);
/**
 * The line's buttons are the kit's smallest quiet button. Their padding is taken back by an
 * equal negative margin, so their words sit where plain words would: the same space on both
 * sides of a dot, and the line's last word at its inner edge whether it is a button or not.
 */
export const LINE_BUTTON = '-mx-1 shrink-0 px-1';
/** A line button that gives way first: its label is cut, with its whole words in the title. */
const SHRINKS = '-mx-1 min-w-0 shrink justify-start px-1 [&_span]:min-w-0 [&_span]:truncate';

export function EntryStatus({
  sessionId,
  entry,
  steer,
  sourceShown = false,
  canResend,
  onResend,
  onPanel,
}: {
  sessionId: string;
  entry: SessionEntry;
  /** An instruction's line; null for a new or next request. */
  steer: SteerMeta | null;
  /** A carried request's source message is in the conversation and says it was carried. */
  sourceShown?: boolean;
  canResend: boolean;
  onResend: () => void;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  const kind = entryKind(entry);
  const label = kind
    ? kind === 'scheduled'
      ? t('scheduledRequest')
      : t(`intentShort.${kind}`)
    : null;
  const parts: ReactNode[] = [];
  if (label)
    parts.push(
      <span key="kind" className="shrink-0">
        {label}
      </span>,
    );
  const refused = entry.state === 'refused' && entry.detail && !entry.meetingHandoff;
  // A request's own pencil, on this line, edits it; an instruction has none.
  if (refused)
    parts.push(
      <RefusalLine
        key="refusal"
        sessionId={sessionId}
        entry={entry}
        edit={entry.intent === 'steer'}
      />,
    );
  else if (entry.detail)
    parts.push(
      <Text key="detail" danger>
        {entry.detail}
      </Text>,
    );
  else if (steer) {
    const line = steerLine(steer, t, sessionId, onPanel, entry, canResend, onResend);
    if (line) parts.push(line);
  } else if (entry.carriedFrom && entry.state === 'started' && !sourceShown)
    // Carried over from an instruction sent from the run record: no source message here.
    parts.push(<Text key="carried">{t('meta.carriedStarted')}</Text>);
  return (
    <SizeScope size="compact">
      <span data-testid="entry-status" className="flex min-w-0 flex-nowrap items-center gap-1.5">
        {parts.flatMap((part, index) =>
          index && isValidElement(part)
            ? [<MetaDot key={`dot-${String(part.key)}`} />, part]
            : [part],
        )}
      </span>
    </SizeScope>
  );
}

function steerLine(
  meta: SteerMeta,
  t: ReturnType<typeof useTranslations<'Sessions'>>,
  sessionId: string,
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void,
  entry: SessionEntry,
  canResend: boolean,
  onResend: () => void,
): ReactNode {
  switch (meta.kind) {
    case 'unread':
      return null;
    case 'read':
    case 'interrupted':
      return (
        <span key="steer" className="flex min-w-0 flex-nowrap items-center gap-1.5">
          <Text>{t(meta.kind === 'read' ? 'meta.read' : 'meta.interrupted')}</Text>
          <MetaDot />
          {/* The role, named as the send menu names it, opens that execution's record. */}
          <Button
            variant="ghost"
            className={SHRINKS}
            title={meta.target}
            aria-label={t('meta.openTarget', { name: meta.target })}
            onClick={() =>
              onPanel('run', {
                run: entry.runId ?? undefined,
                view: 'run',
                execution: meta.executionId,
              })
            }
          >
            <span className="block">{meta.target}</span>
          </Button>
        </span>
      );
    case 'carriedRefused':
      return <RefusalLine key="steer" sessionId={sessionId} entry={meta.carried} edit />;
    case 'notDelivered':
      return (
        <span key="steer" className="flex min-w-0 flex-nowrap items-center gap-3">
          <Text>{t('meta.notDelivered')}</Text>
          <Button variant="ghost" className={LINE_BUTTON} disabled={!canResend} onClick={onResend}>
            {t('meta.resend')}
          </Button>
        </span>
      );
    default:
      return <Text key="steer">{t(`meta.${meta.kind}`)}</Text>;
  }
}

/**
 * Why a request did not start, as one line: the reason in the person's words (it opens the
 * runtime's own words, code and owner) and the actions that help with that kind.
 */
function RefusalLine({
  sessionId,
  entry,
  edit,
}: {
  sessionId: string;
  entry: SessionEntry;
  /** Whether the line offers the edit; a message whose pencil edits this request does not. */
  edit: boolean;
}) {
  const t = useTranslations('Refusal');
  const message = entry.detail ?? entry.refusal?.message ?? '';
  const code = entry.refusal?.code;
  const owner: CommandError['owner'] = entry.refusal?.owner;
  const kind = refusalKind({ code, message, owner });
  const reason = t(kind);
  return (
    <span className="flex min-w-0 flex-nowrap items-center gap-3">
      <Popover>
        <PopoverTrigger
          title={reason}
          render={<Button variant="ghost" className={`${SHRINKS} text-danger hover:text-danger`} />}
        >
          <span className="block">{reason}</span>
        </PopoverTrigger>
        <PopoverPopup align="end" width="md" aria-label={t('diagnostics')}>
          <div data-testid="refusal-raw" className="flex flex-col gap-1 text-caption">
            <p className="wrap-anywhere">{message}</p>
            {code ? <code className="text-muted-foreground">{code}</code> : null}
            {owner ? (
              <p className="text-muted-foreground">
                <code>{owner.id}</code> · {owner.state}
              </p>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      <RefusalActions
        message={message}
        code={code}
        owner={owner}
        sessionId={sessionId}
        quiet={LINE_BUTTON}
        // The conversation's advisor control, beside the request box under this line.
        onAdvisor={openAdvisorControl}
        // Edited as the pencil edits it: with everything it was sent with.
        onEdit={edit ? () => editRequest(entry.text, entry) : undefined}
      />
    </span>
  );
}
