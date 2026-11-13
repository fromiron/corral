import { type MeetingConfig, type MeetingView, SECRETARY_ID } from '@corral/contracts';
import type { MeetingResult, WorkSession } from '@corral/core';
import { CopyTextButton, FailureNotice, SafeMarkdown } from '@corral/react';
import {
  AgentIdentity,
  type AgentStatus,
  AgentStatusLabel,
  Button,
  cn,
  fontWeights,
  KitChatMessage,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis, PanelRight } from '@corral/react/icons';
import { Link, useRouter } from '@tanstack/react-router';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useRegisterCommands } from '../commandRegistry.ts';
import { projectsChanged } from '../projects.ts';
import { useServices } from '../services.tsx';
import { ArchivedSessionNotice } from '../workbench/ArchivedSessionNotice.tsx';
import { sessionRunMode } from '../workbench/autoChoice.ts';
import { ChatDensityMenu, ChatView } from '../workbench/ChatView.tsx';
import { MeetingContinue } from '../workbench/MeetingContinue.tsx';
import { MeetingDecisions } from '../workbench/MeetingDecisions.tsx';
import { MeetingDiagnostics } from '../workbench/MeetingDiagnostics.tsx';
import { MeetingHandoffLinks } from '../workbench/MeetingHandoff.tsx';
import { MeetingParticipants } from '../workbench/MeetingParticipants.tsx';
import {
  MeetingRecordsDrawer,
  MeetingRecordsPanel,
  useNarrowScreen,
} from '../workbench/MeetingRecords.tsx';
import { MeetingRoundStatus } from '../workbench/MeetingRoundStatus.tsx';
import { answerLabel, HOLD_LABEL } from '../workbench/meetingActivity.ts';
import {
  answerOrder,
  continuedOrder,
  roundOrder,
  startedAnswer,
  stopLines,
} from '../workbench/meetingTimeline.ts';
import { preferences } from '../workbench/preferences.ts';
import { RenameSessionDialog } from '../workbench/RenameSessionDialog.tsx';
import { TurnActions } from '../workbench/RunMessage.tsx';
import { SessionDeletionDialog } from '../workbench/SessionDeletionDialog.tsx';
import { Composer } from '../workbench/session/Composer.tsx';
import {
  FAILED_ANSWER,
  type MeetingComposerHandle,
  nameOf,
} from '../workbench/session/composer/meeting.tsx';
import { TextAttachmentList } from '../workbench/TextAttachments.tsx';
import { TopbarActions } from '../workbench/TopbarSlot.tsx';
import { useCorralRun } from '../workbench/useCorralChat.ts';
import { useRemembered } from './Workbench.tsx';

type RoundView = MeetingView['rounds'][number];
type AnswerView = RoundView['answers'][number];

/** The command of the last continue of a held chain, if the meeting was ever continued. */
const lastContinue = (view: MeetingView) =>
  view.rounds.findLast((round) => round.continued)?.commandId;

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
  const composer = useRef<MeetingComposerHandle>(null);
  const [sent, setSent] = useState(0);
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
  const recordsToggle = useRef<HTMLButtonElement>(null);
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
          <Button variant="tertiary" onClick={() => void refresh()}>
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
        recordsToggle={recordsToggle}
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
            sent={sent}
            header={
              <>
                <MeetingParticipants
                  view={view}
                  onMention={(name) => composer.current?.mention(name)}
                />
                <ArchivedSessionNotice session={session} />
              </>
            }
            items={[
              ...view.rounds.flatMap((round, index) => [
                ...(round.continued
                  ? [
                      {
                        // A person chose to go on with the mention chain here.
                        id: `${round.roundId}:continued`,
                        order: continuedOrder(round, index),
                        content: (
                          <p role="status" className="mb-5 text-caption text-muted-foreground">
                            {t('continued')}
                          </p>
                        ),
                      },
                    ]
                  : []),
                ...(round.message === null
                  ? []
                  : [
                      {
                        id: `${round.roundId}:message`,
                        order: roundOrder(round, index),
                        content: <MeetingMessage round={round} config={view.config} />,
                      },
                    ]),
                // One not started has no row, whatever became of it: the activity bar says who
                // waits, and the row comes at the end once the answer starts.
                ...round.answers.flatMap((answer, n) =>
                  !startedAnswer(answer)
                    ? []
                    : [
                        {
                          id: `${round.roundId}:${answer.participantId}`,
                          order: answerOrder(round, index, answer, n),
                          content: (
                            <AnswerCard
                              answer={answer}
                              name={nameOf(view.config, answer.participantId, t('secretary'))}
                              onOpenMinutes={
                                answer.participantId === SECRETARY_ID &&
                                view.minutes?.some(
                                  (minutes) =>
                                    minutes.roundId === round.roundId && minutes.document,
                                )
                                  ? openRecords
                                  : undefined
                              }
                            />
                          ),
                        },
                      ],
                ),
              ]),
              // One stop, one line, at the end of what there was when it came.
              ...stopLines(view).map((stop) => ({
                id: `${stop.roundId}:stopped`,
                order: stop.order,
                content: (
                  <p role="status" className="mb-5 text-caption text-muted-foreground">
                    {t('roundStopped')}
                  </p>
                ),
              })),
            ].sort((a, b) => a.order - b.order)}
            tray={
              view.hold ? (
                // What the meeting needs from the person now: a held chain's continue card. The
                // card names itself; this place adds no second name.
                <div data-pending-tray className="pb-4">
                  <MeetingContinue
                    // A hold is where the chain stopped and the continue before it: held again
                    // at the same place after a continue, it is a new card with a new command.
                    key={`${view.hold.after}/${lastContinue(view) ?? ''}`}
                    hold={view.hold}
                    continueChain={(commandId) => meetings.continueChain(sessionId, { commandId })}
                    onSettled={refresh}
                  />
                </div>
              ) : null
            }
            composer={
              // The conversation's composer, with the recipients as its send target.
              <Composer
                key={sessionId}
                meeting={{
                  handle: composer,
                  projectId: session.projectId,
                  view,
                  mode,
                  error: error || loadError,
                  onStop: active
                    ? () => act(() => meetings.stop(sessionId, active.roundId))
                    : undefined,
                  onSent: () => setSent((count) => count + 1),
                  send: (request) => act(() => meetings.send(sessionId, request)),
                  sendQueued: () => act(() => meetings.sendQueued(sessionId)),
                  dropQueued: () => act(() => meetings.dropQueued(sessionId)),
                  editQueued: (message) => act(() => meetings.editQueued(sessionId, message)),
                }}
              />
            }
          >
            {view.rounds.length === 0 ? (
              // The path bar names the meeting; the empty room says only what to do next.
              <h3
                className="py-5 text-center text-title"
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {t('empty')}
              </h3>
            ) : null}
          </ChatView>
        </div>
        {narrow ? null : panelKept ? (
          <MeetingRecordsPanel
            open={recordsOpen}
            widened={widened}
            onWiden={setWidened}
            onClose={() => {
              showRecords(false);
              // The panel hides its close button; the drawer's dialog returns focus by itself.
              recordsToggle.current?.focus();
            }}
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
  recordsToggle,
  onToggleRecords,
}: {
  session: WorkSession;
  recordsOpen: boolean;
  recordsToggle: RefObject<HTMLButtonElement | null>;
  onToggleRecords(): void;
}) {
  const { repository, sessionDeletion } = useServices();
  const router = useRouter();
  const t = useTranslations('Sessions');
  const tm = useTranslations('Meetings');
  const td = useTranslations('Desktop');
  const command = useTranslations('Commands');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
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
    ...(sessionDeletion
      ? [
          {
            id: 'session:delete',
            title: command('deleteSession'),
            group,
            slash: 'delete',
            disabled: busy,
            run: () => setDeleting(true),
          },
        ]
      : []),
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
          ref={recordsToggle}
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
          {sessionDeletion ? (
            <MenuItem disabled={busy} onClick={() => setDeleting(true)}>
              {t('delete')}
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      <RenameSessionDialog
        title={renaming}
        busy={busy}
        onSave={(title) => update({ title })}
        onClose={() => setRenaming(null)}
      />
      <SessionDeletionDialog
        open={deleting}
        sessionId={session.sessionId}
        projectId={session.projectId}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          projectsChanged();
          void router.invalidate();
          void router.navigate({
            to: '/projects/$projectId',
            params: { projectId: session.projectId },
          });
        }}
      />
    </TopbarActions>
  );
}

/**
 * The person's message: the kit's sent bubble on the right, and its meta line with who receives
 * it, and the time and copy action the bubble reveals, as in a session.
 */
function MeetingMessage({ round, config }: { round: RoundView; config: MeetingConfig }) {
  const t = useTranslations('Meetings');
  const format = useFormatter();
  // The time alone on the day it was sent; the date joins it afterwards and in the tooltip.
  const created = new Date(round.createdAt);
  const dated = !Number.isNaN(created.getTime());
  const day = (date: Date) => format.dateTime(date, { dateStyle: 'short' });
  const full = dated ? format.dateTime(created, { timeStyle: 'short', dateStyle: 'short' }) : '';
  const when = !dated
    ? null
    : day(created) === day(new Date())
      ? format.dateTime(created, { timeStyle: 'short' })
      : full;
  return (
    <div className="chat-turn flex flex-col items-end gap-1">
      {/* As a conversation's sent message: the kit's entrance, not its position animation (the
          timeline holds every row in place itself), and one meta line that says who receives
          it, at its end. */}
      <KitChatMessage
        from="user"
        layout={false}
        metaProps={{ 'data-chat-part': 'meta', className: 'w-max max-w-[125%]' }}
        status={<MeetingRoundStatus round={round} config={config} />}
        time={
          when ? (
            <time dateTime={round.createdAt} title={full}>
              {when}
            </time>
          ) : undefined
        }
        actions={round.message ? <CopyTextButton text={round.message} /> : undefined}
      >
        <span className="sr-only">{t('you')}</span>
        <p className="wrap-anywhere">{round.message}</p>
        {round.attachments?.length ? <TextAttachmentList attachments={round.attachments} /> : null}
      </KitChatMessage>
    </div>
  );
}

/** The kit's status glyph for an answer that is not (yet) a reply. */
const ANSWER_GLYPH: Record<string, AgentStatus> = {
  running: 'running',
  waiting: 'queued',
  stopped: 'stopped',
};

/**
 * A participant's turn: their avatar and name head it, the answer reads in the kit's chat prose
 * in the foreground colour, and a quiet icon row under it copies the text.
 */
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
  const failed = FAILED_ANSWER.has(answer.status);
  const httpStatus = /\b(?:HTTP|status)\s*:?\s*(\d{3})\b/i.exec(answer.detail ?? '')?.[1];
  const minutes = answer.status === 'answered' && onOpenMinutes;
  return (
    <article
      aria-label={name}
      className="chat-turn turn-actions-scope flex min-w-0 flex-col gap-1.5 wrap-anywhere"
    >
      <header>
        <AgentIdentity
          name={name}
          avatarSize={20}
          trailing={
            <>
              {answer.status !== 'answered' ? (
                <AgentStatusLabel
                  // A running answer's head says who answers, as a conversation's state word: the
                  // activity bar says it while this word is out of view.
                  data-presence-label={
                    answer.status === 'running' && answer.runId
                      ? answerLabel(answer.runId)
                      : undefined
                  }
                  role={answer.status === 'running' ? 'status' : undefined}
                  status={failed ? 'failed' : (ANSWER_GLYPH[answer.status] ?? 'stopped')}
                  label={t(`status.${answer.status}`)}
                  className={failed ? 'text-danger' : undefined}
                />
              ) : null}
              {detailed && answer.runId ? (
                <Link
                  to="/runs/$runId"
                  params={{ runId: answer.runId }}
                  className="text-caption text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t('openRun')}
                </Link>
              ) : null}
            </>
          }
        />
      </header>
      {minutes ? (
        // The one place the minutes are offered: where the secretary posted them. The button
        // under the secretary's name says what is ready.
        <div className="flex flex-col items-start gap-2">
          <Button variant="secondary" onClick={onOpenMinutes}>
            <PanelRight />
            {t('viewMinutes')}
          </Button>
        </div>
      ) : answer.text ? (
        <SafeMarkdown text={answer.text} size="chat" />
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
      {answer.text && !minutes ? (
        <TurnActions>
          <CopyTextButton text={answer.text} />
        </TurnActions>
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
  return text ? <SafeMarkdown text={text} size="chat" /> : null;
}
