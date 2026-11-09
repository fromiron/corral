import {
  type MeetingConfig,
  type MeetingRoundRequest,
  type MeetingView,
  type QueuedMeetingMessage,
  SECRETARY_ID,
} from '@corral/contracts';
import { activeMeetingDecision, type MeetingResult, type WorkSession } from '@corral/core';
import { FailureNotice, SafeMarkdown } from '@corral/react';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  cn,
  InputMessage,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Textarea,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis, PanelRight, Square, Users } from '@corral/react/icons';
import { Link, useRouter } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useRegisterCommands } from '../commandRegistry.ts';
import { projectsChanged } from '../projects.ts';
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';
import { ArchivedSessionNotice } from '../workbench/ArchivedSessionNotice.tsx';
import { sessionRunMode } from '../workbench/autoChoice.ts';
import { ChatDensityMenu, ChatView } from '../workbench/ChatView.tsx';
import { MeetingDecisions } from '../workbench/MeetingDecisions.tsx';
import { MeetingDiagnostics } from '../workbench/MeetingDiagnostics.tsx';
import { MeetingEvidencePicker } from '../workbench/MeetingEvidence.tsx';
import { MeetingHandoffLinks } from '../workbench/MeetingHandoff.tsx';
import { MeetingParticipants } from '../workbench/MeetingParticipants.tsx';
import {
  MeetingRecordsDrawer,
  MeetingRecordsPanel,
  useNarrowScreen,
} from '../workbench/MeetingRecords.tsx';
import { isSendKey, preferences } from '../workbench/preferences.ts';
import { RenameSessionDialog } from '../workbench/RenameSessionDialog.tsx';
import {
  COMPOSER_DRAFT_SENT,
  clearSentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '../workbench/sessionDraft.ts';
import { TextAttachmentList } from '../workbench/TextAttachments.tsx';
import { TopbarActions } from '../workbench/TopbarSlot.tsx';
import { useCorralRun } from '../workbench/useCorralChat.ts';
import { useRemembered } from './Workbench.tsx';

type RoundView = MeetingView['rounds'][number];
type AnswerView = RoundView['answers'][number];

/** The kit's `fontWeights.semibold`, which the kit entry does not export. */
const SEMIBOLD = "'wght' 550, 'opsz' 18";

const nameOf = (config: MeetingConfig, id: string, secretary: string) =>
  id === SECRETARY_ID
    ? secretary
    : (config.participants.find((p) => p.participantId === id)?.name ?? id);

/** What the participant row asks of the composer. */
interface ComposerHandle {
  /** Puts `@name ` at the caret and focuses the input, without sending. */
  mention(name: string): void;
}

/**
 * The meeting room: participants on top, the conversation, then the composer. The minutes,
 * decisions and handoff open beside it on a wide screen and over it on a narrow one.
 * Stored response groups retain their command identities; the conversation shows messages.
 */
export function MeetingPage({ session }: { session: WorkSession }) {
  const services = useServices();
  const { meetings } = services;
  const t = useTranslations('Meetings');
  const [view, setView] = useState<MeetingView | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const refreshId = useRef(0);
  const sessionId = session.sessionId;
  const composer = useRef<ComposerHandle>(null);
  const narrow = useNarrowScreen();
  // The side panel's open state is this meeting's; the drawer opens only when asked.
  const [panelOpen, rememberPanel] = useRemembered<boolean>(
    `corral:meeting-records:v1:${sessionId}`,
    false,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [widened, setWidened] = useState(false);
  const recordsOpen = narrow ? drawerOpen : panelOpen === true;
  // Once opened, the side panel stays mounted while closed so a decision draft survives.
  const [panelKept, setPanelKept] = useState(false);
  if (!narrow && recordsOpen && !panelKept) setPanelKept(true);
  const recordsHeading = useRef<HTMLHeadingElement>(null);
  const focusRecords = useRef(false);
  const showRecords = (open: boolean) => {
    if (!open) setWidened(false);
    if (narrow) setDrawerOpen(open);
    else rememberPanel(open);
  };
  const openRecords = () => {
    if (recordsOpen && !narrow) {
      recordsHeading.current?.focus();
      return;
    }
    focusRecords.current = true;
    showRecords(true);
  };
  useEffect(() => {
    if (!recordsOpen || !focusRecords.current) return;
    focusRecords.current = false;
    // The drawer moves focus itself (its initial focus is the same heading).
    if (!narrow) recordsHeading.current?.focus();
  }, [recordsOpen, narrow]);
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
      <div role={loadError ? 'alert' : 'status'} className="flex flex-col gap-2 p-4 text-body">
        <p>{loadError || '…'}</p>
        {loadError ? (
          <Button size="compact" variant="tertiary" onClick={() => void refresh()}>
            {t('retry')}
          </Button>
        ) : null}
      </div>
    );
  const mode = sessionRunMode(services.mode, services.live);
  const active = view.rounds.find((round) => round.active);
  // Widened records take the conversation's place; the composer keeps its own.
  const recordsWide = !narrow && recordsOpen && widened;
  const records = (
    <div className="flex min-w-0 flex-col gap-4">
      <MeetingDecisions session={session} view={view} onChange={refresh} />
      <MeetingHandoffLinks sessionId={sessionId} meeting={view} onRediscuss={refresh} />
    </div>
  );
  return (
    <>
      <MeetingActions
        session={session}
        recordsOpen={recordsOpen}
        onToggleRecords={() => showRecords(!recordsOpen)}
      />
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div
          className={cn('flex min-h-0 min-w-0 flex-col', recordsWide ? 'w-88 shrink-0' : 'flex-1')}
        >
          <ChatView
            centerEmpty
            expandedHeader={recordsWide}
            sessionId={sessionId}
            header={
              <>
                <MeetingParticipants
                  view={view}
                  onMention={(name) => composer.current?.mention(name)}
                />
                <ArchivedSessionNotice session={session} />
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
                          ? openRecords
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
                          <p role="status" className="mb-5 text-caption text-muted-foreground">
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
                handle={composer}
                projectId={session.projectId}
                view={view}
                mode={mode}
                error={error || loadError}
                onOpenRecords={openRecords}
                onStop={
                  active
                    ? () => void act(() => meetings.stop(sessionId, active.roundId))
                    : undefined
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
                <Users size={28} strokeWidth={1.25} className="text-muted-foreground" aria-hidden />
                <h3 className="text-title" style={{ fontVariationSettings: SEMIBOLD }}>
                  {session.title}
                </h3>
                <p className="max-w-md text-body text-muted-foreground">{t('empty')}</p>
              </div>
            ) : null}
          </ChatView>
        </div>
        {narrow ? null : panelKept ? (
          <MeetingRecordsPanel
            open={recordsOpen}
            widened={widened}
            onWiden={setWidened}
            onClose={() => showRecords(false)}
            headingRef={recordsHeading}
          >
            {records}
          </MeetingRecordsPanel>
        ) : null}
      </div>
      {narrow ? (
        <MeetingRecordsDrawer
          open={drawerOpen}
          onClose={() => showRecords(false)}
          headingRef={recordsHeading}
        >
          {records}
        </MeetingRecordsDrawer>
      ) : null}
    </>
  );
}

/**
 * The meeting's toolbar in the top bar: the records toggle and the page menu, which leads with
 * the display density like a session's. Rename, pin and archive are the session commands the
 * path's menu also runs; a meeting's revision moves with every message, so each change reads
 * the session just before it and reports a conflict instead of retrying.
 */
function MeetingActions({
  session,
  recordsOpen,
  onToggleRecords,
}: {
  session: WorkSession;
  recordsOpen: boolean;
  onToggleRecords(): void;
}) {
  const { repository } = useServices();
  const router = useRouter();
  const t = useTranslations('Sessions');
  const tm = useTranslations('Meetings');
  const td = useTranslations('Desktop');
  const command = useTranslations('Commands');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const update = async (change: { title?: string; pinned?: boolean; archived?: boolean }) => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      const current = await repository.getSession(session.sessionId);
      if (!current) {
        setError(t('notFound'));
        return false;
      }
      const result = await repository.updateSession(session.sessionId, {
        ...change,
        expectedRevision: current.revision,
      });
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      projectsChanged();
      await router.invalidate();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const group = command('groups.session');
  useRegisterCommands('session', [
    {
      id: 'session:rename',
      title: command('rename'),
      group,
      slash: 'rename',
      disabled: busy,
      run: () => setRenaming(session.title),
    },
    {
      id: 'session:pin',
      title: command(session.pinned ? 'unpin' : 'pin'),
      group,
      slash: session.pinned ? 'unpin' : 'pin',
      disabled: busy,
      run: async () => {
        await update({ pinned: !session.pinned });
      },
    },
    {
      id: 'session:archive',
      title: command(session.archivedAt ? 'restore' : 'archive'),
      group,
      slash: session.archivedAt ? 'restore' : 'archive',
      disabled: busy,
      run: async () => {
        await update({ archived: !session.archivedAt });
      },
    },
  ]);
  return (
    <TopbarActions>
      {error ? (
        <p role="alert" className="max-w-64 truncate text-caption text-danger" title={error}>
          {error}
        </p>
      ) : null}
      <Tooltip content={tm('records')}>
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={tm('records')}
          aria-pressed={recordsOpen}
          onClick={onToggleRecords}
        >
          <PanelRight />
        </Button>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={td('sessionActions', { title: session.title })}
            />
          }
        >
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          {/* The page's display choice leads its menu. */}
          <ChatDensityMenu />
          <MenuSeparator />
          <MenuItem disabled={busy} onClick={() => setRenaming(session.title)}>
            {td('rename')}
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => void update({ pinned: !session.pinned })}>
            {t(session.pinned ? 'unpin' : 'pin')}
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => void update({ archived: !session.archivedAt })}>
            {t(session.archivedAt ? 'restore' : 'archive')}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <RenameSessionDialog
        title={renaming}
        busy={busy}
        onSave={(title) => update({ title })}
        onClose={() => setRenaming(null)}
      />
    </TopbarActions>
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
    <div className="mb-5 ml-auto flex max-w-[85%] flex-col gap-1 rounded-lg fill-group px-3 py-2 text-body">
      <span className="text-caption text-muted-foreground">
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
  const httpStatus = /\b(?:HTTP|status)\s*:?\s*(\d{3})\b/i.exec(answer.detail ?? '')?.[1];
  return (
    <article aria-label={name} className="mb-5 flex min-w-0 flex-col gap-1.5">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
        <span className="text-body" style={{ fontVariationSettings: SEMIBOLD }}>
          {name}
        </span>
        {answer.status !== 'answered' ? (
          <span
            role={answer.status === 'running' ? 'status' : undefined}
            className={failed ? 'text-danger' : 'text-muted-foreground'}
          >
            {t(`status.${answer.status}`)}
          </span>
        ) : null}
        {detailed && answer.runId ? (
          <Link
            to="/runs/$runId"
            params={{ runId: answer.runId }}
            className="text-muted-foreground underline"
          >
            {t('openRun')}
          </Link>
        ) : null}
      </header>
      {answer.status === 'answered' && onOpenMinutes ? (
        <div className="flex flex-wrap items-center gap-2 text-body">
          <p>{t('minutesReady')}</p>
          <Button size="compact" variant="tertiary" onClick={onOpenMinutes}>
            {t('viewMinutes')}
          </Button>
        </div>
      ) : answer.text ? (
        <SafeMarkdown text={answer.text} />
      ) : answer.status === 'answered' ? (
        <p className="text-body text-muted-foreground">{t('answerNotKept')}</p>
      ) : answer.status === 'running' && answer.runId && answer.participantId !== SECRETARY_ID ? (
        <StreamingAnswer runId={answer.runId} />
      ) : null}
      {failed && answer.detail ? (
        answer.detail.startsWith('the model request failed: ') ? (
          <FailureNotice message={answer.detail} />
        ) : (
          <div className="text-caption">
            <p className="text-danger">
              {t(httpStatus ? 'requestFailed' : 'answerFailedHint', { status: httpStatus ?? '' })}
            </p>
            <MeetingDiagnostics text={answer.detail} />
          </div>
        )
      ) : null}
      {detailed && answer.usage ? (
        <p className="text-caption text-muted-foreground tabular-nums">
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
  handle,
  projectId,
  view,
  mode,
  error,
  onStop,
  onOpenRecords,
  send,
  sendQueued,
  dropQueued,
  editQueued,
}: {
  handle: Ref<ComposerHandle>;
  projectId: string;
  view: MeetingView;
  mode: 'mock' | 'live';
  error: string;
  onStop?: (() => void) | undefined;
  onOpenRecords(): void;
  send(request: MeetingRoundRequest): Promise<MeetingResult | null>;
  sendQueued(): Promise<MeetingResult | null>;
  dropQueued(): Promise<MeetingResult | null>;
  editQueued(message: QueuedMeetingMessage): Promise<MeetingResult | null>;
}) {
  const t = useTranslations('Meetings');
  const sendKey = useStore(preferences, (state) => state.sendKey);
  const [restored] = useState(() => readComposerDraft(view.sessionId));
  const [text, setText] = useState(restored.text);
  const [mentions, setMentions] = useState(restored.meetingMentions ?? []);
  const [attachments, setAttachments] = useState(restored.attachments ?? []);
  const draft = useMemo(
    () => ({
      text,
      meetingMentions: mentions,
      attachments,
      intent: null,
      target: null,
      targetLabel: null,
      references: [],
    }),
    [text, mentions, attachments],
  );
  const draftRevision = useRef(0);
  useEffect(() => {
    draftRevision.current = writeComposerDraft(view.sessionId, draft);
  }, [view.sessionId, draft]);
  useEffect(() => {
    const sent = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; revision: number }>).detail;
      if (detail.sessionId !== view.sessionId || detail.revision !== draftRevision.current) return;
      setText('');
      setMentions([]);
      setAttachments([]);
    };
    window.addEventListener(COMPOSER_DRAFT_SENT, sent);
    return () => window.removeEventListener(COMPOSER_DRAFT_SENT, sent);
  }, [view.sessionId]);
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
    const submittedRevision = writeComposerDraft(view.sessionId, draft);
    const result = await dispatch({
      kind: 'message',
      text: trimmed,
      ...(chosen.length ? { mentions: chosen } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    if (result?.ok) clearSentComposerDraft(view.sessionId, submittedRevision);
  };
  const input = useRef<HTMLTextAreaElement>(null);
  // The kit's field sends on any unshifted Enter and checks only `isComposing`. The meeting owns
  // Enter before it: the chosen send key decides, and an IME's confirming Enter (keyCode 229 in
  // Safari) never sends.
  const onEnterCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== input.current || event.key !== 'Enter') return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !isSendKey(event, sendKey))
      return;
    event.preventDefault();
    void submit(text, mentions);
  };
  // Where the caret goes once an inserted mention is in the field (a new object each time).
  const [mentionCaret, setMentionCaret] = useState<{ at: number } | null>(null);
  useImperativeHandle(
    handle,
    () => ({
      mention(name) {
        const box = input.current;
        const start = box?.selectionStart ?? text.length;
        const end = box?.selectionEnd ?? start;
        const before = text.slice(0, start);
        const token = `${before && !/\s$/.test(before) ? ' ' : ''}@${name} `;
        setText(`${before}${token}${text.slice(end)}`);
        setMentionCaret({ at: start + token.length });
      },
    }),
    [text],
  );
  useLayoutEffect(() => {
    if (!mentionCaret || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(mentionCaret.at, mentionCaret.at);
  }, [mentionCaret]);
  const latestMinutes = view.minutes?.at(-1);
  const latestSecretary = view.rounds
    .findLast((round) => round.kind === 'secretary')
    ?.answers.find((answer) => answer.participantId === SECRETARY_ID);
  const summaryFailed = Boolean(
    latestMinutes?.error ||
      (latestSecretary &&
        ['failed', 'refused', 'interrupted', 'not_started'].includes(latestSecretary.status)),
  );
  const hasDecision = view.decisions?.some((decision) =>
    activeMeetingDecision(view, decision.versionId),
  );
  const hasCandidate = view.minutes?.some((minutes) => minutes.document?.candidates.length);
  return (
    <div
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2"
      onKeyDownCapture={onEnterCapture}
    >
      <InputMessage
        data-slot="composer-host"
        inputRef={input}
        value={text}
        onValueChange={setText}
        // Sending never waits for the answers: no `status`, so the kit never queues or swaps Send.
        onSend={() => void submit(text, mentions)}
        placeholder={t('placeholder')}
        minRows={2}
        sendLabel={t('send')}
        sendDisabled={sending || attachmentLoading}
        textareaProps={{ 'aria-label': t('message'), maxLength: 20000 }}
        contentSlot={
          <>
            {summaryFailed ? (
              <Banner role="alert" status="error" contrast="high" size="compact">
                <BannerTitle>{t('summaryFailed')}</BannerTitle>
                <BannerActions>
                  <Button
                    size="compact"
                    variant="tertiary"
                    disabled={sending || active}
                    onClick={() =>
                      void dispatch({
                        kind: 'message',
                        text: t('summaryRequest'),
                        mentions: [SECRETARY_ID],
                      })
                    }
                  >
                    {t('retrySummary')}
                  </Button>
                </BannerActions>
              </Banner>
            ) : null}
            {view.rounds.length > 0 && !hasDecision ? (
              <div className="flex flex-wrap items-center gap-2 px-1 text-caption text-muted-foreground">
                <p>{t(hasCandidate ? 'handoffNeedsAdoption' : 'handoffNeedsMinutes')}</p>
                {hasCandidate ? (
                  <Button size="compact" variant="tertiary" onClick={onOpenRecords}>
                    {t('viewMinutes')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {view.queued ? (
              <div
                role="status"
                className="flex flex-col gap-1 rounded-lg fill-control p-2 text-caption"
              >
                <span style={{ fontVariationSettings: SEMIBOLD }}>{t('queued')}</span>
                <QueuedMessage
                  key={view.queued.commandId}
                  queued={view.queued}
                  config={view.config}
                  projectId={projectId}
                  edit={editQueued}
                />
                <span className="text-muted-foreground">
                  {active ? t('queuedHint') : t('queuedIdle')}
                </span>
                <div className="flex gap-2">
                  {active ? null : (
                    <Button size="compact" onClick={() => void sendQueued()}>
                      {t('sendQueued')}
                    </Button>
                  )}
                  <Button size="compact" variant="tertiary" onClick={() => void dropQueued()}>
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
            {mentions.length ? null : (
              <p className="px-1 text-caption text-muted-foreground">{t('everyone')}</p>
            )}
            <details
              aria-label={t('evidence')}
              open={attachments.length ? true : undefined}
              className="px-1 text-caption"
            >
              <summary className="cursor-pointer rounded-sm py-1 text-muted-foreground focus-visible:outline-2 focus-visible:outline-focus-ring">
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
          </>
        }
        leftSlot={
          <>
            <Button
              size="compact"
              variant="ghost"
              disabled={sending || attachmentLoading || view.rounds.length === 0}
              onClick={() =>
                void dispatch({
                  kind: 'message',
                  text: t('summaryRequest'),
                  mentions: [SECRETARY_ID],
                })
              }
            >
              {t('summarise')}
            </Button>
            {text || mentions.length || attachments.length ? (
              <Button
                size="compact"
                variant="ghost"
                disabled={sending}
                onClick={() => {
                  setText('');
                  setMentions([]);
                  setAttachments([]);
                }}
              >
                {t('clearDraft')}
              </Button>
            ) : null}
          </>
        }
        rightSlot={
          onStop ? (
            <Button size="compact" variant="tertiary" onClick={onStop}>
              <Square size={12} aria-hidden />
              {t('stopRound')}
            </Button>
          ) : null
        }
      />
      {error ? (
        <p role="alert" className="px-1 text-caption text-danger wrap-anywhere">
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
      <Textarea
        aria-label={t('queued')}
        value={text}
        maxLength={20000}
        rows={2}
        disabled={saving}
        className="w-full"
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
          size="compact"
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
        <Button
          size="compact"
          variant="tertiary"
          disabled={saving}
          onClick={() => setEditing(false)}
        >
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
          size="compact"
          variant="tertiary"
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
    <fieldset className="flex flex-wrap items-center gap-1 px-1 text-caption" disabled={disabled}>
      <legend className="sr-only">{t('mentions')}</legend>
      <span aria-hidden className="pr-1 text-muted-foreground">
        {t('mentions')}
      </span>
      {/* The chosen recipients take the kit's selected treatment. */}
      {people.map((person) => (
        <Button
          key={person.id}
          type="button"
          size="compact"
          variant={selected.includes(person.id) ? 'secondary' : 'ghost'}
          aria-pressed={selected.includes(person.id)}
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
