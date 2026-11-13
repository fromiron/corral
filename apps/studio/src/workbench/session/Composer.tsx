import {
  type AutoModelChoice,
  IMAGE_MAX_COUNT,
  TERMINAL_RUN_STATUSES,
  TEXT_ATTACHMENT_MAX_COUNT,
} from '@corral/contracts';
import type { CorralSummary, RunSummary, SessionEntry, WorkSession } from '@corral/core';
import { useCancelConfirmation } from '@corral/react';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useRegisterCommands, useRegisteredCommands } from '../../commandRegistry.ts';
import { useRemembered } from '../../pages/Workbench.tsx';
import { projectsChanged } from '../../projects.ts';
import { useServices } from '../../services.tsx';
import { useShortcutBindings } from '../../shortcutBindings.ts';
import { sessionRunMode } from '../autoChoice.ts';
import { ComposerSurface } from '../ComposerSurface.tsx';
import type { SendChoice, SendKeyRole } from '../composerIntent.ts';

import { removeMention, selectMention } from '../composerMenu.ts';
import type { FileReference } from '../FilePanel.tsx';
import { usePreferences } from '../preferences.ts';
import { clearSentComposerDraft, readComposerDraft } from '../sessionDraft.ts';
import { useMentionSearch } from '../useMentionSearch.ts';
import { useModelProfiles, useTeamRoles } from '../useModels.ts';
import type { FolderAccess } from '../WorkFolderNotice.tsx';
import { ComposerActivity } from './ComposerActivity.tsx';
import { ComposerQueue } from './ComposerQueue.tsx';
import { ComposerHeader, ComposerStatus, PreRun } from './ComposerStatus.tsx';
import { AdvisorControl, openAdvisorControl } from './composer/AdvisorControl.tsx';
import { composerAvailability } from './composer/availability.ts';
import { ComposerCard, type SendTarget } from './composer/ComposerCard.tsx';
import { ComposerNotices } from './composer/ComposerNotices.tsx';
import {
  AttachMenu,
  insertMentionTrigger,
  RequestTools,
  StartSuggestions,
  TeamChoice,
  WorkFolderEntry,
} from './composer/ComposerTools.tsx';
import {
  compactContext,
  composerCommands,
  type RunCommandFailure,
  runCommand,
} from './composer/commands.ts';
import { MaterialsDialog, ModelsDialog, StopRunDialog } from './composer/dialogs.tsx';
import { backToInput as backToInputOf } from './composer/focus.ts';
import { useComposerKeys } from './composer/keys.ts';
import { type MeetingComposerProps, MeetingSend } from './composer/meeting.tsx';
import { useQueuedRequests } from './composer/queue.ts';
import { menuSends, SendMenu, TargetChip } from './composer/SendControls.tsx';
import {
  type AutoRequest,
  type CommandSlot,
  cancelAutoRequest,
  newCommandId,
  pendingSessionCommands,
  type Refusal,
  sendRequest,
} from './composer/send.ts';
import { useComposerDraft, useFileReference } from './composer/useComposerDraft.ts';
import { useComposerIntent } from './composer/useIntent.ts';
import { useSteerTargets } from './composer/useRunState.ts';
import { useSessionSettings } from './composer/useSessionSettings.ts';
import { useVoiceTranscript } from './composer/voice.ts';
import { useSettledAppearance } from './settle.ts';
import { useActiveExecutionCount, useCommandSending } from './useActivity.ts';

/**
 * The composer (features/composer-flow.md "화면 틀"): one component for a conversation and a
 * meeting. Both draw the same card; the send target adapter decides where a send goes — the join
 * target in a conversation, the recipients in a meeting — and which tools the place supports.
 */
export function Composer(props: ComposerProps) {
  return 'meeting' in props ? <MeetingSend {...props.meeting} /> : <SessionComposer {...props} />;
}

export type ComposerProps = SessionComposerProps | { meeting: MeetingComposerProps };
type SessionComposerProps = Parameters<typeof SessionComposer>[0];

function SessionComposer({
  session,
  team,
  corrals,
  runs,
  active,
  selectedRunId,
  onViewRun,
  revealRun,
  queued,
  onChange,
  onSent,
  reference,
  onReferenceUsed,
  runControlsOwnConfirmation = false,
  home = false,
  onWorkFolder,
  folderAccess = 'unknown',
  onFolderAction,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  corrals: CorralSummary[];
  runs: RunSummary[];
  active: RunSummary | null;
  selectedRunId: string | null;
  onViewRun?: (runId: string) => void;
  /** Brings a run's item into the conversation's window (`null` lets it go); false without one. */
  revealRun?: (runId: string | null) => boolean;
  queued: SessionEntry[];
  onChange: () => void;
  /** The person sent. The conversation follows the end again. */
  onSent?: () => void;
  reference: FileReference | null;
  onReferenceUsed: () => void;
  /** The active session view already has one RunActions confirmation host. */
  runControlsOwnConfirmation?: boolean;
  /** An empty session: the kit home composition offers the saved teams as start suggestions. */
  home?: boolean;
  /** Opens file-work setup; given while the project has no work folder yet. */
  onWorkFolder?: () => void;
  /** Whether this session's agent can read and change files. Unknown hides the notice. */
  folderAccess?: FolderAccess;
  /** The one next step, when the notice has one: link, trust, or check the folder. */
  onFolderAction?: () => void;
}) {
  useShortcutBindings();
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const format = useFormatter();
  const destinationId = useId();
  const tr = useTranslations('Reins');
  const tStatus = useTranslations('RunStatus');
  const tActivity = useTranslations('Activity');
  const tApprovals = useTranslations('Approvals');
  const services = useServices();
  const { mode, live } = services;
  const prefs = usePreferences();
  const router = useRouter();
  const invalidate = () => router.invalidate();
  // UX-02: the draft comes back with its intent, target and exact references.
  const [restored] = useState(() => readComposerDraft(session.sessionId));
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const textFiles = useRef<HTMLInputElement>(null);
  const imageFiles = useRef<HTMLInputElement>(null);
  const autoSaving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // sessions are live wherever live is possible; simulation stays in the demo and
  // the team editor.
  const runMode = sessionRunMode(mode, live);
  const [busy, setBusy] = useState(false);
  const [choosingAuto, setChoosingAuto] = useState(false);
  const autoRequest = useRef<AutoRequest | null>(null);
  const cancelAuto = useCallback(
    () => cancelAutoRequest(services, session.sessionId, autoRequest.current, newCommandId),
    [services, session.sessionId],
  );
  useEffect(() => () => cancelAuto(), [cancelAuto]);
  const [error, setError] = useState<string | null>(null);
  // UX-04: why the last request did not start; the text stays in the box to send again.
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [autoModelOpen, setAutoModelOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  // UX-06: which model each role uses, and whether it is connected.
  const profiles = useModelProfiles();
  const failed = (message: string) => t('failed', { message });
  const {
    autoChoice,
    updateAuto,
    updateTeam,
    autoStart,
    updateAutoStart,
    advisor,
    advisorUnknown,
    advisorSaving,
    advisorProblem,
    updateAdvisor,
    recheckAdvisor,
  } = useSessionSettings({
    session,
    profiles,
    busy,
    setBusy,
    setError,
    autoSaving,
    mounted,
    failed,
  });
  const isAuto = session.corralId === null;
  const missingTeam = !isAuto && !team;
  // without a saved Corral, the lead works alone or leads the auto roster.
  const [teamMode, setTeamMode] = useRemembered<'none' | 'auto'>(
    `corral:team-mode:${session.sessionId}`,
    'none',
  );
  const roles = useTeamRoles(team);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (session.entries.length === 0) input.current?.focus();
  }, [session.entries.length]);
  const ownActive =
    active?.sessionId === session.sessionId && !TERMINAL_RUN_STATUSES.has(active.status)
      ? active
      : null;
  const [confirmStop, setConfirmStop] = useCancelConfirmation(
    ownActive?.runId ?? null,
    ownActive?.status === 'cancelling',
  );
  // a follow-up carries the session's turns through the newest ended run.
  const lastEnded = runs.findLast((run) => TERMINAL_RUN_STATUSES.has(run.status)) ?? null;
  const searchMentions = useMentionSearch({
    projectId: session.projectId,
    sessionId: session.sessionId,
    runs,
    team,
  });
  const pending = useRef(pendingSessionCommands.get(session.sessionId) ?? null);
  const sending = useRef(false);
  const commands: CommandSlot = {
    sessionId: session.sessionId,
    pending,
    store: pendingSessionCommands,
    newId: newCommandId,
    sending,
  };
  // An interrupt the runtime could not deliver was read at the next request instead.
  const [lowered, setLowered] = useState(false);

  const { targets, lead, ready, ended, targetNames } = useSteerTargets(ownActive, restored);
  // Once the run's own record says it ended, the composer is idle at once, before the run list
  // says so: a send is a new request that carries the conversation through that run.
  const going = ended ? null : ownActive;
  const waitingOn = ended && active?.runId === ownActive?.runId ? null : active;
  const throughRunId = (ended ? ownActive?.runId : lastEnded?.runId) ?? null;
  const draft = useComposerDraft({
    session,
    team,
    runs,
    restored,
    busy,
    input,
    targetLabel: (id) => targetNames.current.get(id) ?? null,
    onEditRequest: () => setRefusal(null),
  });
  const { text, permissionMode, setPermissionMode, attachments, setAttachments } = draft;
  const { images, picked, setPicked, missing } = draft;
  const {
    situation,
    keys: sendKeys,
    blocked,
    loading,
    intent,
    forKey,
    forChoice,
    steerTarget,
    targetName,
    write,
    chooseIntent,
    chooseTarget,
  } = useComposerIntent({
    draft,
    targets,
    lead,
    ready,
    targetNames,
    ownActive: going,
    active: waitingOn,
  });
  useFileReference({ reference, input, text, write, setPicked, onReferenceUsed });
  const { references, chips, missingChips } = draft;
  // Whether a send of this intent can go now, and why not. Until the run's record is read the
  // send key's target is unknown; only an explicit next request goes meanwhile.
  const availableFor = (sendIntent: typeof intent, explicitQueue = false) =>
    composerAvailability({
      intent: sendIntent,
      runMode,
      live,
      isAuto,
      missingTeam,
      roles,
      profiles,
      autoChoice,
      draft,
      // A fixed target that ended holds its instruction; a next request is another send.
      blocked: sendIntent === 'steer' ? blocked : null,
      steerTarget,
      loading: loading && !explicitQueue,
    });
  const { notReady, autoBlocked, autoProfile, reasoningBlocked, ...availability } =
    availableFor(intent);
  const { liveUnavailable, savedRequestUnavailable, unavailable, heldForNew } = availability;

  const startDeps = {
    services,
    session,
    choice: autoChoice,
    teamMode,
    throughRunId,
    missingTeam,
    messages: { selectedTeamMissing: t('selectedTeamMissing'), failed },
    commands,
    autoRequest,
    onChoosingAuto: setChoosingAuto,
    onTitleChange: projectsChanged,
    invalidate,
    onChange,
    setBusy,
    setError,
  };
  const onTranscript = useVoiceTranscript(
    {
      ...startDeps,
      hostId: window.location.origin,
      ownActive,
      targets,
      permissionMode,
      autoSaving,
      mounted,
      onSent,
    },
    busy,
  );

  // A refused or lost send is tried again the way it was sent.
  const lastPick = useRef<{ role: SendKeyRole } | { choice: SendChoice }>({ role: 'send' });
  /** Sends as a key, or a choice in the send menu, says (features/composer-flow.md "전송"). */
  const send = async (pick: { role: SendKeyRole } | { choice: SendChoice }) => {
    const body = text.trim();
    const how = 'role' in pick ? forKey(pick.role) : forChoice(pick.choice);
    const explicitQueue = 'role' in pick ? pick.role === 'queue' : pick.choice === 'queue';
    if (!body || busy || autoSaving.current || availableFor(how.intent, explicitQueue).unavailable)
      return;
    // Whether the advisor rides along is not known: the session is read first, or nothing goes.
    if (advisorUnknown && !(await recheckAdvisor())) {
      if (mounted.current) setError(tc('advisor.unconfirmedSend'));
      return;
    }
    onSent?.();
    lastPick.current = pick;
    setLowered(false);
    const revision = draft.submit();
    const outcome = await sendRequest(
      {
        ...startDeps,
        team,
        ownActive,
        runMode,
        setRefusal,
        clearDraft: (sent, keepAttachments, keepImages) =>
          clearSentComposerDraft(session.sessionId, sent, keepAttachments, keepImages),
      },
      {
        body,
        intent: how.intent,
        delivery: how.delivery,
        steerTarget,
        references,
        attachments,
        images,
        permissionMode,
        revision,
      },
    );
    if (mounted.current) setLowered(outcome.lowered);
  };

  const backToInput = () => backToInputOf(input);

  const requestStop = () => {
    setConfirmStop(ownActive !== null);
  };
  // A run command the run refused or whose answer was lost: the activity bar's line says so, where
  // it says a refused decision, until the next press. A lost answer goes once the run changes state
  // or ends: whatever it was, the run has moved on. The refusal of a run no longer going is said
  // once, under the input.
  const [commandFailed, setCommandFailed] = useState<{
    runId: string;
    text: string;
    /** A lost answer, and the run's state when it was pressed. */
    lost: boolean;
    status: string | undefined;
  } | null>(null);
  const runDeps = {
    services,
    newId: newCommandId,
    setError,
    onChange,
    onResult: (runId: string, failure: RunCommandFailure | null) => {
      const text = !failure
        ? null
        : failure.kind === 'refused'
          ? tApprovals('refused', { message: failure.message })
          : tActivity('commandUnconfirmed');
      setCommandFailed(
        text && failure
          ? { runId, text, lost: failure.kind === 'unconfirmed', status: going?.status }
          : null,
      );
    },
  };
  // The run moves on, settled as it renders so no frame says what no longer holds: a lost answer
  // goes with the state it was pressed in; the refusal of a run no longer going is said under the
  // input, as another run's is.
  const runGone = commandFailed !== null && going?.runId !== commandFailed.runId;
  if (
    commandFailed &&
    (runGone || (commandFailed.lost && going?.status !== commandFailed.status))
  ) {
    if (runGone && !commandFailed.lost) setError(commandFailed.text);
    setCommandFailed(null);
  }
  // Stop asks first while two or more executions work, or while how many is not known yet: one
  // stop then ends them all.
  const activeExecutions = useActiveExecutionCount(going?.runId ?? null);
  const stopRun = () => {
    if (!ownActive) return;
    if (activeExecutions === null || activeExecutions >= 2) setConfirmStop(true);
    else void runCommand(runDeps, 'cancel', ownActive.runId);
  };
  // A run command on its way: Stop waits for its receipt, as the run record's controls do.
  const commandSending = useCommandSending(going?.runId ?? null);
  // Stop comes to Send's place once a send clears the box and the run goes: the press that sent,
  // or the next one on the same place, does not stop it.
  const stopSettled = useSettledAppearance(Boolean(going) && !text.trim());
  const queue = useQueuedRequests({
    deps: {
      ...startDeps,
      teamKey: team ? `corral:${team.corralId}` : teamMode,
      busy,
      active: Boolean(active),
      autoSaving,
      savedRequestUnavailable,
    },
    runs,
    pending,
    resolvePendingMessage: t('resolvePendingBeforeRetry'),
    onEdit: draft.takeBack,
  });
  const keys = useComposerKeys({ draft, entries: session.entries, write });
  const onText = (value: string) => {
    keys.resetRecall();
    write(value);
  };

  const runNumber = (runId: string) => runs.findIndex((run) => run.runId === runId) + 1;
  const viewingOtherRun = active && selectedRunId && active.runId !== selectedRunId;
  const destination =
    intent === 'steer'
      ? ownActive && !blocked
        ? tc('destination.steer', {
            number: runNumber(ownActive.runId),
            name: targetName(steerTarget),
          })
        : tc('destination.steerUnavailable', { name: targetName(steerTarget) })
      : tc(`destination.${intent}`);
  // What Send does now, said where it is pressed (#89); its name stays Send.
  const sendMeaning = tc(`sendAs.${sendKeys.send}`);
  const attachBusy = busy || draft.attachmentsBusy || draft.imagesBusy;
  // Text attachments ride every send; images only a new request.
  const textAttachable = attachments.length < TEXT_ATTACHMENT_MAX_COUNT;

  useRegisterCommands(
    'composer',
    composerCommands({
      t,
      tc,
      tr,
      tStatus,
      // `/next` while nothing runs is a new request, as every key is then.
      available: { ...menuSends(situation), queue: true },
      ownActive,
      corrals,
      chooseIntent,
      focus: () => input.current?.focus(),
      run: (type) => void runCommand(runDeps, type, ownActive?.runId),
      compact: () => void compactContext({ ...runDeps, ownActive, tStatus }),
      requestStop,
      openTeam: () => setTeamOpen(true),
      openModels: () => setModelsOpen(true),
    }),
  );
  const slashCommands = useRegisteredCommands();
  // The request's settings sit before the key hint on the left; voice stays by Send.
  const requestTools = {
    intent,
    showModel: Boolean(isAuto || team),
    browserMode: services.mode === 'browser',
    autoChoice,
    profiles,
    busy,
    modelOpen: autoModelOpen,
    onModelOpenChange: setAutoModelOpen,
    onAutoChange: (value: AutoModelChoice) => void updateAuto(value),
    permissionMode,
    onPermissionMode: setPermissionMode,
    voice: services.voice ?? null,
    voiceTarget: {
      hostId: window.location.origin,
      sessionId: session.sessionId,
      ...(ownActive ? { runId: ownActive.runId } : {}),
      ...(ownActive && steerTarget ? { executionId: steerTarget } : {}),
    },
    voiceLabel: session.title,
    onTranscript,
  };
  // The send target adapter: the join target, and what each key sends to it.
  const joinTarget: SendTarget = {
    badge: (
      <TargetChip
        situation={situation}
        target={steerTarget || null}
        targets={targets}
        name={targetName(steerTarget)}
        loading={loading}
        disabled={busy}
        onChoose={chooseTarget}
        onClose={backToInput}
      />
    ),
    row: situation,
    keys: sendKeys,
    loading,
    meaning: sendMeaning,
    menu: (
      <SendMenu
        situation={situation}
        sendKey={prefs.sendKey}
        disabled={busy || !text.trim()}
        onSend={(choice) => void send({ choice })}
        onClose={backToInput}
      />
    ),
    sendDisabled: busy || !text.trim() || unavailable,
    send: (role) => void send({ role }),
  };
  const compose = (
    <ComposerCard
      label={t('requestLabel')}
      placeholder={tc('placeholder')}
      describedBy={destinationId}
      inputRef={input}
      text={text}
      onText={onText}
      onKeyDown={keys.onKeyDown}
      sendKey={prefs.sendKey}
      sendLabel={t('send')}
      target={joinTarget}
      menus={{
        commands: slashCommands,
        searchMentions,
        onMention: (item) => {
          const selected = selectMention(item, picked);
          setPicked((list) =>
            list.some((existing) => existing.id === selected.id) ? list : [...list, selected],
          );
          return selected;
        },
      }}
      notices={
        <ComposerNotices
          sessionId={session.sessionId}
          intent={intent}
          viewingOtherRun={
            viewingOtherRun
              ? {
                  viewed: runNumber(selectedRunId),
                  active: runNumber(active.runId),
                  activeRunId: active.runId,
                }
              : null
          }
          onViewRun={onViewRun}
          blocked={blocked}
          onChooseIntent={(value) => {
            chooseIntent(value);
            input.current?.focus();
          }}
          notReady={notReady}
          autoBlockedModel={autoBlocked ? (autoProfile?.label ?? autoChoice.modelProfile) : null}
          missingTeam={missingTeam}
          refusal={refusal}
          onRetry={() => void send(lastPick.current)}
          onAdvisor={openAdvisorControl}
          missingChipCount={missingChips.length}
          chips={chips}
          missing={missing}
          onRemoveChip={(item) => {
            write(removeMention(text, item, chips));
            setPicked((list) => list.filter((x) => x.id !== item.id));
          }}
          draft={draft}
          imageFiles={imageFiles}
          textFiles={textFiles}
          busy={busy}
          destinationId={destinationId}
          destination={destination}
        />
      }
      attach={
        <AttachMenu
          onAddReference={() => insertMentionTrigger(input.current, text, write)}
          serverMode={mode === 'server'}
          imagesDisabled={attachBusy || images.length >= IMAGE_MAX_COUNT}
          textDisabled={attachBusy || !textAttachable}
          onAttachImages={() => imageFiles.current?.click()}
          onAttachText={() => textFiles.current?.click()}
          onAttachMaterials={() => setMaterialsOpen(true)}
        />
      }
      beforeTarget={
        <WorkFolderEntry
          access={folderAccess}
          onAction={onFolderAction}
          onWorkFolder={onWorkFolder}
        />
      }
      afterTarget={
        <>
          {/* While the run's record is read, what a send is is not known: no request settings. */}
          {(intent === 'next' || intent === 'queue') && !blocked && !loading ? (
            <TeamChoice
              projectId={session.projectId}
              team={team}
              teamMode={teamMode}
              corrals={corrals}
              isAuto={isAuto}
              disabled={busy}
              open={teamOpen}
              onOpenChange={setTeamOpen}
              onTeamMode={setTeamMode}
              onTeam={(corralId) => void updateTeam(corralId)}
            />
          ) : null}
          {/* A session setting for the next requests: it stays in view while a run goes. */}
          <AdvisorControl
            value={advisor}
            unknown={advisorUnknown}
            onRecheck={() => void recheckAdvisor()}
            defaultModel={autoChoice.modelProfile}
            profiles={profiles}
            saving={advisorSaving}
            disabled={busy && !advisorSaving}
            problem={advisorProblem}
            onChange={(next) => void updateAdvisor(next)}
          />
        </>
      }
      settings={loading ? null : <RequestTools only="settings" {...requestTools} />}
      end={<RequestTools only="voice" {...requestTools} />}
      // One raised surface the column's width: the activity bar, what waits to start, the
      // notes for the next request, and the input with its tool line.
      activity={
        <ComposerActivity
          sessionId={session.sessionId}
          ownActive={going}
          target={going ? steerTarget || null : null}
          targets={targets}
          onJoin={(id) => {
            chooseTarget(id);
            input.current?.focus();
          }}
          onStop={stopRun}
          onPause={() => void runCommand(runDeps, 'pause', ownActive?.runId)}
          onResume={() => void runCommand(runDeps, 'resume', ownActive?.runId)}
          onViewRun={onViewRun}
          {...(revealRun ? { revealRun } : {})}
          notice={commandFailed?.text ?? null}
          request={
            ownActive
              ? session.entries.find((entry) => entry.runId === ownActive.runId)?.text.slice(0, 80)
              : undefined
          }
          viewingOther={Boolean(viewingOtherRun)}
        />
      }
      above={
        <>
          {/* The next request's own notes, only while there are any: the pre-run auto choice, the
            result a question is about, what this send does not carry. */}
          <div
            data-slot="composer-notes"
            className="flex min-w-0 flex-nowrap items-center gap-1 px-1.5 empty:hidden"
          >
            <ComposerHeader choosingAuto={choosingAuto} onCancelAuto={cancelAuto} />
            {heldForNew.length ? (
              <span role="status" className="min-w-0 truncate px-2 text-caption text-warning">
                {tc('heldForNew', {
                  items: format.list(heldForNew.map((item) => tc(`held.${item}`))),
                })}
              </span>
            ) : null}
          </div>
          <PreRun session={session} team={team} isAuto={isAuto} runMode={runMode} intent={intent} />
          <ComposerQueue
            queued={queued}
            autoStart={autoStart}
            // Auto start is the server's; the browser demo has none, so it has no such setting.
            autoStartShown={services.mode !== 'browser'}
            onAutoStartChange={(value) => void updateAutoStart(value)}
            startDisabled={Boolean(active) || busy || savedRequestUnavailable}
            onStart={(entry) => void queue.start(entry)}
            onEdit={(entry) => void queue.edit(entry)}
            onRemove={(entry) => void queue.remove(entry)}
          />
        </>
      }
      stop={
        going
          ? {
              label: tActivity('stop'),
              disabled: going.status === 'cancelling' || commandSending || !stopSettled,
              onStop: stopRun,
            }
          : null
      }
    />
  );
  return (
    <ComposerSurface.Shell>
      {compose}
      {home && corrals.length > 0 ? (
        <StartSuggestions
          corrals={corrals}
          disabled={busy}
          onTeam={(corralId) => {
            void updateTeam(corralId);
            input.current?.focus();
          }}
        />
      ) : null}
      <ComposerStatus
        runs={runs}
        // The demo's model chip already reads Simulated; a server without live models says it here.
        simulated={runMode === 'mock' && services.mode !== 'browser'}
        liveUnavailable={liveUnavailable}
        reasoningBlocked={reasoningBlocked}
        error={error}
      />
      {lowered ? (
        <p role="status" className="sr-only">
          {tc('lowered')}
        </p>
      ) : null}
      <MaterialsDialog
        open={materialsOpen}
        onOpenChange={setMaterialsOpen}
        epoch={draft.attachmentEpoch}
        projectId={session.projectId}
        value={attachments}
        onChange={setAttachments}
        onBusyChange={draft.setAttachmentsBusy}
        disabled={busy}
      />
      <ModelsDialog
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        runMode={runMode}
        team={team}
        roles={roles}
        profiles={profiles}
        isAuto={isAuto}
        missingTeam={missingTeam}
        autoModel={autoProfile?.label ?? autoChoice.modelProfile}
        sessionId={session.sessionId}
        serverMode={mode === 'server'}
      />
      <StopRunDialog
        open={confirmStop && !runControlsOwnConfirmation}
        onOpenChange={setConfirmStop}
        onConfirm={() => {
          if (ownActive) void runCommand(runDeps, 'cancel', ownActive.runId);
        }}
      />
    </ComposerSurface.Shell>
  );
}
