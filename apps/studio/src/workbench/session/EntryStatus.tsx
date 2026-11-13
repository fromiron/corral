import type { CommandError } from '@corral/contracts';
import type { SessionEntry } from '@corral/core';
import { Button, Popover, PopoverPopup, PopoverTrigger } from '@corral/react/design-kit';
import { isValidElement, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { editRequest, RefusalActions } from '../RefusalHelp.tsx';
import { refusalKind } from '../refusal.ts';
import { entryKind, type SteerMeta } from './entryMeta.ts';

// The always-shown end of a sent message's meta line: what became of it, on one line. Text
// that does not fit is cut with its whole words in the title; buttons never wrap or shrink.

const Text = ({ children, danger = false }: { children: string; danger?: boolean }) => (
  <span className={`min-w-0 truncate ${danger ? 'text-danger' : ''}`} title={children}>
    {children}
  </span>
);
const Dot = () => (
  <span aria-hidden className="shrink-0">
    ·
  </span>
);

export function EntryStatus({
  sessionId,
  entry,
  steer,
  canResend,
  onResend,
  onPanel,
}: {
  sessionId: string;
  entry: SessionEntry;
  /** An instruction's line; null for a new or next request. */
  steer: SteerMeta | null;
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
  if (refused) parts.push(<RefusalLine key="refusal" sessionId={sessionId} entry={entry} />);
  else if (entry.detail)
    parts.push(
      <Text key="detail" danger>
        {entry.detail}
      </Text>,
    );
  else if (steer) {
    const line = steerLine(steer, t, sessionId, onPanel, entry, canResend, onResend);
    if (line) parts.push(line);
  } else if (entry.carriedFrom && entry.state === 'started')
    // Carried over from an instruction sent from the run record: no source message here.
    parts.push(<Text key="carried">{t('meta.carriedStarted')}</Text>);
  return (
    <span data-testid="entry-status" className="flex min-w-0 flex-nowrap items-center gap-1">
      {parts.flatMap((part, index) =>
        index && isValidElement(part) ? [<Dot key={`dot-${part.key}`} />, part] : [part],
      )}
    </span>
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
        <span key="steer" className="flex min-w-0 flex-nowrap items-center gap-1">
          <Text>{t(meta.kind === 'read' ? 'meta.read' : 'meta.interrupted')}</Text>
          <Dot />
          {/* The role, named as the send menu names it, opens that execution's record. */}
          <Button
            variant="ghost"
            className="min-w-0 shrink"
            title={meta.target}
            onClick={() =>
              onPanel('run', {
                run: entry.runId ?? undefined,
                view: 'run',
                execution: meta.executionId,
              })
            }
          >
            <span className="truncate">{meta.target}</span>
          </Button>
        </span>
      );
    case 'carriedRefused':
      return <RefusalLine key="steer" sessionId={sessionId} entry={meta.carried} />;
    case 'notDelivered':
      return (
        <span key="steer" className="flex min-w-0 flex-nowrap items-center gap-1">
          <Text>{t('meta.notDelivered')}</Text>
          <Button variant="tertiary" className="shrink-0" disabled={!canResend} onClick={onResend}>
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
function RefusalLine({ sessionId, entry }: { sessionId: string; entry: SessionEntry }) {
  const t = useTranslations('Refusal');
  const message = entry.detail ?? entry.refusal?.message ?? '';
  const code = entry.refusal?.code;
  const owner: CommandError['owner'] = entry.refusal?.owner;
  const kind = refusalKind({ code, message, owner });
  const reason = t(kind);
  return (
    <span className="flex min-w-0 flex-nowrap items-center gap-1">
      <Popover>
        <PopoverTrigger
          title={reason}
          render={<Button variant="ghost" className="min-w-0 shrink text-danger" />}
        >
          <span className="truncate">{reason}</span>
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
        // Edited as the pencil edits it: with everything it was sent with.
        onEdit={() => editRequest(entry.text, entry)}
      />
    </span>
  );
}
