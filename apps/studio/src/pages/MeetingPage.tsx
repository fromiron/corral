import {
  type MeetingConfig,
  type MeetingRoundRequest,
  type MeetingView,
  type QueuedMeetingMessage,
  SECRETARY_ID,
  type TextAttachment,
} from '@corral/contracts';
import type { MeetingResult, WorkSession } from '@corral/core';
import { SafeMarkdown } from '@corral/react';
import { Send, Square, Users } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';
import { sessionRunMode } from '../workbench/autoChoice.ts';
import { ChatView } from '../workbench/ChatView.tsx';
import { MeetingDecisions } from '../workbench/MeetingDecisions.tsx';
import { MeetingEvidencePicker } from '../workbench/MeetingEvidence.tsx';
import { MeetingHandoffLinks } from '../workbench/MeetingHandoff.tsx';
import { preferences } from '../workbench/preferences.ts';
import { TextAttachmentList } from '../workbench/TextAttachments.tsx';
import { useCorralRun } from '../workbench/useCorralChat.ts';
import { useModelProfiles } from '../workbench/useModels.ts';

type RoundView = MeetingView['rounds'][number];
type AnswerView = RoundView['answers'][number];

const nameOf = (config: MeetingConfig, id: string, secretary: string) =>
  id === SECRETARY_ID
    ? secretary
    : (config.participants.find((p) => p.participantId === id)?.name ?? id);

/** Stored response groups retain their command identities; the conversation shows messages. */
export function MeetingPage({ session }: { session: WorkSession }) {
  const services = useServices();
  const { meetings } = services;
  const t = useTranslations('Meetings');
  const [view, setView] = useState<MeetingView | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const refreshId = useRef(0);
  const recordsPanel = useRef<HTMLDetailsElement>(null);
  const sessionId = session.sessionId;
  const refresh = useCallback(async () => {
    const requestId = ++refreshId.current;
    try {
      const next = await meetings.view(sessionId);
      if (requestId !== refreshId.current) return;
      setView(next);
      setLoadError(next ? '' : t('loadFailed'));
    } catch (failure) {
      if (requestId !== refreshId.current) return;
      setLoadError(failure instanceof Error ? failure.message : t('loadFailed'));
    }
  }, [meetings, sessionId, t]);
  useEffect(() => {
    void refresh();
    return () => {
      refreshId.current += 1;
    };
  }, [refresh]);
  const busy = Boolean(view?.rounds.some((round) => round.active) || view?.queued);
  // Answers are Runs; the view is re-read while one is running or a message waits.
  useEffect(() => {
    if (!busy) return;
    let mounted = true;
    let timer = window.setTimeout(poll, 1000);
    async function poll() {
      await refresh();
      if (mounted) timer = window.setTimeout(poll, 1000);
    }
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [busy, refresh]);
  const act = async (work: () => Promise<MeetingResult>) => {
    try {
      const result = await work();
      if (!result.ok) setError(result.message);
      else setError('');
      return result;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return null;
    } finally {
      await refresh();
    }
  };
  if (!view)
    return (
      <div role={loadError ? 'alert' : 'status'} className="flex flex-col gap-2 p-4 text-sm">
        <p>{loadError || '…'}</p>
        {loadError ? (
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            {t('retry')}
          </Button>
        ) : null}
      </div>
    );
  const mode = sessionRunMode(services.mode, services.live);
  const active = view.rounds.find((round) => round.active);
  const hasRecords = Boolean(
    view.minutes?.length || view.decisions?.length || view.decisionWithdrawals?.length,
  );
  return (
    <ChatView
      centerEmpty
      sessionId={sessionId}
      header={
        <>
          <MeetingHeader title={session.title} config={view.config} />
          {hasRecords ? (
            <details ref={recordsPanel} aria-label={t('records')} className="pb-2 text-sm">
              <summary className="cursor-pointer rounded py-1 font-medium focus-visible:outline-2 focus-visible:outline-ring">
                {t('records')}
              </summary>
              <div className="flex max-h-[40dvh] flex-col gap-4 overflow-y-auto py-3">
                <MeetingDecisions session={session} view={view} onChange={refresh} />
                <MeetingHandoffLinks sessionId={sessionId} meeting={view} onRediscuss={refresh} />
              </div>
            </details>
          ) : null}
        </>
      }
      items={view.rounds
        .flatMap((round, index) => [
          ...(round.message === null
            ? []
            : [
                {
                  id: `${round.roundId}:message`,
                  order: round.order ?? index * 7,
                  content: <MeetingMessage round={round} config={view.config} />,
                },
              ]),
          ...round.answers.map((answer, n) => ({
            id: `${round.roundId}:${answer.participantId}`,
            order:
              answer.order ??
              (answer.status === 'waiting'
                ? Number.MAX_SAFE_INTEGER
                : (round.order ?? index * 7) + n + 1),
            content: (
              <AnswerCard
                answer={answer}
                name={nameOf(view.config, answer.participantId, t('secretary'))}
                onOpenMinutes={
                  answer.participantId === SECRETARY_ID &&
                  view.minutes?.some(
                    (minutes) => minutes.roundId === round.roundId && minutes.document,
                  )
                    ? () => {
                        if (!recordsPanel.current) return;
                        recordsPanel.current.open = true;
                        recordsPanel.current.querySelector('summary')?.focus();
                      }
                    : undefined
                }
              />
            ),
          })),
          ...(round.stoppedAt
            ? [
                {
                  id: `${round.roundId}:stopped`,
                  order:
                    Math.max(
                      round.order ?? index * 7,
                      ...round.answers.map((answer) => answer.order ?? 0),
                    ) + 0.5,
                  content: (
                    <p role="status" className="mb-5 text-xs text-muted">
                      {t('roundStopped')}
                    </p>
                  ),
                },
              ]
            : []),
        ])
        .sort((a, b) => a.order - b.order)}
      composer={
        <MeetingComposer
          key={sessionId}
          projectId={session.projectId}
          view={view}
          mode={mode}
          error={error || loadError}
          onStop={
            active ? () => void act(() => meetings.stop(sessionId, active.roundId)) : undefined
          }
          send={(request) => act(() => meetings.send(sessionId, request))}
          sendQueued={() => act(() => meetings.sendQueued(sessionId))}
          dropQueued={() => act(() => meetings.dropQueued(sessionId))}
          editQueued={(message) => act(() => meetings.editQueued(sessionId, message))}
        />
      }
    >
      {view.rounds.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-5 text-center">
          <Users size={28} strokeWidth={1.25} className="text-muted" aria-hidden />
          <h3 className="text-xl font-medium tracking-tight">{session.title}</h3>
          <p className="max-w-md text-sm text-muted">{t('empty')}</p>
        </div>
      ) : null}
    </ChatView>
  );
}

function MeetingHeader({ title, config }: { title: string; config: MeetingConfig }) {
  const t = useTranslations('Meetings');
  const profiles = useModelProfiles();
  const label = (profile: string) =>
    profiles?.find((item) => item.profileId === profile)?.label ?? profile;
  return (
    <div className="flex min-w-0 flex-col gap-1 px-1 py-2">
      <h2 className="text-sm font-semibold">
        {t('heading')} · {title}
      </h2>
      <ul aria-label={t('participants')} className="flex flex-wrap gap-1.5 text-xs">
        {config.participants.map((participant) => (
          <li key={participant.participantId} className="rounded fill-group px-2 py-0.5">
            <span className="font-medium">{participant.name}</span>
            <span className="text-muted"> · {label(participant.modelProfile)}</span>
          </li>
        ))}
        <li className="rounded fill-group px-2 py-0.5 text-muted">
          {t('secretary')} · {label(config.secretary.modelProfile)}
        </li>
      </ul>
    </div>
  );
}

function MeetingMessage({ round, config }: { round: RoundView; config: MeetingConfig }) {
  const t = useTranslations('Meetings');
  const secretary = t('secretary');
  const addressed =
    round.kind === 'mention' || round.kind === 'secretary'
      ? round.participantIds.map((id) => nameOf(config, id, secretary)).join(', ')
      : null;
  return (
    <div className="mb-5 ml-auto flex max-w-[85%] flex-col gap-1 rounded-lg fill-group px-3 py-2 text-sm">
      <span className="text-xs text-muted">
        {t('you')}
        {addressed ? ` · ${t('to', { names: addressed })}` : ''}
      </span>
      <p className="whitespace-pre-wrap wrap-anywhere">{round.message}</p>
      {round.attachments?.length ? <TextAttachmentList attachments={round.attachments} /> : null}
    </div>
  );
}

function AnswerCard({
  answer,
  name,
  onOpenMinutes,
}: {
  answer: AnswerView;
  name: string;
  onOpenMinutes?: (() => void) | undefined;
}) {
  const t = useTranslations('Meetings');
  const detailed = useStore(preferences, (state) => state.chatDensity === 'detailed');
  const failed = ['failed', 'refused', 'interrupted', 'not_started'].includes(answer.status);
  return (
    <article aria-label={name} className="mb-5 flex min-w-0 flex-col gap-1.5">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="text-sm font-semibold">{name}</span>
        {answer.status !== 'answered' ? (
          <span
            role={answer.status === 'running' ? 'status' : undefined}
            className={failed ? 'text-danger' : 'text-muted'}
          >
            {t(`status.${answer.status}`)}
          </span>
        ) : null}
        {detailed && answer.runId ? (
          <Link to="/runs/$runId" params={{ runId: answer.runId }} className="text-muted underline">
            {t('openRun')}
          </Link>
        ) : null}
      </header>
      {answer.status === 'answered' && onOpenMinutes ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p>{t('minutesReady')}</p>
          <Button size="xs" variant="outline" onClick={onOpenMinutes}>
            {t('viewMinutes')}
          </Button>
        </div>
      ) : answer.text ? (
        <SafeMarkdown text={answer.text} />
      ) : answer.status === 'running' && answer.runId && answer.participantId !== SECRETARY_ID ? (
        <StreamingAnswer runId={answer.runId} />
      ) : null}
      {failed && answer.detail ? (
        <p className="text-xs text-danger wrap-anywhere">{answer.detail}</p>
      ) : null}
      {detailed && answer.usage ? (
        <p className="text-xs text-muted tabular-nums">
          {t('usage', { tokens: answer.usage.outputTokens, calls: answer.usage.modelCalls })}
          {answer.usage.unknown ? ` · ${t('usageUnknown')}` : ''}
        </p>
      ) : null}
    </article>
  );
}

function StreamingAnswer({ runId }: { runId: string }) {
  const { state } = useCorralRun(runId, true, false);
  const text = Object.entries(state.streams)
    .filter(([id, stream]) => {
      const call = state.projection?.modelCalls[id];
      return call && !call.finished && !stream.broken && !stream.completed;
    })
    .at(-1)?.[1].text;
  return text ? <SafeMarkdown text={text} /> : null;
}

function MeetingComposer({
  projectId,
  view,
  mode,
  error,
  onStop,
  send,
  sendQueued,
  dropQueued,
  editQueued,
}: {
  projectId: string;
  view: MeetingView;
  mode: 'mock' | 'live';
  error: string;
  onStop?: (() => void) | undefined;
  send(request: MeetingRoundRequest): Promise<MeetingResult | null>;
  sendQueued(): Promise<MeetingResult | null>;
  dropQueued(): Promise<MeetingResult | null>;
  editQueued(message: QueuedMeetingMessage): Promise<MeetingResult | null>;
}) {
  const t = useTranslations('Meetings');
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  // A message whose answer was lost keeps its command ID, so sending it again is the same command.
  const pending = useRef<{ key: string; commandId: string } | null>(null);
  const active = view.rounds.some((round) => round.active);
  const dispatch = async (
    request: Omit<Extract<MeetingRoundRequest, { kind: 'message' }>, 'commandId' | 'mode'>,
  ) => {
    if (inFlight.current || attachmentLoading) return;
    const key = JSON.stringify([request, mode]);
    if (pending.current?.key !== key) pending.current = { key, commandId: newCommandId() };
    inFlight.current = true;
    setSending(true);
    try {
      const result = await send({ ...request, commandId: pending.current.commandId, mode });
      if (result?.ok) pending.current = null;
      return result;
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const submit = async (message: string, chosen: string[]) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const result = await dispatch({
      kind: 'message',
      text: trimmed,
      ...(chosen.length ? { mentions: chosen } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    if (result?.ok) {
      setText((current) => (current === message ? '' : current));
      setMentions((current) => (current === chosen ? [] : current));
      setAttachments((current) => (current === attachments ? [] : current));
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit(text, mentions);
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg fill-group p-3 text-sm">
      {view.queued ? (
        <div role="status" className="flex flex-col gap-1 rounded fill-control p-2 text-xs">
          <span className="font-medium">{t('queued')}</span>
          <QueuedMessage
            key={view.queued.commandId}
            queued={view.queued}
            config={view.config}
            projectId={projectId}
            edit={editQueued}
          />
          <span className="text-muted">{active ? t('queuedHint') : t('queuedIdle')}</span>
          <div className="flex gap-2">
            {active ? null : (
              <Button size="xs" onClick={() => void sendQueued()}>
                {t('sendQueued')}
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => void dropQueued()}>
              {t('dropQueued')}
            </Button>
          </div>
        </div>
      ) : null}
      <MeetingRecipients
        config={view.config}
        selected={mentions}
        onChange={setMentions}
        disabled={sending}
      />
      <textarea
        aria-label={t('message')}
        placeholder={t('placeholder')}
        value={text}
        rows={2}
        maxLength={20000}
        className="w-full resize-y rounded fill-control px-2 py-1.5"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <p className="text-xs text-muted">{mentions.length ? null : t('everyone')}</p>
      <details
        aria-label={t('evidence')}
        open={attachments.length ? true : undefined}
        className="text-xs"
      >
        <summary className="cursor-pointer rounded py-1 text-muted focus-visible:outline-2 focus-visible:outline-ring">
          {attachments.length
            ? t('evidenceSelected', { count: attachments.length })
            : t('evidence')}
        </summary>
        <div className="pt-1">
          <MeetingEvidencePicker
            projectId={projectId}
            value={attachments}
            onChange={setAttachments}
            onLoading={setAttachmentLoading}
            disabled={sending}
          />
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={sending || attachmentLoading || !text.trim()}
          onClick={() => void submit(text, mentions)}
        >
          <Send size={14} aria-hidden />
          {t('send')}
        </Button>
        {onStop ? (
          <Button size="sm" variant="outline" onClick={onStop}>
            <Square size={12} aria-hidden />
            {t('stopRound')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={sending || attachmentLoading || view.rounds.length === 0}
          onClick={() =>
            void dispatch({ kind: 'message', text: t('summaryRequest'), mentions: [SECRETARY_ID] })
          }
        >
          {t('summarise')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger wrap-anywhere">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function QueuedMessage({
  queued,
  config,
  projectId,
  edit,
}: {
  queued: QueuedMeetingMessage;
  config: MeetingConfig;
  projectId: string;
  edit(message: QueuedMeetingMessage): Promise<MeetingResult | null>;
}) {
  const t = useTranslations('Meetings');
  const [text, setText] = useState(queued.text);
  const [mentions, setMentions] = useState(queued.mentions);
  const [attachments, setAttachments] = useState(queued.attachments ?? []);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  return editing ? (
    <div className="flex flex-col gap-2">
      <MeetingRecipients
        config={config}
        selected={mentions}
        onChange={setMentions}
        disabled={saving}
      />
      <textarea
        aria-label={t('queued')}
        value={text}
        maxLength={20000}
        rows={2}
        disabled={saving}
        className="w-full resize-y rounded fill-control px-2 py-1.5"
        onChange={(event) => setText(event.target.value)}
      />
      <MeetingEvidencePicker
        projectId={projectId}
        value={attachments}
        onChange={setAttachments}
        onLoading={setAttachmentLoading}
        disabled={saving}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          disabled={saving || attachmentLoading || !text.trim()}
          onClick={async () => {
            setSaving(true);
            try {
              const result = await edit({
                ...queued,
                text: text.trim(),
                mentions,
                ...(attachments.length || queued.attachments ? { attachments } : {}),
              });
              if (result?.ok) setEditing(false);
            } finally {
              setSaving(false);
            }
          }}
        >
          {t('saveQueued')}
        </Button>
        <Button size="xs" variant="outline" disabled={saving} onClick={() => setEditing(false)}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  ) : (
    <>
      <p className="whitespace-pre-wrap wrap-anywhere">{queued.text}</p>
      {queued.mentions.length ? (
        <p>
          {t('to', {
            names: queued.mentions.map((id) => nameOf(config, id, t('secretary'))).join(', '),
          })}
        </p>
      ) : null}
      {queued.attachments?.length ? <TextAttachmentList attachments={queued.attachments} /> : null}
      <div>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setText(queued.text);
            setMentions(queued.mentions);
            setAttachments(queued.attachments ?? []);
            setEditing(true);
          }}
        >
          {t('editQueued')}
        </Button>
      </div>
    </>
  );
}

function MeetingRecipients({
  config,
  selected,
  onChange,
  disabled,
}: {
  config: MeetingConfig;
  selected: string[];
  onChange(next: string[]): void;
  disabled: boolean;
}) {
  const t = useTranslations('Meetings');
  const people = [
    ...config.participants.map((participant) => ({
      id: participant.participantId,
      name: participant.name,
    })),
    { id: SECRETARY_ID, name: t('secretary') },
  ];
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5 text-xs" disabled={disabled}>
      <legend className="sr-only">{t('mentions')}</legend>
      <span aria-hidden className="text-muted">
        {t('mentions')}
      </span>
      {people.map((person) => (
        <Button
          key={person.id}
          type="button"
          size="xs"
          variant="outline"
          aria-pressed={selected.includes(person.id)}
          className="rounded-full aria-pressed:border-accent aria-pressed:text-accent"
          onClick={() =>
            onChange(
              selected.includes(person.id)
                ? selected.filter((id) => id !== person.id)
                : person.id === SECRETARY_ID
                  ? [SECRETARY_ID]
                  : [...selected.filter((id) => id !== SECRETARY_ID), person.id],
            )
          }
        >
          @{person.name}
        </Button>
      ))}
    </fieldset>
  );
}
