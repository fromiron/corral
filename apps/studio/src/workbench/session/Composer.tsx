import {
  type AutoModelChoice,
  IMAGE_MAX_COUNT,
  TERMINAL_RUN_STATUSES,
  TEXT_ATTACHMENT_MAX_COUNT,
} from '@corral/contracts';
import type { CorralSummary, RunSummary, SessionEntry, WorkSession } from '@corral/core';
import { useCancelConfirmation } from '@corral/react';
import { InputMessage, Tooltip } from '@corral/react/design-kit';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useRegisterCommands, useRegisteredCommands } from '../../commandRegistry.ts';
import { useRemembered } from '../../pages/Workbench.tsx';
import { projectsChanged } from '../../projects.ts';
import { useServices } from '../../services.tsx';
import { useShortcutBindings } from '../../shortcutBindings.ts';
import { sendKeyLabel } from '../../shortcuts.ts';
import { sessionRunMode } from '../autoChoice.ts';
import { ComposerInput } from '../ComposerInput.tsx';
import { ComposerSurface } from '../ComposerSurface.tsx';
import type { SendChoice, SendKeyRole } from '../composerIntent.ts';

import { removeMention, selectMention } from '../composerMenu.ts';
import type { FileReference } from '../FilePanel.tsx';
import { usePreferences } from '../preferences.ts';
import { clearSentComposerDraft, readComposerDraft } from '../sessionDraft.ts';
import { useMentionSearch } from '../useMentionSearch.ts';
import { useModelProfiles, useTeamRoles } from '../useModels.ts';
import type { FolderAccess } from '../WorkFolderNotice.tsx';
import { ComposerDock, ComposerPlan } from '../widgets/ChatWidgets.tsx';
import { OverviewAccess } from '../widgets/OverviewWidgets.tsx';
import { ComposerQueue } from './ComposerQueue.tsx';
import { ComposerHeader, ComposerStatus, PreRun } from './ComposerStatus.tsx';
import { composerAvailability } from './composer/availability.ts';
import { ComposerNotices } from './composer/ComposerNotices.tsx';
import {
  AttachMenu,
  insertMentionTrigger,
  RequestTools,
  StartSuggestions,
  TeamChoice,
  WorkFolderEntry,
} from './composer/ComposerTools.tsx';
import { compactContext, composerCommands, runCommand } from './composer/commands.ts';
import { MaterialsDialog, ModelsDialog, StopRunDialog } from './composer/dialogs.tsx';
import { useComposerKeys } from './composer/keys.ts';
import { useQueuedRequests } from './composer/queue.ts';
import { KeyHint, menuSends, SendMenu, TargetChip } from './composer/SendControls.tsx';
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
import { useLatestResult, useSteerTargets } from './composer/useRunState.ts';
import { useSessionSettings } from './composer/useSessionSettings.ts';
import { useVoiceTranscript } from './composer/voice.ts';

export function Composer({
  session,
  team,
  corrals,
  runs,
  active,
  selectedRunId,
  onViewRun,
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
  // The Todo the one-line status expands, inside the input surface.
  const planRegion = useId();
  const destinationId = useId();
  const tr = useTranslations('Reins');
  const tStatus = useTranslations('RunStatus');
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
  const { autoChoice, updateAuto, updateTeam, autoStart, updateAutoStart } = useSessionSettings({
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
  // A plan can move between the steering shell and the next-request surface at settlement.
  const [planAllKey, setPlanAllKey] = useState<string | null>(null);
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
  const latest = useLatestResult(runs);
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

  const { targets, lead, ready, targetNames } = useSteerTargets(ownActive, restored);
  const draft = useComposerDraft({
    session,
    team,
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
    sendAs,
    steerTarget,
    targetName,
    write,
    chooseIntent,
    chooseTarget,
  } = useComposerIntent({ draft, targets, lead, ready, targetNames, ownActive, active });
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
      hasLatest: Boolean(latest),
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
    throughRunId: lastEnded?.runId ?? null,
    missingTeam,
    messages: { selectedTeamMissing: t('selectedTeamMissing'), noResult: t('noResult'), failed },
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
    const how = 'role' in pick ? forKey(pick.role) : sendAs(pick.choice);
    const explicitQueue = 'role' in pick ? pick.role === 'queue' : pick.choice === 'queue';
    if (!body || busy || autoSaving.current || availableFor(how.intent, explicitQueue).unavailable)
      return;
    onSent?.();
    lastPick.current = pick;
    setLowered(false);
    const revision = draft.submit();
    const outcome = await sendRequest(
      {
        ...startDeps,
        team,
        ownActive,
        latest,
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

  const requestStop = () => {
    setConfirmStop(ownActive !== null);
  };
  const runDeps = { services, newId: newCommandId, setError, onChange };
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
  const compose = (
    <InputMessage
      toolbar="single"
      data-slot="composer-host"
      role="region"
      aria-label={t('requestLabel')}
      inputRef={input}
      value={text}
      onValueChange={onText}
      onSend={() => void send({ role: 'send' })}
      placeholder={tc('placeholder')}
      textareaProps={{ 'aria-label': t('requestLabel'), 'aria-describedby': destinationId }}
      sendDisabled={busy || !text.trim() || unavailable}
      sendLabel={t('send')}
      sendDescription={sendMeaning}
      renderAction={(action) => (
        <>
          <Tooltip content={sendMeaning} shortcut={sendKeyLabel(prefs.sendKey)}>
            {action}
          </Tooltip>
          <SendMenu
            situation={situation}
            sendKey={prefs.sendKey}
            disabled={busy || !text.trim()}
            onSend={(choice) => void send({ choice })}
          />
        </>
      )}
      contentSlot={
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
          onChooseIntent={chooseIntent}
          notReady={notReady}
          autoBlockedModel={autoBlocked ? (autoProfile?.label ?? autoChoice.modelProfile) : null}
          missingTeam={missingTeam}
          refusal={refusal}
          onRetry={() => void send(lastPick.current)}
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
      renderInput={(inputProps) => (
        <ComposerInput
          inputRef={inputProps.ref}
          textareaProps={inputProps}
          label={t('requestLabel')}
          placeholder={tc('placeholder')}
          value={text}
          onChange={onText}
          onKeyDown={keys.onKeyDown}
          sendKey={prefs.sendKey}
          onSend={(role) => void send({ role })}
          commands={slashCommands}
          searchMentions={searchMentions}
          onMention={(item) => {
            const selected = selectMention(item, picked);
            setPicked((list) =>
              list.some((existing) => existing.id === selected.id) ? list : [...list, selected],
            );
            return selected;
          }}
        />
      )}
      leftSlot={
        <>
          <AttachMenu
            onAddReference={() => insertMentionTrigger(input.current, text, write)}
            serverMode={mode === 'server'}
            imagesDisabled={attachBusy || intent !== 'next' || images.length >= IMAGE_MAX_COUNT}
            textDisabled={attachBusy || !textAttachable}
            onAttachImages={() => imageFiles.current?.click()}
            onAttachText={() => textFiles.current?.click()}
            onAttachMaterials={() => setMaterialsOpen(true)}
          />{' '}
          <WorkFolderEntry
            access={folderAccess}
            onAction={onFolderAction}
            onWorkFolder={onWorkFolder}
          />
          <TargetChip
            situation={situation}
            target={steerTarget || null}
            targets={targets}
            name={targetName(steerTarget)}
            disabled={busy}
            onChoose={chooseTarget}
          />
          {(intent === 'next' || intent === 'queue') && !blocked ? (
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
          {/* The request's settings, then the keys, right before voice and Send. */}
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            <RequestTools only="settings" {...requestTools} />
            <KeyHint keys={sendKeys} situation={situation} sendKey={prefs.sendKey} />
          </span>
        </>
      }
      rightSlot={<RequestTools only="voice" {...requestTools} />}
    />
  );
  return (
    <ComposerSurface.Shell>
      {/* One line above the input: intent, an ended run, plan, changes, activity, held items,
          Overview; the Todo it expands sits directly under it. */}
      <ComposerDock
        planId={planRegion}
        plan={
          <ComposerPlan
            id={planRegion}
            showAllKey={planAllKey}
            onShowAllKeyChange={setPlanAllKey}
          />
        }
        lead={
          <ComposerHeader
            choosingAuto={choosingAuto}
            onCancelAuto={cancelAuto}
            intent={intent}
            about={latest?.label ?? null}
          />
        }
        note={
          heldForNew.length ? (
            <span role="status" className="min-w-0 truncate px-2 text-caption text-warning">
              {tc('heldForNew', {
                items: format.list(heldForNew.map((item) => tc(`held.${item}`))),
              })}
            </span>
          ) : null
        }
        summary={<OverviewAccess />}
      />
      <PreRun session={session} team={team} isAuto={isAuto} runMode={runMode} intent={intent} />
      <ComposerQueue
        queued={queued}
        autoStart={autoStart}
        onAutoStartChange={(value) => void updateAutoStart(value)}
        startDisabled={Boolean(active) || busy || savedRequestUnavailable}
        onStart={(entry) => void queue.start(entry)}
        onEdit={(entry) => void queue.edit(entry)}
        onRemove={(entry) => void queue.remove(entry)}
      />
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
        noResult={intent === 'explain' && !latest}
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
