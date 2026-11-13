import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, SessionEntry } from '@corral/core';
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
import { editRequest, RESEND_REQUEST, RefusalHelp } from '../RefusalHelp.tsx';
import { SentQuotes } from '../ReplySelection.tsx';
import { RunChanges } from '../RunChanges.tsx';
import { RunMessage } from '../RunMessage.tsx';
import { isScheduledRequest } from '../scheduledRuns.ts';
import { TextAttachmentList } from '../TextAttachments.tsx';

// The conversation rows: each request, the run it started, and where an instruction is.

export function EntryCard({
  sessionId,
  entry,
  runs,
  artifactMetadataVersion,
  onPanel,
}: {
  sessionId: string;
  entry: SessionEntry;
  runs: RunSummary[];
  artifactMetadataVersion: string;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
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
  // The time alone on the day it was sent; the date joins it afterwards and in the tooltip.
  const created = new Date(entry.createdAt);
  const day = (date: Date) => format.dateTime(date, { dateStyle: 'short' });
  const full = format.dateTime(created, { timeStyle: 'short', dateStyle: 'short' });
  const when = day(created) === day(now) ? format.dateTime(created, { timeStyle: 'short' }) : full;
  // A plain follow-up needs no label; queue, instruction and question say what they were.
  const label = isScheduledRequest(entry)
    ? t('scheduledRequest')
    : entry.intent === 'next'
      ? null
      : t(`intentShort.${entry.intent}`);
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
  const state =
    entry.state === 'started' || entry.state === 'sent' ? null : t(`state.${entry.state}`);
  const unfinished =
    run && ['cancelled', 'interrupted', 'failed'].includes(run.status) && entry.intent !== 'steer';
  return (
    <article data-testid={`entry-${entry.entryId}`} className="chat-turn flex flex-col gap-2">
      <div className="flex flex-col items-end gap-1">
        {/* What the message was, when it was not a plain request that started. */}
        {label || state ? (
          <p data-testid="entry-flag" className="px-1 text-caption text-muted-foreground">
            {[label, state].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {/* The kit's sent message: a plain bubble, then its time and icon actions. */}
        <KitChatMessage
          from="user"
          time={
            <time dateTime={entry.createdAt} title={full}>
              {when}
            </time>
          }
          actions={
            <>
              <CopyTextButton text={entry.text} />
              {entry.intent !== 'steer' ? (
                <Tooltip content={tm('editAsNew')}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tm('editAsNew')}
                    onClick={() => editRequest(entry.text, entry)}
                  >
                    <Pencil />
                  </Button>
                </Tooltip>
              ) : null}
              {entry.runId && run && (entry.intent === 'next' || entry.intent === 'explain') ? (
                <MessageBranch
                  icon
                  runId={entry.runId}
                  requestStart
                  disabled={!TERMINAL_RUN_STATUSES.has(run.status)}
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
        >
          <MessageBody text={entry.text} copy={false} />
          {entry.attachments?.length ? (
            <SentQuotes attachments={entry.attachments} owner={entry.entryId} />
          ) : null}
          {entry.attachments?.some((item) => item.provenance?.kind !== 'reply') ? (
            <TextAttachmentList
              attachments={entry.attachments.filter((item) => item.provenance?.kind !== 'reply')}
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
      {entry.detail && entry.state === 'refused' && !entry.meetingHandoff ? (
        <RefusalHelp
          sessionId={sessionId}
          code={entry.refusal?.code}
          owner={entry.refusal?.owner}
          message={entry.detail}
          onEdit={() =>
            editRequest(entry.text, {
              permissionMode: entry.permissionMode,
              harness: entry.harness,
              attachments: entry.attachments,
              images: entry.images,
              taskScope: entry.taskScope,
              verificationScope: entry.verificationScope,
            })
          }
        />
      ) : entry.detail ? (
        <p role="note" className="text-caption text-danger">
          {entry.detail}
        </p>
      ) : null}
      {run && entry.intent !== 'steer' ? (
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
      ) : null}
      {entry.intent === 'steer' && entry.runId ? (
        <div className="flex flex-wrap items-center justify-end gap-2 text-caption text-muted-foreground">
          <DeliveryStatus
            runId={entry.runId}
            commandId={entry.commandId ?? null}
            executionId={entry.executionId ?? null}
            onResend={resend}
            resendDisabled={!canResend}
          />
          <Button
            variant="ghost"
            onClick={() =>
              onPanel('run', {
                run: entry.runId ?? undefined,
                view: 'run',
                execution: entry.executionId ?? undefined,
              })
            }
          >
            {t('openRun')}
          </Button>
        </div>
      ) : null}
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

/** Where an instruction is now, from the run's own record of it. */
/**
 * Whom an instruction was for, when it applies, and where it is now, from the run's
 * own record. It stays readable after the composer moves on to another execution.
 */
function DeliveryStatus({
  runId,
  commandId,
  executionId,
  onResend,
  resendDisabled,
}: {
  runId: string;
  commandId: string | null;
  executionId: string | null;
  onResend: () => void;
  resendDisabled: boolean;
}) {
  const t = useTranslations('Sessions');
  const ts = useTranslations('Transcript.instruction');
  const { transport } = useServices();
  const [status, setStatus] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([transport.getSnapshot(runId), transport.getRunDefinition(runId)]).then(
      ([{ projection }, definition]) => {
        const execution = executionId ? projection.executions[executionId] : undefined;
        if (!live || !execution) return;
        const node = definition?.nodes.find((n) => n.id === execution.nodeId);
        setRecipient(
          `${node?.label ?? execution.nodeId} · #${projection.executionOrder.indexOf(execution.executionId) + 1}`,
        );
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transport, runId, executionId]);
  useEffect(() => {
    if (!commandId) return;
    let live = true;
    const read = () =>
      transport.getSnapshot(runId).then(
        ({ projection }) => {
          const directive = Object.values(projection.directives).find(
            (d) => d.commandId === commandId,
          );
          if (live) setStatus(directive?.status ?? null);
          return directive?.status ?? null;
        },
        () => null,
      );
    void read();
    const timer = setInterval(() => {
      void read().then((now) => {
        if (now && !['accepted', 'queued', 'attached_to_request'].includes(now))
          clearInterval(timer);
      });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [transport, runId, commandId]);
  return (
    <>
      <span data-testid="recipient" className="text-foreground" title={executionId ?? ''}>
        → {recipient ?? executionId}
      </span>
      <span>{t('appliesAt')}</span>
      {status ? <span data-testid="delivery">{t('delivery', { status: ts(status) })}</span> : null}
      {status && ['not_delivered', 'expired', 'cancelled'].includes(status) ? (
        <Button variant="tertiary" disabled={resendDisabled} onClick={onResend}>
          {t('resendNext')}
        </Button>
      ) : null}
    </>
  );
}
