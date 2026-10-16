import { useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { buildTranscript, type TranscriptEntry } from '../run/transcript.ts';
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
}: {
  session: RunSessionStore;
  executionId: string;
  onOpenArtifact?: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Transcript');
  const events = useStore(session, (s) => s.events);
  const projection = useStore(session, (s) => s.projection);
  const streams = useStore(session, (s) => s.streams);
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
      className="flex min-h-0 flex-col gap-2 overflow-auto rounded-md border border-line bg-surface p-2 text-xs"
    >
      {entries.length === 0 ? <p className="text-muted">{t('empty')}</p> : null}
      {entries.map((entry) => (
        <Entry
          key={`${entry.kind}-${entry.seq}`}
          entry={entry}
          labelOf={labelOf}
          {...(onOpenArtifact ? { onOpenArtifact } : {})}
        />
      ))}
    </div>
  );
}

function Entry({
  entry,
  labelOf,
  onOpenArtifact,
}: {
  entry: TranscriptEntry;
  labelOf: (nodeId: string) => string;
  onOpenArtifact?: (id: string) => void;
}) {
  const t = useTranslations('Transcript');
  switch (entry.kind) {
    case 'started':
      return (
        <p className="text-center text-muted">
          {t('started', { label: labelOf(entry.nodeId) })}
          {entry.round ? ` · ${t('round', { no: entry.round })}` : ''}
          {entry.attemptNo > 1 ? ` · ${t('attempt', { no: entry.attemptNo })}` : ''}
        </p>
      );
    case 'instruction':
      return (
        <div
          data-testid={`transcript-instruction-${entry.directiveId}`}
          className="ml-8 self-end rounded-lg border border-accent/50 bg-accent/10 px-2 py-1"
        >
          <p className="font-medium">{t('you')}</p>
          <p className="whitespace-pre-wrap">{entry.text}</p>
          <p className="text-muted">{t(`instruction.${entry.status}`)}</p>
        </div>
      );
    case 'request':
      return (
        <p className="flex flex-wrap items-center gap-1 text-muted">
          <span>{t('request', { no: entry.no })}</span>
          {entry.directives.length > 0 ? (
            <span className="rounded border border-accent/50 px-1 text-accent">
              {t('withInstructions', { count: entry.directives.length })}
            </span>
          ) : null}
          {entry.effort.map((e) =>
            e.answer ? (
              <span key={e.provider} className="rounded border border-line px-1">
                {t('effort', { level: e.answer, provider: e.provider })}
              </span>
            ) : null,
          )}
        </p>
      );
    case 'reply':
      return (
        <div className="mr-8 rounded-lg border border-line bg-raised px-2 py-1">
          {entry.text ? (
            <SafeMarkdown text={entry.text} />
          ) : (
            <p className="text-muted">{t('waiting')}</p>
          )}
          {entry.live ? <p className="text-muted">{t('streaming')}</p> : null}
          {entry.broken ? <p className="text-warning">{t('gap')}</p> : null}
        </div>
      );
    case 'tool':
      return (
        <p className="flex flex-wrap items-center gap-1">
          <span className="rounded border border-line px-1 font-mono">{entry.name}</span>
          <span
            className={
              entry.status === 'blocked' || entry.status === 'failed' ? 'text-danger' : 'text-muted'
            }
          >
            {t(`tool.${entry.status}`)}
            {entry.detail ? `: ${entry.detail}` : ''}
          </span>
          {entry.resultRef?.startsWith('artv_') && onOpenArtifact ? (
            <button
              type="button"
              onClick={() => onOpenArtifact(entry.resultRef as string)}
              className="font-mono underline"
            >
              {entry.resultRef}
            </button>
          ) : null}
        </p>
      );
    case 'question':
      return (
        <div className="mr-8 rounded-lg border border-line px-2 py-1">
          <p className="font-medium">{t('asked', { target: labelOf(entry.targetNodeId) })}</p>
          <p className="whitespace-pre-wrap">{entry.body}</p>
          {entry.answer ? (
            <div className="mt-1 border-l-2 border-accent pl-2">
              <p className="text-muted">{t('answer')}</p>
              <SafeMarkdown text={entry.answer} />
            </div>
          ) : (
            <p className="text-muted">{t(`question.${entry.status}`)}</p>
          )}
        </div>
      );
    case 'version':
      return (
        <p className="text-muted">
          {t('wrote', { name: entry.name, version: entry.version })}{' '}
          {onOpenArtifact ? (
            <button
              type="button"
              onClick={() => onOpenArtifact(entry.artifactVersionId)}
              className="font-mono underline"
            >
              {entry.artifactVersionId}
            </button>
          ) : (
            <span className="font-mono">{entry.artifactVersionId}</span>
          )}
        </p>
      );
    case 'settled':
      return (
        <p
          className={`text-center ${entry.outcome === 'succeeded' ? 'text-success' : 'text-danger'}`}
        >
          {t(`settled.${entry.outcome}`)}
          {entry.error ? `: ${entry.error}` : ''}
        </p>
      );
  }
}
