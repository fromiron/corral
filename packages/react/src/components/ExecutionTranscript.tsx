import { useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  KitAccordion as Accordion,
  KitAccordionContent as AccordionContent,
  KitAccordionItem as AccordionItem,
  KitAccordionTrigger as AccordionTrigger,
  KitBadge as Badge,
  KitButton as Button,
  KitChatMessage as ChatMessage,
} from '../design-kit/index.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore } from '../run/session.ts';
import { buildTranscript, type TranscriptEntry } from '../run/transcript.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { ReasoningSummary } from './ReasoningSummary.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/**
 * One execution as a conversation (roadmap UX-A3): what it was asked, what it replied while it
 * streams, the tools it used, the questions it asked and the person's instructions with where
 * they went. Committed facts only; streamed text is labelled as in progress.
 */
export function ExecutionTranscript({
  session,
  executionId,
  onOpenArtifact,
  compact = false,
}: {
  session: RunSessionStore;
  executionId: string;
  onOpenArtifact?: (artifactVersionId: string) => void;
  /** Fold each model reply until the reader opens it. The full run page stays expanded. */
  compact?: boolean;
}) {
  const t = useTranslations('Transcript');
  const events = useRunDisplay(session, (s) => s.events);
  const projection = useRunDisplay(session, (s) => s.projection);
  const streams = useRunDisplay(session, (s) => s.streams);
  const definition = useStore(session, (s) => s.definition);
  const entries = useMemo(
    () => buildTranscript(events, projection, streams, executionId),
    [events, projection, streams, executionId],
  );
  const labelOf = (nodeId: string) =>
    definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

  // Follow new entries unless the reader scrolled up to look at something earlier.
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = entries.at(-1);
  const tail = `${entries.length}:${last?.kind === 'reply' ? last.text.length : 0}`;
  useEffect(() => {
    void tail;
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [tail]);

  return (
    <div
      ref={box}
      role="log"
      aria-label={t('label')}
      aria-live="off"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log must be reachable by keyboard (axe scrollable-region-focusable)
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="flex min-h-0 flex-col gap-4 overflow-auto p-4 text-body"
    >
      {entries.length === 0 ? <p className="text-muted-foreground">{t('empty')}</p> : null}
      {entries.map((entry) => (
        <Entry
          key={`${entry.kind}-${entry.seq}`}
          entry={entry}
          labelOf={labelOf}
          {...(onOpenArtifact ? { onOpenArtifact } : {})}
          compact={compact}
        />
      ))}
    </div>
  );
}

function Entry({
  entry,
  labelOf,
  onOpenArtifact,
  compact = false,
}: {
  entry: TranscriptEntry;
  labelOf: (nodeId: string) => string;
  onOpenArtifact?: (id: string) => void;
  compact?: boolean;
}) {
  const t = useTranslations('Transcript');
  switch (entry.kind) {
    case 'started':
      return (
        <p className="text-center text-caption text-muted-foreground">
          {t('started', { label: labelOf(entry.nodeId) })}
          {entry.round ? ` · ${t('round', { no: entry.round })}` : ''}
          {entry.attemptNo > 1 ? ` · ${t('attempt', { no: entry.attemptNo })}` : ''}
        </p>
      );
    case 'instruction':
      return (
        <ChatMessage from="user" data-testid={`transcript-instruction-${entry.directiveId}`}>
          <p className="font-medium">{t('you')}</p>
          <p className="whitespace-pre-wrap">{entry.text}</p>
          <p className="text-muted-foreground">{t(`instruction.${entry.status}`)}</p>
        </ChatMessage>
      );
    case 'request':
      return (
        <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
          <span>{t('request', { no: entry.no })}</span>
          <ReasoningSummary call={entry} />
          {entry.directives.length > 0 ? (
            <Badge>{t('withInstructions', { count: entry.directives.length })}</Badge>
          ) : null}
          {entry.effort.map((e) =>
            e.answer ? (
              <Badge key={e.provider}>
                {t('effort', { level: e.answer, provider: e.provider })}
              </Badge>
            ) : null,
          )}
        </p>
      );
    case 'reply': {
      const body = (
        <ChatMessage from="assistant">
          {entry.text ? (
            <SafeMarkdown text={entry.text} />
          ) : (
            <p className="text-muted-foreground">{t(entry.live ? 'waiting' : 'emptyReply')}</p>
          )}
          {entry.live ? <p className="text-muted-foreground">{t('streaming')}</p> : null}
          {entry.broken ? <p className="text-warning">{t('gap')}</p> : null}
        </ChatMessage>
      );
      if (!compact) return body;
      return (
        <Accordion>
          <AccordionItem value="reply" highlight="trigger">
            <AccordionTrigger>{t('rawReply', { no: entry.no })}</AccordionTrigger>
            <AccordionContent>{body}</AccordionContent>
          </AccordionItem>
        </Accordion>
      );
    }
    case 'tool':
      return (
        <p className="flex flex-wrap items-center gap-2 text-caption">
          <Badge className="font-mono">{entry.name}</Badge>
          <span
            className={
              entry.status === 'blocked' || entry.status === 'failed'
                ? 'text-danger'
                : 'text-muted-foreground'
            }
          >
            {t(`tool.${entry.status}`)}
            {entry.detail ? `: ${entry.detail}` : ''}
          </span>
          {entry.resultRef?.startsWith('artv_') && onOpenArtifact ? (
            <Button
              variant="ghost"
              onClick={() => onOpenArtifact(entry.resultRef as string)}
              className="font-mono"
            >
              {entry.resultRef}
            </Button>
          ) : null}
        </p>
      );
    case 'question':
      return (
        <ChatMessage from="assistant">
          <p className="font-medium">{t('asked', { target: labelOf(entry.targetNodeId) })}</p>
          <p className="whitespace-pre-wrap">{entry.body}</p>
          {entry.answer ? (
            <div className="mt-4 space-y-2">
              <p className="text-muted-foreground">{t('answer')}</p>
              <SafeMarkdown text={entry.answer} />
            </div>
          ) : (
            <p className="text-muted-foreground">{t(`question.${entry.status}`)}</p>
          )}
        </ChatMessage>
      );
    case 'version':
      return (
        <p className="text-caption text-muted-foreground">
          {t('wrote', { name: entry.name, version: entry.version })}{' '}
          {onOpenArtifact ? (
            <Button
              variant="ghost"
              onClick={() => onOpenArtifact(entry.artifactVersionId)}
              className="font-mono"
            >
              {entry.artifactVersionId}
            </Button>
          ) : (
            <span className="font-mono">{entry.artifactVersionId}</span>
          )}
        </p>
      );
    case 'settled':
      return (
        <div
          className={`text-center text-caption ${entry.outcome === 'succeeded' ? 'text-success' : 'text-danger'}`}
        >
          {t(`settled.${entry.outcome}`)}
          {entry.error ? (
            <FailureNotice message={entry.error} cancelled={entry.outcome === 'cancelled'} />
          ) : null}
        </div>
      );
  }
}
