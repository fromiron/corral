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
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';
import { sessionRunMode } from '../workbench/autoChoice.ts';
import { ChatView } from '../workbench/ChatView.tsx';
import { MeetingDecisions } from '../workbench/MeetingDecisions.tsx';
import { MeetingEvidencePicker } from '../workbench/MeetingEvidence.tsx';
import { MeetingHandoffLinks } from '../workbench/MeetingHandoff.tsx';
import { TextAttachmentList } from '../workbench/TextAttachments.tsx';
import { useModelProfiles } from '../workbench/useModels.ts';

type RoundView = MeetingView['rounds'][number];
type AnswerView = RoundView['answers'][number];

const nameOf = (config: MeetingConfig, id: string, secretary: string) =>
  id === SECRETARY_ID
    ? secretary
    : (config.participants.find((p) => p.participantId === id)?.name ?? id);

/** CR-049: a meeting is a chat; only the person's message or rebuttal opens a round. */
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
  return (
    <ChatView
      centerEmpty
      sessionId={sessionId}
      header={
        <>
          <MeetingHeader title={session.title} config={view.config} />
          <details ref={recordsPanel} className="pb-2 text-sm">
            <summary className="cursor-pointer rounded py-1 font-medium focus-visible:outline-2 focus-visible:outline-ring">
              {t('records')}
            </summary>
            <div className="flex max-h-[40dvh] flex-col gap-4 overflow-y-auto py-3">
              <MeetingDecisions session={session} view={view} onChange={refresh} />
              <MeetingHandoffLinks sessionId={sessionId} meeting={view} onRediscuss={refresh} />
            </div>
          </details>
        </>
      }
      items={view.rounds.map((round) => ({
        id: round.roundId,
        content: (
          <RoundCard
            round={round}
            config={view.config}
            onStop={() => void act(() => meetings.stop(sessionId, round.roundId))}
            onOpenMinutes={
              view.minutes?.some((minutes) => minutes.roundId === round.roundId && minutes.document)
                ? () => {
                    if (!recordsPanel.current) return;
                    recordsPanel.current.open = true;
                    recordsPanel.current.querySelector('summary')?.focus();
                  }
                : undefined
            }
          />
        ),
      }))}
      composer={
        <MeetingComposer
          key={sessionId}
          projectId={session.projectId}
          view={view}
          mode={mode}
          error={error || loadError}
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

function RoundCard({
  round,
  config,
  onStop,
  onOpenMinutes,
}: {
  round: RoundView;
  config: MeetingConfig;
  onStop: () => void;
  onOpenMinutes?: (() => void) | undefined;
}) {
  const t = useTranslations('Meetings');
  const secretary = t('secretary');
  const addressed =
    round.kind === 'mention' || round.kind === 'secretary'
      ? round.participantIds.map((id) => nameOf(config, id, secretary)).join(', ')
      : null;
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={round.message ?? t('rebuttalRound', { number: round.rebuttalNo ?? 1 })}
    >
      {round.message === null ? (
        <p className="text-xs font-medium text-muted">
          {t('rebuttalRound', { number: round.rebuttalNo ?? 1 })}
        </p>
      ) : (
        <div className="ml-auto flex max-w-[85%] flex-col gap-1 rounded-lg fill-group px-3 py-2 text-sm">
          <span className="text-xs text-muted">
            {t('you')}
            {addressed ? ` · ${t('to', { names: addressed })}` : ''}
          </span>
          <p className="whitespace-pre-wrap wrap-anywhere">{round.message}</p>
          {round.attachments?.length ? (
            <TextAttachmentList attachments={round.attachments} />
          ) : null}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {round.answers.map((answer) => (
          <AnswerCard
            key={answer.participantId}
            answer={answer}
            name={nameOf(config, answer.participantId, secretary)}
            onOpenMinutes={answer.participantId === SECRETARY_ID ? onOpenMinutes : undefined}
          />
        ))}
      </div>
      {round.stoppedAt ? (
        <p role="status" className="text-xs text-muted">
          {t('roundStopped')}
        </p>
      ) : null}
      {round.active ? (
        <div>
          <Button size="xs" variant="outline" onClick={onStop}>
            <Square size={12} aria-hidden />
            {t('stopRound')}
          </Button>
        </div>
      ) : null}
    </section>
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
  const failed = ['failed', 'refused', 'interrupted', 'not_started'].includes(answer.status);
  return (
    <article
      aria-label={name}
      className="flex min-w-0 flex-col gap-1.5 border-l-2 border-line pl-3"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="text-sm font-semibold">{name}</span>
        <span
          role={answer.status === 'running' ? 'status' : undefined}
          className={failed ? 'text-danger' : 'text-muted'}
        >
          {t(`status.${answer.status}`)}
        </span>
        {answer.runId ? (
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
      ) : null}
      {failed && answer.detail ? (
        <p className="text-xs text-danger wrap-anywhere">{answer.detail}</p>
      ) : null}
      {answer.usage ? (
        <p className="text-xs text-muted tabular-nums">
          {t('usage', { tokens: answer.usage.outputTokens, calls: answer.usage.modelCalls })}
          {answer.usage.unknown ? ` · ${t('usageUnknown')}` : ''}
        </p>
      ) : null}
    </article>
  );
}

function MeetingComposer({
  projectId,
  view,
  mode,
  error,
  send,
  sendQueued,
  dropQueued,
  editQueued,
}: {
  projectId: string;
  view: MeetingView;
  mode: 'mock' | 'live';
  error: string;
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
    request:
      | Omit<Extract<MeetingRoundRequest, { kind: 'message' }>, 'commandId' | 'mode'>
      | Omit<Extract<MeetingRoundRequest, { kind: 'rebuttal' }>, 'commandId' | 'mode'>,
  ) => {
    if (inFlight.current || attachmentLoading || view.queued) return;
    if (request.kind === 'rebuttal' && !view.rebuttal) return;
    const key = JSON.stringify([request, mode, request.kind === 'rebuttal' ? view.rebuttal : null]);
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
    if (!trimmed || (/^\/반론(?:\s|$)/u.test(trimmed) && !view.rebuttal)) return;
    const result = await dispatch({
      kind: 'message',
      text: trimmed,
      ...(chosen.length ? { mentions: chosen } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    if (result?.ok) {
      setText('');
      setMentions([]);
      setAttachments([]);
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
        rows={3}
        maxLength={20000}
        disabled={sending}
        className="w-full resize-y rounded fill-control px-2 py-1.5"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <p className="text-xs text-muted">{mentions.length ? null : t('everyone')}</p>
      <MeetingEvidencePicker
        projectId={projectId}
        value={attachments}
        onChange={setAttachments}
        onLoading={setAttachmentLoading}
        disabled={sending}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={
            sending ||
            attachmentLoading ||
            !text.trim() ||
            Boolean(view.queued) ||
            (/^\/반론(?:\s|$)/u.test(text.trim()) && !view.rebuttal)
          }
          onClick={() => void submit(text, mentions)}
        >
          <Send size={14} aria-hidden />
          {t('send')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          title={t('rebuttalHint')}
          disabled={sending || attachmentLoading || !view.rebuttal || Boolean(view.queued)}
          onClick={() =>
            void dispatch({
              kind: 'rebuttal',
              ...(mentions.length && !mentions.includes(SECRETARY_ID) ? { mentions } : {}),
            })
          }
        >
          {t('rebuttal')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={sending || attachmentLoading || active || Boolean(view.queued)}
          onClick={() =>
            void dispatch({ kind: 'message', text: t('summaryRequest'), mentions: [SECRETARY_ID] })
          }
        >
          {t('summarise')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('noLimits')}</p>
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
