import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { DirectiveView, RunSummary, SessionEntry } from '@corral/core';
import { CopyTextButton, MessageBody, StatusBadge } from '@corral/react';
import {
  Button,
  KitChatMessage,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { PanelRight, Pencil, Settings } from '@corral/react/icons';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { ImageAttachmentList } from '../ImageAttachments.tsx';
import { MessageBranch } from '../MessageBranch.tsx';
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { editRequest, RESEND_REQUEST } from '../RefusalHelp.tsx';
import { SentQuotes } from '../ReplySelection.tsx';
import { RunChanges } from '../RunChanges.tsx';
import { RunMessage } from '../RunMessage.tsx';
import { TextAttachmentList } from '../TextAttachments.tsx';
import { EntryStatus } from './EntryStatus.tsx';
import { type SteerRecord, steerMeta } from './entryMeta.ts';
import { useRecordRead } from './runRecords.ts';

// The conversation rows: each request, the run it started, and what became of an instruction.

export function EntryCard({
  sessionId,
  entry,
  runs,
  artifactMetadataVersion,
  onPanel,
  record,
  carried,
  carriedHere = false,
  runOnly = false,
  heldAs,
  sourceShown = false,
  runsListed = true,
}: {
  sessionId: string;
  entry: SessionEntry;
  runs: RunSummary[];
  artifactMetadataVersion: string;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
  /** An instruction's directive in its run's record: undefined while unread, null if absent. */
  record?: SteerRecord | null | undefined;
  /** The request an instruction was carried over to, in whatever state the session has it. */
  carried?: SessionEntry | undefined;
  /** That request is right under this message: this message takes its actions. */
  carriedHere?: boolean;
  /** A carried request right under its source message: its run row alone. */
  runOnly?: boolean;
  /** What the instruction was before this view saw it expire, until the session is read. */
  heldAs?: DirectiveView['status'] | undefined;
  /** A carried request's source message is in the conversation, and says it was carried. */
  sourceShown?: boolean;
  /** Whether the run list has been read: a run missing from it before then may be going. */
  runsListed?: boolean;
}) {
  const t = useTranslations('Sessions');
  const tm = useTranslations('MessageBody');
  const tq = useTranslations('Reasoning');
  const format = useFormatter();
  const now = useNow();
  const run = entry.runId ? runs.find((r) => r.runId === entry.runId) : undefined;
  const resend = () =>
    window.dispatchEvent(
      new CustomEvent(RESEND_REQUEST, { detail: { sessionId, entryId: entry.entryId } }),
    );
  const canResend = !runs.some((item) => !TERMINAL_RUN_STATUSES.has(item.status));
  // Drawn, an instruction to an ended run has its run's record read (once while the app runs).
  useRecordRead(entry.intent === 'steer' ? entry.runId : null, runs, runsListed);
  const steer =
    entry.intent !== 'steer'
      ? null
      : record === null
        ? ({ kind: 'unknown' } as const)
        : steerMeta(record ?? null, carried, heldAs);
  // A started carried request right under the instruction it came from belongs to it: that
  // message edits and branches it (features/composer-flow.md).
  const request = steer?.kind === 'carriedStarted' && carried && carriedHere ? carried : entry;
  const requestRun = request.runId ? runs.find((r) => r.runId === request.runId) : undefined;
  // The time alone on the day it was sent; the date joins it afterwards and in the tooltip.
  const created = new Date(entry.createdAt);
  const day = (date: Date) => format.dateTime(date, { dateStyle: 'short' });
  const full = format.dateTime(created, { timeStyle: 'short', dateStyle: 'short' });
  const when = day(created) === day(now) ? format.dateTime(created, { timeStyle: 'short' }) : full;
  // what an auto request ran with; not a team the person chose.
  const auto = entry.auto
    ? [
        `${t(`autoTemplate.${entry.auto.template}`)}${entry.auto.source === 'fallback' ? ` (${t('autoFallback')})` : ''}`,
        entry.auto.fallback ? t(`autoFallbackReason.${entry.auto.fallback}`) : null,
        entry.auto.modelProfile,
        entry.auto.requestedReasoning?.mode === 'fixed'
          ? tq(`level.${entry.auto.requestedReasoning.level}`)
          : entry.auto.requestedReasoning?.mode === 'route'
            ? t('reasoningRoute')
            : entry.auto.requestedReasoning
              ? tq(entry.auto.requestedReasoning.mode)
              : entry.auto.modelProfile
                ? tq('legacy')
                : null,
        // the level the start model picked for this request.
        entry.auto.reasoning
          ? `${t('reasoningPicked', { level: tq(`level.${entry.auto.reasoning}`) })}${entry.auto.reasoningSource ? ` (${t(`reasoningSource.${entry.auto.reasoningSource}`)})` : ''}`
          : null,
        entry.auto.reason,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  const unfinished =
    run && ['cancelled', 'interrupted', 'failed'].includes(run.status) && entry.intent !== 'steer';
  // An instruction's attachments live in its directive; a request keeps its own.
  const attachments = entry.intent === 'steer' ? record?.directive.attachments : entry.attachments;
  const runRow =
    run && entry.intent !== 'steer' ? (
      <RunCard
        run={run}
        number={runs.findIndex((item) => item.runId === run.runId) + 1}
        nested
        artifactMetadataVersion={artifactMetadataVersion}
        onPanel={onPanel}
        endActions={
          unfinished ? (
            // What to do next sits with the turn's one notice that it did not finish.
            <>
              <Button variant="secondary" disabled={!canResend} onClick={resend}>
                {t('retryRequest')}
              </Button>
              <Button variant="ghost" onClick={() => editRequest(entry.text, entry)}>
                {t('restoreRequest')}
              </Button>
            </>
          ) : undefined
        }
      />
    ) : null;
  if (runOnly)
    return runRow ? (
      <article data-testid={`entry-${entry.entryId}`} className="chat-turn flex flex-col gap-2">
        {runRow}
      </article>
    ) : null;
  return (
    <article data-testid={`entry-${entry.entryId}`} className="chat-turn flex flex-col gap-2">
      <div className="flex flex-col items-end gap-1">
        {/* The kit's sent message: a plain bubble, then its one meta line. It keeps the kit's
            entrance but not its position animation: the conversation holds every row in place
            itself (features/composer-flow.md "튐 없는 본문"), and a re-render while the view
            follows its end or while the line's words change would slide the message. */}
        <KitChatMessage
          from="user"
          layout={false}
          // The line may take the column's width, not only the message's 80%: a reason fits
          // whole at a desktop width. It stays right-aligned and runs out to the left.
          metaProps={{ 'data-chat-part': 'meta', className: 'w-max max-w-[125%]' }}
          time={
            <time dateTime={entry.createdAt} title={full}>
              {when}
            </time>
          }
          actions={
            <>
              <CopyTextButton text={entry.text} />
              {request.intent !== 'steer' ? (
                <Tooltip content={tm('editAsNew')}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tm('editAsNew')}
                    onClick={() => editRequest(request.text, request)}
                  >
                    <Pencil />
                  </Button>
                </Tooltip>
              ) : null}
              {request.runId &&
              requestRun &&
              (request.intent === 'next' || request.intent === 'explain' || request.carriedFrom) ? (
                <MessageBranch
                  icon
                  runId={request.runId}
                  requestStart
                  disabled={!TERMINAL_RUN_STATUSES.has(requestRun.status)}
                />
              ) : null}
              {auto ? (
                <Popover>
                  <PopoverTrigger
                    title={t('runSettings')}
                    render={<Button size="icon" variant="ghost" aria-label={t('runSettings')} />}
                  >
                    <Settings />
                  </PopoverTrigger>
                  <PopoverPopup align="end" width="md">
                    <p data-testid="entry-auto" className="text-caption text-muted-foreground">
                      {auto}
                    </p>
                  </PopoverPopup>
                </Popover>
              ) : null}
            </>
          }
          status={
            <EntryStatus
              sessionId={sessionId}
              entry={entry}
              steer={steer}
              sourceShown={sourceShown}
              canResend={canResend}
              onResend={resend}
              onPanel={onPanel}
            />
          }
        >
          <MessageBody text={entry.text} copy={false} />
          {attachments?.length ? (
            <SentQuotes attachments={attachments} owner={entry.entryId} />
          ) : null}
          {attachments?.some((item) => item.provenance?.kind !== 'reply') ? (
            <TextAttachmentList
              attachments={attachments.filter((item) => item.provenance?.kind !== 'reply')}
            />
          ) : null}
          {entry.images?.length ? (
            <ImageAttachmentList sessionId={sessionId} images={entry.images} />
          ) : null}
          <span className="sr-only">
            {t('youAsked', { intent: t(`intent.${entry.intent}`) })} · {t(`state.${entry.state}`)}
          </span>
        </KitChatMessage>
      </div>
      {runRow}
    </article>
  );
}

/** A run with its status and, once it has one, its final result. */
/** Each ended run's latest check of its own end state, when the session has checks. */
type RunCheck = { name: string; state: 'running' | 'passed' | 'failed' | 'error' } | null;
export const RunChecks = createContext<{ known: boolean; of: (runId: string) => RunCheck }>({
  known: false,
  of: () => null,
});

/** Matches checks to runs by tree: a check counts for a run only if it ran on the run's end. */
export function useRunChecks(sessionId: string, runs: RunSummary[]) {
  const { workspaces } = useServices();
  const [value, setValue] = useState<{ known: boolean; map: Map<string, RunCheck> }>({
    known: false,
    map: new Map(),
  });
  const key = runs.map((r) => `${r.runId}:${r.status}`).join(',');
  useEffect(() => {
    void key;
    if (!workspaces) return;
    let live = true;
    void (async () => {
      const copy = await workspaces.worktree(sessionId).catch(() => null);
      if (!copy) return;
      const [snapshots, checks] = await Promise.all([
        workspaces.runSnapshots(sessionId),
        workspaces.verifications(sessionId),
      ]);
      const map = new Map<string, RunCheck>();
      for (const snapshot of snapshots.filter((x) => x.phase === 'end')) {
        const check = checks.find((c) => c.tree === snapshot.tree);
        map.set(snapshot.runId, check ? { name: check.name, state: check.state } : null);
      }
      if (live) setValue({ known: true, map });
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, key]);
  return { known: value.known, of: (runId: string) => value.map.get(runId) ?? null };
}

/**
 * A run in the session. In a conversation it reads as one quiet process line (time, steps and
 * the run's number, which opens its record), then what needs the person, then the answer.
 */
export function RunCard({
  run,
  number,
  artifactMetadataVersion,
  nested = false,
  onPanel,
  endActions,
}: {
  run: RunSummary;
  /** The run's place in its session, from 1; 0 when it is not known. */
  number: number;
  artifactMetadataVersion: string;
  nested?: boolean;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
  /** Retry and restore, for a request whose run did not finish. */
  endActions?: ReactNode;
}) {
  const t = useTranslations('Sessions');
  const tf = useTranslations('Files');
  const checks = useContext(RunChecks);
  const check = checks.of(run.runId);
  const ended = TERMINAL_RUN_STATUSES.has(run.status);
  const name = number > 0 ? t('runNumber', { number }) : run.runId;
  return (
    <section
      aria-label={name}
      data-testid={`run-card-${run.runId}`}
      className={`flex min-w-0 flex-col gap-3 ${nested ? '' : 'mb-4'}`}
    >
      {/* In a conversation the turn speaks through its process line, notice and answer; the
          line above the composer is where a finished run's status shows. A run no request
          names (started elsewhere) is a turn like any other. */}
      <span className="sr-only">
        <StatusBadge status={run.status} />
      </span>
      <RunMessage
        runId={run.runId}
        sessionId={run.sessionId ?? null}
        live={!ended}
        artifactMetadataVersion={artifactMetadataVersion}
        onOpenArtifact={(result) => onPanel('run', { run: run.runId, view: 'results', result })}
        endActions={endActions}
        runLine={
          <>
            <Tooltip content={t('openRun')}>
              <Button
                variant="ghost"
                data-testid="turn-run"
                onClick={() => onPanel('run', { run: run.runId, view: 'run' })}
              >
                {/* The same mark on every link that opens beside the conversation. */}
                <PanelRight />
                <span className="tabular-nums">{name}</span>
              </Button>
            </Tooltip>
            {ended && checks.known ? (
              <span className="px-2" data-testid="run-check">
                {check
                  ? t('checked', { name: check.name, state: tf(`checkState.${check.state}`) })
                  : t('notChecked')}
              </span>
            ) : null}
          </>
        }
      />
      {/* Only a session with a working copy has changes to review (its checks are known). */}
      {ended && checks.known && run.sessionId ? (
        <RunChanges sessionId={run.sessionId} runId={run.runId} />
      ) : null}
    </section>
  );
}
