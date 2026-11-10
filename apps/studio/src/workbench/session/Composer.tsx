import {
  ApiError,
  type AutoCancelResult,
  type VoiceTranscript,
  type VoiceTranscriptReceipt,
} from '@corral/client';
import type { AutoModelChoice, CommandError, TextAttachment } from '@corral/contracts';
import {
  IMAGE_MAX_COUNT,
  type ImageAttachment,
  ImageAttachments,
  PermissionMode,
  type RunReference,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
  TEXT_ATTACHMENT_MAX_COUNT,
} from '@corral/contracts';
import type {
  AutoStartResult,
  CorralSummary,
  RunProjection,
  RunSummary,
  SessionEntry,
  SessionEntryAuto,
  SessionIntent,
  WorkSession,
} from '@corral/core';
import { queuedSessionCommandId, validTextAttachments } from '@corral/core';
import { useCancelConfirmation } from '@corral/react';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  fontWeights,
  InputMessage,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  ModelPicker,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { AtSign, FolderOpen, Plus, X } from '@corral/react/icons';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import {
  type AppCommand,
  useRegisterCommands,
  useRegisteredCommands,
} from '../../commandRegistry.ts';
import { useRemembered } from '../../pages/Workbench.tsx';
import { createPendingSessionCommands } from '../../pendingCommands.ts';
import { projectsChanged } from '../../projects.ts';
import { useServices } from '../../services.tsx';
import { conversationRequest } from '../../sessionActions.ts';
import { useShortcutBindings } from '../../shortcutBindings.ts';
import { sendKeyLabel, shortcutLabel } from '../../shortcuts.ts';
import { AutoModelMenu } from '../AutoModelMenu.tsx';
import {
  autoChoiceFor,
  autoCommandSeed,
  autoNotReady,
  autoReasoningUnsupported,
  sessionRunMode,
} from '../autoChoice.ts';
import { ComposerInput } from '../ComposerInput.tsx';
import { ComposerSurface } from '../ComposerSurface.tsx';
import { type IntentLock, resolveIntent } from '../composerIntent.ts';
import {
  type MentionItem,
  mentionLabel,
  mentionToken,
  pickedReferences,
  removeMention,
  selectMention,
} from '../composerMenu.ts';
import {
  type AttachmentRequest,
  COMPOSER_ATTACH,
  mergeComposerCapture,
} from '../context/bridge.ts';
import { SourceAttachments } from '../context/SourceAttachments.tsx';
import { DevelopmentMode } from '../DevelopmentMode.tsx';
import type { FileReference } from '../FilePanel.tsx';
import { ImageAttachmentPicker } from '../ImageAttachments.tsx';
import { LiveVoice } from '../LiveVoice.tsx';
import { useSettingsNavigation } from '../navigation.ts';
import { PermissionModePicker } from '../PermissionModePicker.tsx';
import { ProjectMaterialPicker } from '../ProjectMaterials.tsx';
import { isSendKey, usePreferences } from '../preferences.ts';
import { EDIT_REQUEST, RESEND_REQUEST, RefusalHelp } from '../RefusalHelp.tsx';
import {
  COMPOSER_DRAFT_SENT,
  clearSentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '../sessionDraft.ts';
import { TerminalWriterNotice } from '../TerminalWriterNotice.tsx';
import { TextAttachmentPicker } from '../TextAttachments.tsx';
import { useMentionSearch } from '../useMentionSearch.ts';
import { type ProfileInfo, type RoleModel, useModelProfiles, useTeamRoles } from '../useModels.ts';
import { ComposerDock, ComposerPlan } from '../widgets/ChatWidgets.tsx';
import { OverviewAccess } from '../widgets/OverviewWidgets.tsx';
import { ComposerQueue } from './ComposerQueue.tsx';
import { ComposerHeader, ComposerStatus, PreRun } from './ComposerStatus.tsx';

const newCommandId = () => `cmd_${globalThis.crypto.randomUUID()}`;

function finalResultId(projection: RunProjection): string | null {
  return projection.output?.artifactVersionIds[0] ?? null;
}

// Keep uncertain requests across SPA navigation, never request controllers.
const pendingSessionCommands = createPendingSessionCommands(
  typeof window !== 'undefined' && window.corralRemote ? window.localStorage : undefined,
  typeof window !== 'undefined' ? window.corralRemote?.hostId : undefined,
);

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
  reference,
  onReferenceUsed,
  runControlsOwnConfirmation = false,
  home = false,
  onWorkFolder,
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
  reference: FileReference | null;
  onReferenceUsed: () => void;
  /** The active session view already has one RunActions confirmation host. */
  runControlsOwnConfirmation?: boolean;
  /** An empty session: the kit home composition offers the saved teams as start suggestions. */
  home?: boolean;
  /** Opens file-work setup; given while the project has no work folder yet. */
  onWorkFolder?: () => void;
}) {
  useShortcutBindings();
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const td = useTranslations('Desktop');
  const format = useFormatter();
  // The Todo the one-line status expands, inside the input surface.
  const planRegion = useId();
  const destinationId = useId();
  const contextMessages = useTranslations('Context');
  const materialMessages = useTranslations('Materials');
  const navigation = useSettingsNavigation();
  const tr = useTranslations('Reins');
  const services = useServices();
  const { repository, transport, mode, live } = services;
  const prefs = usePreferences();
  const router = useRouter();
  const navigate = useNavigate();
  // UX-02: the draft comes back with its intent, target and exact references.
  const [restored] = useState(() => readComposerDraft(session.sessionId));
  const [text, setText] = useState(restored.text);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(
    restored.permissionMode,
  );
  const [attachments, setAttachments] = useState<TextAttachment[]>(restored.attachments ?? []);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>(restored.images ?? []);
  const [imagesBusy, setImagesBusy] = useState(false);
  const textFiles = useRef<HTMLInputElement>(null);
  const imageFiles = useRef<HTMLInputElement>(null);
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const autoSaving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [confirmedAuto, setConfirmedAuto] = useState<{
    revision: number;
    choice: AutoModelChoice;
  } | null>(null);
  const [chosen, setChosen] = useState<SessionIntent | null>(null);
  const [target, setTarget] = useState<string>('');
  // UX-01: what the request is (and for whom) is fixed once typing starts.
  const [lock, setLock] = useState<IntentLock | null>(
    restored.text && restored.intent ? { intent: restored.intent, target: restored.target } : null,
  );
  // sessions are live wherever live is possible; simulation stays in the demo and
  // the team editor.
  const runMode = sessionRunMode(mode, live);
  const [busy, setBusy] = useState(false);
  const voiceSubmitting = useRef(false);
  const voiceSubmissions = useRef(new Map<string, () => Promise<VoiceTranscriptReceipt>>());
  const [choosingAuto, setChoosingAuto] = useState(false);
  const autoRequest = useRef<{
    controller: AbortController;
    commandId: string;
    result: Promise<AutoStartResult>;
    cancellation?: Promise<AutoCancelResult>;
  } | null>(null);
  const cancelAuto = useCallback(() => {
    const request = autoRequest.current;
    if (!request || request.cancellation) return;
    const cancelCommandId = newCommandId();
    request.cancellation = services.cancelAuto
      ? services.cancelAuto({
          commandId: request.commandId,
          sessionId: session.sessionId,
          cancelCommandId,
        })
      : request.result.then(
          async (start) => ({
            start,
            cancellation: start.runId
              ? await transport.sendCommand({
                  schemaVersion: '0.1',
                  commandId: cancelCommandId,
                  runId: start.runId,
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'User cancelled the auto request' },
                })
              : null,
          }),
          () => ({ start: null, cancellation: null }),
        );
    request.controller.abort();
  }, [services, session.sessionId, transport]);
  useEffect(() => () => cancelAuto(), [cancelAuto]);
  const [error, setError] = useState<string | null>(null);
  // UX-04: why the last request did not start; the text stays in the box to send again.
  const [refusal, setRefusal] = useState<{
    message: string;
    code?: string | undefined;
    owner?: CommandError['owner'];
    network?: boolean;
  } | null>(null);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [targetTick, setTargetTick] = useState(0);
  const [picked, setPicked] = useState<MentionItem[]>(restored.references);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Names of executions seen, so an instruction for one that ended still says whom it was for.
  const targetNames = useRef(
    new Map<string, string>(
      restored.target && restored.targetLabel ? [[restored.target, restored.targetLabel]] : [],
    ),
  );
  const [teamOpen, setTeamOpen] = useState(false);
  const [autoModelOpen, setAutoModelOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  // UX-06: which model each role uses, and whether it is connected.
  const profiles = useModelProfiles();
  const autoChoice = autoChoiceFor(
    confirmedAuto && confirmedAuto.revision > session.revision
      ? confirmedAuto.choice
      : session.auto,
    profiles,
  );
  const isAuto = session.corralId === null;
  const missingTeam = !isAuto && !team;
  // without a saved Corral, the lead works alone or leads the auto roster.
  const [teamMode, setTeamMode] = useRemembered<'none' | 'auto'>(
    `corral:team-mode:${session.sessionId}`,
    'none',
  );
  const roles = useTeamRoles(team);
  const [recall, setRecall] = useState(-1);
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
  // One command ID per request: a retry after a lost answer reuses it, so the runtime returns
  // the first receipt instead of starting a second run.
  const pending = useRef(pendingSessionCommands.get(session.sessionId) ?? null);
  const commandFor = (key: string, commandId?: string) => {
    if (pending.current?.key !== key) {
      pending.current = { key, commandId: commandId ?? newCommandId() };
      pendingSessionCommands.set(session.sessionId, pending.current);
    }
    return pending.current.commandId;
  };
  const clearPending = () => {
    if (pendingSessionCommands.get(session.sessionId) === pending.current)
      pendingSessionCommands.delete(session.sessionId);
    pending.current = null;
  };
  const [autoStart, setAutoStart] = useRemembered(`corral:auto-queue:${session.sessionId}`, false);

  // A writer keeps the working copy. Other work queues, or sends an instruction to this
  // session's current execution. An instruction needs an execution that can still take one
  // (none while a decision waits).
  const allowed: SessionIntent[] = active
    ? [...(ownActive && targets.length > 0 ? ['steer' as const] : []), 'queue']
    : // a question about an earlier answer is an ordinary message to the conversation.
      ['next'];

  // Executions that can still take an instruction, named by their node.
  useEffect(() => {
    void targetTick;
    if (!ownActive) return setTargets([]);
    let live = true;
    void Promise.all([
      transport.getSnapshot(ownActive.runId),
      transport.getRunDefinition(ownActive.runId),
    ]).then(([{ projection }, definition]) => {
      if (!live) return;
      const open = projection.executionOrder
        .map((id) => projection.executions[id])
        .filter((e) => e && !TERMINAL_EXECUTION_STATUSES.has(e.status));
      setTargets(
        open.flatMap((e) =>
          e
            ? [
                {
                  id: e.executionId,
                  label: `${definition?.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId} · #${projection.executionOrder.indexOf(e.executionId) + 1}`,
                },
              ]
            : [],
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [transport, ownActive, targetTick]);
  // An execution may end while the person types: the list follows it.
  useEffect(() => {
    if (!ownActive) return;
    const timer = setInterval(() => setTargetTick((n) => n + 1), 1500);
    return () => clearInterval(timer);
  }, [ownActive]);
  for (const x of targets) targetNames.current.set(x.id, x.label);
  const resolved = resolveIntent({
    allowed,
    chosen,
    chosenTarget: target || null,
    lock,
    targets: targets.map((x) => x.id),
    running: Boolean(ownActive),
  });
  const intent = resolved.intent;
  const steerTarget = resolved.target ?? '';
  const targetName = (id: string) => targetNames.current.get(id) ?? id;

  /** Changes the text; the first character fixes what the request is and for whom. */
  const write = (value: string | ((current: string) => string)) => {
    setText(value);
    if (value === '') setLock(null);
    else if (!lock) setLock({ intent, target: intent === 'steer' ? steerTarget || null : null });
  };
  /** An explicit choice by the person; it becomes the new fixed intent while text is typed. */
  const chooseIntent = (value: SessionIntent) => {
    setChosen(value);
    if (text)
      setLock({
        intent: value,
        target: value === 'steer' ? (lock?.target ?? steerTarget) || targets[0]?.id || null : null,
      });
  };
  const chooseTarget = (value: string) => {
    setTarget(value);
    if (text) setLock({ intent: 'steer', target: value });
  };
  const composerDraft = useMemo(
    () => ({
      text,
      intent: lock?.intent ?? null,
      target: lock?.target ?? null,
      targetLabel: lock?.target ? (targetNames.current.get(lock.target) ?? null) : null,
      references: picked.filter((item) => pickedReferences(text, [item]).length > 0),
      ...(attachments.length ? { attachments } : {}),
      ...(images.length ? { images } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    }),
    [text, lock, picked, attachments, images, permissionMode],
  );
  const draftRevision = useRef(0);
  const currentDraft = useRef({ draft: composerDraft, busy: false });
  currentDraft.current = {
    draft: composerDraft,
    busy: busy || attachmentsBusy || imagesBusy,
  };
  useEffect(() => {
    const attach = (event: Event) => {
      const request = (event as CustomEvent<AttachmentRequest>).detail;
      const destination = request.capture.target;
      if (
        destination.hostId !== services.workspaceId ||
        destination.projectId !== session.projectId ||
        destination.sessionId !== session.sessionId
      )
        return;
      if (currentDraft.current.busy) {
        request.result = { ok: false, reason: 'busy' };
        return;
      }
      const draft = mergeComposerCapture(currentDraft.current.draft, request);
      if ('ok' in draft) {
        request.result = draft;
        return;
      }
      currentDraft.current.draft = draft;
      draftRevision.current = writeComposerDraft(session.sessionId, draft);
      setAttachments(draft.attachments ?? []);
      if (request.image !== undefined) setImages(draft.images ?? []);
      request.result = { ok: true };
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(COMPOSER_ATTACH, attach);
    return () => window.removeEventListener(COMPOSER_ATTACH, attach);
  }, [services.workspaceId, session.projectId, session.sessionId]);
  useEffect(() => {
    draftRevision.current = writeComposerDraft(session.sessionId, composerDraft);
  }, [session.sessionId, composerDraft]);
  useEffect(() => {
    const sent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId: string;
          revision: number;
          preserveAttachments?: boolean;
          preserveImages?: boolean;
        }>
      ).detail;
      if (detail.sessionId !== session.sessionId || detail.revision !== draftRevision.current)
        return;
      setPicked([]);
      if (!detail.preserveAttachments) setAttachments([]);
      if (!detail.preserveImages) setImages([]);
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      setPermissionMode(undefined);
      setChosen(null);
      setLock(null);
      setText('');
    };
    window.addEventListener(COMPOSER_DRAFT_SENT, sent);
    return () => window.removeEventListener(COMPOSER_DRAFT_SENT, sent);
  }, [session.sessionId]);

  // References restored from a draft are checked once: a result version, run or role that is
  // gone is marked, never swapped for another with the same name.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the restored references
  useEffect(() => {
    if (!restored.references.length) return;
    let live = true;
    void (async () => {
      const gone = new Set<string>();
      const roles = team
        ? ((await repository.get(team.corralId))?.definition.roles.map((r) => r.id) ?? [])
        : [];
      for (const item of restored.references) {
        const ref = item.reference;
        try {
          if (ref.kind === 'result') {
            const { projection } = await transport.getSnapshot(ref.runId);
            if (!projection.artifacts[ref.artifactVersionId]) gone.add(item.id);
          } else if (ref.kind === 'run') await transport.getSnapshot(ref.runId);
          else if (ref.kind === 'role' && !roles.includes(ref.roleId)) gone.add(item.id);
        } catch {
          gone.add(item.id);
        }
      }
      if (live) setMissing(gone);
    })();
    return () => {
      live = false;
    };
  }, []);

  // A line range chosen in the file panel arrives as a reference at the caret.
  const used = useRef<FileReference | null>(null);
  useEffect(() => {
    if (!reference || used.current === reference) return;
    used.current = reference;
    const item: MentionItem = {
      id: `file:${reference.path}:${reference.start}-${reference.end}`,
      kind: 'file',
      label: reference.path,
      lines: { start: reference.start, end: reference.end },
      reference: {
        kind: 'file',
        path: reference.path,
        lines: { start: reference.start, end: reference.end },
      },
    };
    setPicked((list) => [...list, item]);
    const box = input.current;
    const at = box?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const token = mentionToken(item);
    const next = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${token} ${text.slice(at)}`;
    write(next);
    onReferenceUsed();
    requestAnimationFrame(() => box?.focus());
  });

  const references = pickedReferences(text, picked);
  const chips = picked.filter(
    (item, index) =>
      picked.findIndex((x) => x.id === item.id) === index &&
      pickedReferences(text, [item]).length > 0,
  );
  const missingChips = chips.filter((item) => missing.has(item.id));

  const record = async (entry: Parameters<typeof repository.addSessionEntry>[1]) => {
    const saved = await repository.addSessionEntry(session.sessionId, entry);
    if (!saved.ok) throw new Error(t('failed', { message: saved.message }));
    if (saved.session.title !== session.title) projectsChanged();
  };

  /** Starts a follow-up with the team; returns the run or why not. */
  const startNext = async (
    brief: string,
    commandId: string = newCommandId(),
    refs: RunReference[] = [],
    requestPermissionMode?: PermissionMode,
  ): Promise<{
    runId: string | null;
    detail: string | null;
    code?: string | undefined;
    error?: CommandError | undefined;
    auto?: SessionEntryAuto | null;
    cancelled?: boolean;
    cancelError?: string;
  }> => {
    // every chat turn is the conversation lead; a saved Corral lends it its roles.
    // A deleted Corral is never replaced by another way of working.
    if (missingTeam) return { runId: null, detail: t('selectedTeamMissing') };
    return startAuto(brief, commandId, refs, requestPermissionMode);
  };

  /** with no team chosen, the runtime picks a template for this request. */
  const startAuto = async (
    brief: string,
    commandId: string,
    refs: RunReference[],
    requestPermissionMode?: PermissionMode,
  ) => {
    const controller = new AbortController();
    const proposed = conversationRequest(services, session, {
      ...(requestPermissionMode ? { permissionMode: requestPermissionMode } : {}),
      commandId,
      brief,
      choice: autoChoice,
      team: teamMode,
      ...(lastEnded ? { throughRunId: lastEnded.runId } : {}),
      ...(refs.length ? { references: refs } : {}),
    });
    const command = pending.current;
    // A completed run may change `lastEnded` before its lost start receipt is recovered.
    let body = proposed;
    if (command?.commandId === commandId) {
      command.autoRequest ??= structuredClone(proposed);
      pendingSessionCommands.set(session.sessionId, command);
      body = command.autoRequest;
    }
    const request: NonNullable<typeof autoRequest.current> = {
      controller,
      commandId,
      result: services.startAuto(body, controller.signal),
    };
    autoRequest.current = request;
    setChoosingAuto(true);
    try {
      let result: AutoStartResult;
      try {
        result = await request.result;
      } catch (failure) {
        if (!request.cancellation) throw failure;
        const cancelled = await request.cancellation;
        if (!cancelled.start) throw new DOMException('Cancelled', 'AbortError');
        result = cancelled.start;
      }
      const cancellation = request.cancellation ? await request.cancellation : null;
      // A dropped HTTP response can hide a committed run; keep its original receipt.
      if (cancellation?.start) result = cancellation.start;
      return {
        runId: result.runId,
        detail: result.receipt.error?.message ?? null,
        code: result.receipt.error?.code,
        error: result.receipt.error ?? undefined,
        cancelled: cancellation !== null,
        ...(cancellation?.cancellation?.error
          ? { cancelError: cancellation.cancellation.error.message }
          : {}),
        auto: result.autoRoute
          ? {
              template: result.autoRoute.template,
              ...(result.autoRoute.harness ? { harness: result.autoRoute.harness } : {}),
              source: result.autoRoute.source,
              reason: result.autoRoute.reason,
              modelProfile: result.autoRoute.modelProfile,
              ...(result.autoRoute.fallback ? { fallback: result.autoRoute.fallback } : {}),
              ...(result.autoRoute.reasoning
                ? { requestedReasoning: result.autoRoute.reasoning }
                : {}),
              ...(result.autoRoute.reasoningChoice
                ? {
                    reasoning: result.autoRoute.reasoningChoice.level,
                    reasoningSource: result.autoRoute.reasoningChoice.source,
                  }
                : {}),
            }
          : null,
      };
    } finally {
      if (autoRequest.current === request) {
        autoRequest.current = null;
        setChoosingAuto(false);
      }
    }
  };

  /** Saves the auto model and reasoning with the session. */
  const updateAuto = async (auto: AutoModelChoice) => {
    if (autoSaving.current || busy) return;
    autoSaving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await repository.updateSession(session.sessionId, {
        auto,
        expectedRevision: Math.max(session.revision, confirmedAuto?.revision ?? 0),
      });
      if (!mounted.current) return;
      if (!result.ok) throw new Error(result.message);
      setConfirmedAuto({ revision: result.session.revision, choice: auto });
      await router.invalidate();
    } catch (failure) {
      if (mounted.current)
        setError(
          t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
        );
    } finally {
      autoSaving.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /** A refused request keeps its text, intent and references so it can be fixed and resent. */
  const refused = async (message: string, code?: string, owner?: CommandError['owner']) => {
    // A refusal is final for that command; the next attempt is a new command.
    clearPending();
    setRefusal({ message, code, owner });
    await router.invalidate();
    onChange();
  };

  const performVoice = async (utterance: VoiceTranscript): Promise<VoiceTranscriptReceipt> => {
    if (
      utterance.target.hostId !== window.location.origin ||
      utterance.target.sessionId !== session.sessionId
    )
      return {
        status: 'rejected',
        message: 'The voice destination changed. Reconnect explicitly.',
      };
    if (voiceSubmitting.current || autoSaving.current)
      return {
        status: 'rejected',
        message: 'Another request is being submitted. Retry this same utterance.',
      };
    if (
      !utterance.delivery &&
      utterance.target.runId &&
      (ownActive?.runId !== utterance.target.runId ||
        !utterance.target.executionId ||
        !targets.some((item) => item.id === utterance.target.executionId))
    )
      return {
        status: 'rejected',
        message:
          'The pinned execution cannot receive an instruction (it ended or is waiting for a decision). Choose queue or next request explicitly.',
        alternatives: ['queue', 'next'],
      };
    if (!utterance.delivery && !utterance.target.runId && ownActive)
      return {
        status: 'rejected',
        message:
          'A run started after this call was connected. Queue this utterance or reconnect to select its execution.',
        alternatives: ['queue'],
      };
    voiceSubmitting.current = true;
    setBusy(true);
    try {
      if (utterance.delivery === 'queue') {
        await record({
          intent: 'queue',
          text: utterance.text,
          state: 'queued',
          commandId: utterance.commandId,
          ...(permissionMode ? { permissionMode } : {}),
        });
        onChange();
        return { status: 'queued' };
      }
      if (!utterance.delivery && utterance.target.runId && utterance.target.executionId) {
        const receipt = await transport.sendCommand({
          schemaVersion: '0.1',
          commandId: utterance.commandId,
          runId: utterance.target.runId,
          type: 'steer',
          payload: {
            targetExecutionId: utterance.target.executionId,
            text: utterance.text,
            delivery: 'next_request',
          },
        });
        await record({
          intent: 'steer',
          text: utterance.text,
          state: receipt.error ? 'refused' : 'sent',
          runId: utterance.target.runId,
          executionId: utterance.target.executionId,
          detail: receipt.error?.message ?? null,
          refusal: receipt.error ?? null,
          commandId: utterance.commandId,
        });
        onChange();
        return receipt.error
          ? { status: 'rejected', message: receipt.error.message }
          : {
              status: 'accepted',
              message: 'Accepted for the next request boundary; not yet delivered.',
            };
      }
      const result = await startNext(utterance.text, utterance.commandId, [], permissionMode);
      await record({
        ...(permissionMode ? { permissionMode } : {}),
        intent: 'next',
        text: utterance.text,
        state: result.runId ? 'started' : 'refused',
        runId: result.runId,
        detail: result.detail,
        refusal: result.error ?? null,
        commandId: utterance.commandId,
        ...(result.auto ? { auto: result.auto } : {}),
      });
      await router.invalidate();
      onChange();
      return result.runId
        ? { status: 'accepted' }
        : { status: 'rejected', message: result.detail ?? 'The request was not accepted.' };
    } finally {
      voiceSubmitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const submitVoice = (utterance: VoiceTranscript): Promise<VoiceTranscriptReceipt> => {
    if (
      utterance.target.hostId !== window.location.origin ||
      utterance.target.sessionId !== session.sessionId
    )
      return Promise.resolve({
        status: 'rejected',
        message: 'The voice destination changed. Reconnect explicitly.',
      });
    if (busy || autoSaving.current)
      return Promise.resolve({
        status: 'rejected',
        message: 'Another request is being submitted. Retry this same utterance.',
      });
    // Keep the original request closure (model, policy, execution and startFrom) across a
    // lost receipt. New renders may already show the run started by this very command.
    let submit = voiceSubmissions.current.get(utterance.commandId);
    if (!submit) {
      submit = () => performVoice(utterance);
      voiceSubmissions.current.set(utterance.commandId, submit);
    }
    return submit();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy || autoSaving.current || unavailable) return;
    const submittedRevision = writeComposerDraft(session.sessionId, composerDraft);
    draftRevision.current = submittedRevision;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      if (intent === 'next') {
        const refs: RunReference[] = [...references, ...attachments, ...images];
        // The team is part of the request: changing it after a lost answer is a new request.
        const commandId = commandFor(
          autoCommandSeed(body, refs, autoChoice, team ? `corral:${team.corralId}` : teamMode) +
            (permissionMode ? `\u0000permission:${permissionMode}` : ''),
        );
        const {
          runId,
          detail,
          code,
          error: commandError,
          auto,
          cancelled,
          cancelError,
        } = await startNext(body, commandId, refs, permissionMode);
        await record({
          ...(permissionMode ? { permissionMode } : {}),
          intent,
          text: body,
          state: runId ? 'started' : 'refused',
          runId,
          detail,
          refusal: commandError ?? null,
          commandId,
          ...(auto ? { auto } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(images.length ? { images } : {}),
        });
        if (cancelled) {
          clearPending();
          if (cancelError) setError(cancelError);
          await router.invalidate();
          onChange();
          return;
        }
        if (!runId)
          return await refused(detail ?? t('failed', { message: '' }), code, commandError?.owner);
      } else if (intent === 'queue') {
        await record({
          intent,
          text: body,
          state: 'queued',
          ...(attachments.length ? { attachments } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        });
      } else if (intent === 'steer' && ownActive && steerTarget) {
        const commandId = commandFor(`steer\u0000${steerTarget}\u0000${body}`);
        const receipt = await transport.sendCommand({
          schemaVersion: '0.1',
          commandId,
          runId: ownActive.runId,
          type: 'steer',
          payload: { targetExecutionId: steerTarget, text: body, delivery: 'next_request' },
        });
        await record({
          intent,
          text: body,
          state: receipt.error ? 'refused' : 'sent',
          runId: ownActive.runId,
          executionId: steerTarget,
          detail: receipt.error?.message ?? null,
          refusal: receipt.error ?? null,
          commandId,
        });
        if (receipt.error)
          return await refused(receipt.error.message, receipt.error.code, receipt.error.owner);
      } else if (intent === 'explain') {
        const corral = team ? await repository.get(team.corralId) : null;
        // An auto session asks with its own model.
        const profile = team
          ? (corral?.definition.roles[0]?.modelProfile ?? 'model-a')
          : autoChoice.modelProfile;
        if (!latest) {
          setError(t('noResult'));
          return;
        }
        const result = await services.startExplain({
          commandId: commandFor(`explain\u0000${body}`),
          sessionId: session.sessionId,
          question: body,
          modelProfile: profile,
          mode: runMode,
          startFrom: { runId: latest.runId, artifactVersionId: latest.id },
        });
        await record({
          intent,
          text: body,
          state: result.runId ? 'started' : 'refused',
          runId: result.runId,
          detail: result.receipt.error?.message ?? null,
          refusal: result.receipt.error ?? null,
        });
        if (!result.runId)
          return await refused(
            result.receipt.error?.message ?? t('noResult'),
            result.receipt.error?.code,
            result.receipt.error?.owner,
          );
      } else {
        return;
      }
      clearPending();
      clearSentComposerDraft(
        session.sessionId,
        submittedRevision,
        intent !== 'next' && intent !== 'queue',
        intent !== 'next',
      );
      await router.invalidate();
      onChange();
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') {
        clearPending();
        return;
      }
      if (
        failure instanceof ApiError &&
        failure.owner &&
        ['RUN_ALREADY_ACTIVE', 'RESOURCE_CAPACITY'].includes(failure.code)
      )
        return await refused(failure.message, failure.code, failure.owner);
      // The answer was lost: the request may or may not have arrived. The text stays, and a
      // retry reuses the same command ID, so the runtime returns the first receipt.
      setRefusal({
        message: failure instanceof Error ? failure.message : String(failure),
        network: true,
      });
    } finally {
      setBusy(false);
    }
  };

  // "Edit the request again" on a refused turn brings its text back here.
  useEffect(() => {
    const take = (event: Event) => {
      const value = (
        event as CustomEvent<
          | string
          | {
              text: string;
              permissionMode?: PermissionMode;
              attachments?: TextAttachment[];
              images?: ImageAttachment[];
            }
        >
      ).detail;
      if (
        typeof value !== 'string' &&
        (typeof value !== 'object' ||
          !value ||
          typeof value.text !== 'string' ||
          (value.permissionMode !== undefined &&
            !PermissionMode.safeParse(value.permissionMode).success) ||
          (value.attachments !== undefined && !validTextAttachments(value.attachments)) ||
          (value.images !== undefined && !ImageAttachments.safeParse(value.images).success))
      )
        return;
      setText(typeof value === 'string' ? value : value.text);
      setPermissionMode(typeof value === 'string' ? undefined : value.permissionMode);
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      setAttachments(typeof value === 'string' ? [] : (value.attachments ?? []));
      setImages(typeof value === 'string' ? [] : (value.images ?? []));
      setLock(null);
      setRefusal(null);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(EDIT_REQUEST, take);
    return () => window.removeEventListener(EDIT_REQUEST, take);
  }, []);

  const requestStop = () => {
    setConfirmStop(ownActive !== null);
  };
  const runCommand = async (type: 'pause' | 'resume' | 'cancel', runId = ownActive?.runId) => {
    if (!runId) return;
    const receipt = await transport
      .sendCommand(
        type === 'cancel'
          ? {
              schemaVersion: '0.1',
              commandId: newCommandId(),
              runId,
              type,
              payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
            }
          : {
              schemaVersion: '0.1',
              commandId: newCommandId(),
              runId,
              type,
              payload: { scope: 'run' },
            },
      )
      .catch((failure: unknown) => ({
        error: { message: failure instanceof Error ? failure.message : String(failure) },
      }));
    if (receipt.error) setError(receipt.error.message);
    onChange();
  };

  const entryCommandKey = (entry: SessionEntry, resend: boolean) =>
    `${resend ? 'resend' : 'queue'}\u0000${entry.entryId}\u0000${autoCommandSeed(entry.text, [...(entry.attachments ?? []), ...(resend ? (entry.images ?? []) : [])], autoChoice, team ? `corral:${team.corralId}` : teamMode)}\u0000${entry.permissionMode ?? ''}`;
  const startQueued = async (entry: SessionEntry, resend = false) => {
    if (busy || autoRequest.current || autoSaving.current || active || savedRequestUnavailable)
      return;
    setBusy(true);
    const queuedReferences: RunReference[] = [
      ...(entry.attachments ?? []),
      ...(resend ? (entry.images ?? []) : []),
    ];
    try {
      if (!resend) {
        const current = await repository.getSession(session.sessionId);
        const persisted = current?.entries.find((item) => item.entryId === entry.entryId);
        if (
          persisted?.state !== 'queued' ||
          queuedSessionCommandId(session.sessionId, persisted) !==
            queuedSessionCommandId(session.sessionId, entry)
        ) {
          await router.invalidate();
          onChange();
          return;
        }
      }
      const commandId = commandFor(
        entryCommandKey(entry, resend),
        resend ? undefined : queuedSessionCommandId(session.sessionId, entry),
      );
      const {
        runId,
        detail,
        error: commandError,
        auto,
        cancelError,
      } = await startNext(entry.text, commandId, queuedReferences, entry.permissionMode);
      if (!resend && commandError?.code === 'IDEMPOTENCY_CONFLICT') {
        // Another tab can have a different model/history snapshot of the same queue item.
        // Its original receipt owns the outcome, including while that start is pending.
        setError(detail ?? commandError.message);
        await router.invalidate();
        onChange();
        return;
      }
      const outcome = {
        state: runId ? ('started' as const) : ('refused' as const),
        runId,
        detail,
        refusal: commandError ?? null,
        ...(auto ? { auto } : {}),
      };
      const saved = resend
        ? await repository.addSessionEntry(session.sessionId, {
            intent: 'next',
            text: entry.text,
            commandId,
            ...outcome,
            ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
            ...(entry.attachments ? { attachments: entry.attachments } : {}),
            ...(entry.images ? { images: entry.images } : {}),
          })
        : await repository.updateSessionEntry(session.sessionId, entry.entryId, outcome);
      if (!saved.ok) throw new Error(t('failed', { message: saved.message }));
      clearPending();
      if (cancelError) setError(cancelError);
      await router.invalidate();
      onChange();
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') clearPending();
      else
        setError(
          t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
        );
    } finally {
      setBusy(false);
    }
  };
  const resendState = useRef({
    sessionId: session.sessionId,
    active: Boolean(active),
    pending: false,
  });
  resendState.current = {
    ...resendState.current,
    sessionId: session.sessionId,
    active: Boolean(active),
  };
  const resendEntry = useRef<(entryId: string) => Promise<void>>(async () => {});
  resendEntry.current = async (entryId) => {
    const entry = session.entries.find((item) => item.entryId === entryId);
    if (!entry?.runId || active || busy || autoRequest.current || resendState.current.pending)
      return;
    resendState.current.pending = true;
    try {
      if (entry.intent === 'steer') {
        const { projection } = await transport.getSnapshot(entry.runId);
        const directive = Object.values(projection.directives).find(
          (item) => item.commandId === entry.commandId,
        );
        if (!directive || !['not_delivered', 'expired', 'cancelled'].includes(directive.status))
          return;
      } else if (
        !runs.some(
          (run) =>
            run.runId === entry.runId &&
            ['cancelled', 'interrupted', 'failed'].includes(run.status),
        )
      )
        return;
      if (
        resendState.current.sessionId !== session.sessionId ||
        resendState.current.active ||
        autoRequest.current
      )
        return;
      if (pending.current && pending.current.key !== entryCommandKey(entry, true)) {
        setError(t('resolvePendingBeforeRetry'));
        return;
      }
      await startQueued(entry, true);
    } finally {
      resendState.current.pending = false;
    }
  };
  useEffect(() => {
    const resend = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; entryId: string }>).detail;
      if (detail?.sessionId === session.sessionId && typeof detail.entryId === 'string')
        void resendEntry
          .current(detail.entryId)
          .catch((failure: unknown) =>
            setError(failure instanceof Error ? failure.message : String(failure)),
          );
    };
    window.addEventListener(RESEND_REQUEST, resend);
    return () => window.removeEventListener(RESEND_REQUEST, resend);
  }, [session.sessionId]);
  const removeQueued = async (entry: SessionEntry) => {
    await repository.updateSessionEntry(session.sessionId, entry.entryId, { state: 'dismissed' });
    await router.invalidate();
  };
  /** Editing a queued task takes it back into the box; sending again records a new version. */
  const editQueued = async (entry: SessionEntry) => {
    setAttachmentEpoch((epoch) => epoch + 1);
    setAttachmentsBusy(false);
    setImagesBusy(false);
    setText(entry.text);
    setPermissionMode(entry.permissionMode);
    setAttachments(entry.attachments ?? []);
    setImages(entry.images ?? []);
    setChosen('queue');
    setLock({ intent: 'queue', target: null });
    await repository.updateSessionEntry(session.sessionId, entry.entryId, {
      state: 'dismissed',
      detail: 'edited',
    });
    await router.invalidate();
  };

  // Auto-start, when switched on: only on a run's end seen by this page, never on load.
  const wasActive = useRef(Boolean(active));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the run ending only
  useEffect(() => {
    const ended = wasActive.current && !active;
    wasActive.current = Boolean(active);
    const next = queued[0];
    if (ended && autoStart && next) void startQueued(next);
  }, [active, ownActive]);

  const updateTeam = async (corralId: string) => {
    const result = await repository.updateSession(session.sessionId, {
      corralId: corralId || null,
      expectedRevision: session.revision,
    });
    if (!result.ok) setError(t('failed', { message: result.message }));
    else await router.invalidate();
  };

  // Earlier requests, newest first, for ↑ in an empty box.
  const history = session.entries
    .map((e) => e.text)
    .filter((value, index, all) => value.trim() && all.lastIndexOf(value) === index)
    .reverse();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME composition's Enter confirms the text; it never sends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (isSendKey(event, prefs.sendKey)) {
      event.preventDefault();
      void send();
      return;
    }
    const box = event.currentTarget;
    const recalled = recall >= 0 && text === history[recall];
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      (text === '' || recalled) &&
      box.selectionStart === box.selectionEnd
    ) {
      const next = event.key === 'ArrowUp' ? recall + 1 : recall - 1;
      if (next < -1 || next >= history.length) return;
      event.preventDefault();
      setRecall(next);
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      write(next === -1 ? '' : (history[next] ?? ''));
      const recalledEntry =
        next === -1 ? undefined : session.entries.findLast((entry) => entry.text === history[next]);
      setAttachments(recalledEntry?.attachments ?? []);
      setPermissionMode(recalledEntry?.permissionMode);
      setImages(recalledEntry?.images ?? []);
    }
  };

  // UX-04: with live models chosen, a role whose model is not connected stops the request
  // before it is sent, with the way to connect it.
  const notReady =
    runMode === 'live' && (intent === 'next' || intent === 'explain') && profiles
      ? roles.filter((r) => !profiles.some((p) => p.profileId === r.profileId && p.available))
      : [];
  // an auto request on a disconnected model is stopped, never simulated instead.
  const autoBlocked =
    isAuto &&
    (intent === 'next' || intent === 'explain') &&
    profiles !== null &&
    autoNotReady(autoChoice, profiles, runMode);
  const autoProfile = profiles?.find((p) => p.profileId === autoChoice.modelProfile);
  const reasoningBlocked =
    isAuto && intent === 'next' && autoReasoningUnsupported(autoChoice, profiles, runMode);
  const liveUnavailable =
    runMode === 'live' && !live && (intent === 'next' || intent === 'explain');
  const savedRequestUnavailable =
    missingTeam ||
    (runMode === 'live' && !live) ||
    (isAuto && profiles !== null && autoNotReady(autoChoice, profiles, runMode)) ||
    (isAuto && autoReasoningUnsupported(autoChoice, profiles, runMode)) ||
    (runMode === 'live' &&
      profiles !== null &&
      roles.some(
        (role) =>
          !profiles.some((profile) => profile.profileId === role.profileId && profile.available),
      ));
  const unavailable =
    liveUnavailable ||
    attachmentsBusy ||
    imagesBusy ||
    (attachments.length > 0 && intent !== 'next' && intent !== 'queue') ||
    autoBlocked ||
    reasoningBlocked ||
    notReady.length > 0 ||
    resolved.blocked !== null ||
    missingChips.length > 0 ||
    (missingTeam && (intent === 'next' || intent === 'explain')) ||
    (intent === 'explain' && !latest) ||
    (intent === 'steer' && !steerTarget);
  const runNumber = (runId: string) => runs.findIndex((run) => run.runId === runId) + 1;
  const viewingOtherRun = active && selectedRunId && active.runId !== selectedRunId;
  const destination =
    intent === 'steer'
      ? ownActive
        ? tc('destination.steer', {
            number: runNumber(ownActive.runId),
            name: targetName(steerTarget),
          })
        : tc('destination.steerUnavailable', { name: targetName(steerTarget) })
      : tc(`destination.${intent}`);
  // A new run in this session is the default: the input's description says it, with no line.
  const quietDestination = intent === 'next' && !resolved.blocked;
  // What Send does now, said where it is pressed (#89).
  const sendMeaning = intent === 'next' ? t('send') : `${t('send')} · ${t(`intent.${intent}`)}`;
  // Items this intent does not carry share one notice and one wording (#89).
  const heldForNew = [
    ...(chips.length && intent !== 'next' ? (['references'] as const) : []),
    ...(images.length > 0 && intent !== 'next' ? (['images'] as const) : []),
    ...(attachments.length > 0 && intent !== 'next' && intent !== 'queue'
      ? (['attachments'] as const)
      : []),
  ];
  const why = (allowedHere: boolean) => (allowedHere ? undefined : tc('notNow'));

  useRegisterCommands('composer', [
    ...(['next', 'queue', 'steer'] as SessionIntent[]).map(
      (value): AppCommand => ({
        id: `intent:${value}`,
        title: t(`intent.${value}`),
        group: tc('groupRequest'),
        slash: value,
        keywords: [t(`intentShort.${value}`)],
        disabled: !allowed.includes(value),
        ...(allowed.includes(value) ? {} : { hint: tc('notNow') }),
        run: () => {
          chooseIntent(value);
          input.current?.focus();
        },
      }),
    ),
    {
      id: 'run:pause',
      title: tr('pause'),
      group: tc('groupRun'),
      slash: 'pause',
      disabled: ownActive?.status !== 'running',
      hint: why(ownActive?.status === 'running'),
      run: () => void runCommand('pause'),
    },
    {
      id: 'run:resume',
      title: tr('resume'),
      group: tc('groupRun'),
      slash: 'resume',
      disabled: ownActive?.status !== 'paused',
      hint: why(ownActive?.status === 'paused'),
      run: () => void runCommand('resume'),
    },
    {
      id: 'run:stop',
      title: tr('cancelRun'),
      group: tc('groupRun'),
      slash: 'stop',
      shortcutId: 'run.stop',
      shortcut: shortcutLabel('run.stop'),
      disabled: !ownActive,
      hint: why(Boolean(ownActive)),
      run: requestStop,
    },
    {
      id: 'composer:team',
      title: t('chooseTeam'),
      group: tc('groupRequest'),
      slash: 'team',
      keywords: [t('autoTeam'), ...corrals.map((c) => c.name)],
      run: () => setTeamOpen(true),
    },
    {
      id: 'composer:models',
      title: tc('models.title'),
      group: tc('groupRequest'),
      slash: 'model',
      run: () => setModelsOpen(true),
    },
    {
      id: 'composer:focus',
      title: tc('focus'),
      group: tc('groupRequest'),
      shortcutId: 'composer.focus',
      shortcut: shortcutLabel('composer.focus'),
      run: () => input.current?.focus(),
    },
  ]);
  const commands = useRegisteredCommands();
  const compose = (
    <InputMessage
      data-slot="composer-host"
      role="region"
      aria-label={t('requestLabel')}
      inputRef={input}
      value={text}
      onValueChange={(value) => {
        setRecall(-1);
        write(value);
      }}
      onSend={() => void send()}
      placeholder={tc('placeholder')}
      textareaProps={{ 'aria-label': t('requestLabel'), 'aria-describedby': destinationId }}
      sendDisabled={busy || !text.trim() || unavailable}
      sendLabel={t('send')}
      sendDescription={sendMeaning}
      renderAction={(action) => (
        <Tooltip content={sendMeaning} shortcut={sendKeyLabel(prefs.sendKey)}>
          {action}
        </Tooltip>
      )}
      contentSlot={
        <>
          <ComposerPlan
            id={planRegion}
            showAllKey={planAllKey}
            onShowAllKeyChange={setPlanAllKey}
          />
          {intent !== 'steer' ? <TerminalWriterNotice sessionId={session.sessionId} /> : null}
          {viewingOtherRun ? (
            <Banner data-testid="viewed-run-warning" status="warning" size="compact">
              <BannerTitle>
                {tc('viewingOtherRun', {
                  viewed: runNumber(selectedRunId),
                  active: runNumber(active.runId),
                })}
              </BannerTitle>
              {onViewRun ? (
                <BannerActions>
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={() => onViewRun(active.runId)}
                  >
                    {tc('viewActiveRun')}
                  </Button>
                </BannerActions>
              ) : null}
            </Banner>
          ) : null}
          {resolved.blocked ? (
            <Banner data-testid="intent-blocked" status="warning" contrast="high" size="compact">
              <BannerTitle>
                {resolved.blocked === 'target'
                  ? tc('blocked.target', { name: targetName(steerTarget) })
                  : resolved.blocked === 'run'
                    ? tc('blocked.run')
                    : tc('blocked.intent', { intent: t(`intentShort.${intent}`) })}
              </BannerTitle>
              <BannerActions>
                {allowed
                  .filter((value) => value !== intent)
                  .map((value) => (
                    <Button
                      key={value}
                      variant="secondary"
                      size="compact"
                      onClick={() => chooseIntent(value)}
                    >
                      {tc(`switchTo.${value}`)}
                    </Button>
                  ))}
              </BannerActions>
            </Banner>
          ) : null}
          {notReady.length ? (
            <Banner data-testid="models-not-ready" status="warning" contrast="high" size="compact">
              <BannerTitle>
                {tc('models.notReady', {
                  roles: notReady.map((r) => `${r.name} (${r.profileId})`).join(', '),
                })}
              </BannerTitle>
              <BannerActions>
                <Button size="compact" render={<Link {...navigation.link('models')} />}>
                  {tc('models.connect')}
                </Button>
                <Button
                  size="compact"
                  variant="tertiary"
                  render={<a href="/demo" target="_blank" rel="noreferrer" />}
                >
                  {t('tryDemo')}
                </Button>
              </BannerActions>
            </Banner>
          ) : null}
          {autoBlocked ? (
            <Banner data-testid="models-not-ready" status="warning" contrast="high" size="compact">
              <BannerTitle>
                {t('autoNotReady', { model: autoProfile?.label ?? autoChoice.modelProfile })}
              </BannerTitle>
              <BannerActions>
                <Button size="compact" render={<Link {...navigation.link('models')} />}>
                  {tc('models.connect')}
                </Button>
                <Button
                  size="compact"
                  variant="tertiary"
                  render={<a href="/demo" target="_blank" rel="noreferrer" />}
                >
                  {t('tryDemo')}
                </Button>
              </BannerActions>
            </Banner>
          ) : null}
          {missingTeam && (intent === 'next' || intent === 'explain') ? (
            <p
              role="alert"
              data-testid="selected-team-missing"
              className="text-caption text-warning"
            >
              {t('selectedTeamMissing')}
            </p>
          ) : null}
          {refusal ? (
            <RefusalHelp
              sessionId={session.sessionId}
              message={refusal.message}
              code={refusal.code}
              owner={refusal.owner}
              network={refusal.network}
              onRetry={() => void send()}
              onQueue={() => {
                setRefusal(null);
                chooseIntent('queue');
              }}
            />
          ) : null}
          {missingChips.length ? (
            <p role="alert" className="text-caption text-danger">
              {tc('missingReferences', { count: missingChips.length })}
            </p>
          ) : null}
          {refusal?.code === 'RUN_ALREADY_ACTIVE' ? (
            <DevelopmentMode sessionId={session.sessionId} onlyActive />
          ) : null}
          {chips.length ? (
            <ul aria-label={tc('references')} className="flex flex-wrap gap-1">
              {chips.map((item) => (
                <li
                  key={item.id}
                  data-missing={missing.has(item.id) || undefined}
                  className={`flex max-w-full items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 text-caption ${missing.has(item.id) ? 'bg-danger/10 text-danger line-through' : 'bg-subtle'}`}
                >
                  <span className="truncate font-mono" title={mentionLabel(item)}>
                    {mentionLabel(item)}
                  </span>
                  {missing.has(item.id) ? (
                    <span className="sr-only">{tc('referenceGone')}</span>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-tiny"
                    aria-label={tc('removeReference', { label: mentionLabel(item) })}
                    onClick={() => {
                      write(removeMention(text, item, chips));
                      setPicked((list) => list.filter((x) => x.id !== item.id));
                    }}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <ImageAttachmentPicker
            key={`images:${attachmentEpoch}`}
            inputRef={imageFiles}
            enabled={intent === 'next'}
            sessionId={session.sessionId}
            value={images}
            onChange={setImages}
            onBusyChange={setImagesBusy}
            disabled={busy}
          />
          <TextAttachmentPicker
            key={`text:${attachmentEpoch}`}
            inputRef={textFiles}
            value={attachments}
            onChange={setAttachments}
            onLoading={setAttachmentsBusy}
            disabled={busy}
            enabled={intent === 'next' || intent === 'queue'}
            hideList
          />
          <SourceAttachments
            value={attachments}
            onChange={setAttachments}
            disabled={busy || attachmentsBusy}
          />
          <p
            id={destinationId}
            data-testid="composer-destination"
            className={
              quietDestination
                ? 'sr-only'
                : `px-1 text-caption ${intent === 'steer' && !ownActive ? 'text-warning' : 'text-muted-foreground'}`
            }
          >
            {destination}
          </p>
          {attachments.length > 0 && intent !== 'next' && intent !== 'queue' ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground"
            >
              <span>{contextMessages('nextOrQueue')}</span>
              {allowed
                .filter((value) => value === 'next' || value === 'queue')
                .map((value) => (
                  <Button
                    key={value}
                    variant="tertiary"
                    size="compact"
                    onClick={() => chooseIntent(value)}
                  >
                    {tc(`switchTo.${value}`)}
                  </Button>
                ))}
            </div>
          ) : null}
        </>
      }
      renderInput={(inputProps) => (
        <ComposerInput
          inputRef={inputProps.ref}
          textareaProps={inputProps}
          label={t('requestLabel')}
          placeholder={tc('placeholder')}
          value={text}
          onChange={(value) => {
            setRecall(-1);
            write(value);
          }}
          onKeyDown={onKeyDown}
          commands={commands}
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
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-compact" aria-label={tc('attachmentActions')} />
              }
            >
              <Plus />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuItem
                onClick={() => {
                  const box = input.current;
                  const at = box?.selectionStart ?? text.length;
                  const before = text.slice(0, at);
                  const head = `${before}${before && !/\s$/.test(before) ? ' ' : ''}@`;
                  write(`${head}${text.slice(at)}`);
                  requestAnimationFrame(() => {
                    box?.focus();
                    box?.setSelectionRange(head.length, head.length);
                  });
                }}
              >
                <AtSign />
                {tc('addReference')}
              </MenuItem>
              <MenuSeparator />
              {mode === 'server' ? (
                <MenuItem
                  disabled={
                    busy ||
                    imagesBusy ||
                    attachmentsBusy ||
                    intent !== 'next' ||
                    images.length >= IMAGE_MAX_COUNT
                  }
                  onClick={() => imageFiles.current?.click()}
                >
                  {tc('attachImages')}
                </MenuItem>
              ) : null}
              <MenuItem
                disabled={
                  busy ||
                  attachmentsBusy ||
                  imagesBusy ||
                  (intent !== 'next' && intent !== 'queue') ||
                  attachments.length >= TEXT_ATTACHMENT_MAX_COUNT
                }
                onClick={() => textFiles.current?.click()}
              >
                {tc('attachText')}
              </MenuItem>
              {mode === 'server' ? (
                <MenuItem
                  disabled={
                    busy ||
                    attachmentsBusy ||
                    imagesBusy ||
                    (intent !== 'next' && intent !== 'queue') ||
                    attachments.length >= TEXT_ATTACHMENT_MAX_COUNT
                  }
                  onClick={() => setMaterialsOpen(true)}
                >
                  {materialMessages('attachPlaceholder')}
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>{' '}
          {onWorkFolder ? (
            // The kit home's "work in a folder" entry, while the project has none.
            <Tooltip content={td('workFolder')}>
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={td('workFolder')}
                onClick={onWorkFolder}
              >
                <FolderOpen />
              </Button>
            </Tooltip>
          ) : null}
          {(intent === 'next' || intent === 'queue') && !resolved.blocked ? (
            <Select
              variant="chip"
              label={tc('teamLabel')}
              value={team ? `corral:${team.corralId}` : teamMode}
              disabled={busy}
              open={teamOpen}
              onOpenChange={setTeamOpen}
              onValueChange={(value) => {
                const choice = String(value);
                if (choice === 'manage')
                  // The library's teams for this project, coming back to this session.
                  void navigate({
                    to: '/library/teams',
                    search: {
                      project: session.projectId,
                      returnTo: router.state.location.href,
                    },
                  });
                else if (choice.startsWith('corral:')) void updateTeam(choice.slice(7));
                else {
                  setTeamMode(choice === 'auto' ? 'auto' : 'none');
                  if (!isAuto) void updateTeam('');
                }
              }}
              options={[
                { value: 'none', label: tc('teamNone'), hint: tc('teamNoneHint') },
                // Corral: the automatic team first, then each saved Corral.
                {
                  value: 'auto',
                  label: tc('teamAuto'),
                  hint: tc('teamAutoHint'),
                  group: tc('teamCorralGroup'),
                },
                ...corrals.map((corral) => ({
                  value: `corral:${corral.corralId}`,
                  label: corral.name,
                  hint: tc('teamCorralHint'),
                  group: tc('teamCorralGroup'),
                })),
                // Creating or editing a Corral happens in the library.
                { value: 'manage', label: tc('manageCorrals'), group: tc('teamCorralGroup') },
              ]}
            />
          ) : null}
        </>
      }
      rightSlot={
        <>
          {(isAuto || team) &&
          (intent === 'next' || intent === 'explain' || intent === 'queue') &&
          (profiles || services.mode === 'browser') ? (
            profiles ? (
              <AutoModelMenu
                value={autoChoice}
                profiles={profiles}
                showReasoning={intent === 'next' || intent === 'queue'}
                disabled={busy}
                open={autoModelOpen}
                onOpenChange={setAutoModelOpen}
                onChange={(value) => void updateAuto(value)}
              />
            ) : (
              <ModelPicker
                models={[]}
                value=""
                placeholder={tc('modelPicker.demo')}
                reasoning={null}
                disabled={busy}
                open={autoModelOpen}
                onOpenChange={setAutoModelOpen}
                side="top"
                align="end"
                labels={{
                  model: t('autoModel'),
                  settings: tc('modelPicker.settings'),
                  trigger: () => t('autoModel'),
                  empty: tc('modelPicker.demoEmpty'),
                }}
              />
            )
          ) : null}
          {intent === 'next' || intent === 'queue' ? (
            <PermissionModePicker
              value={permissionMode}
              onChange={setPermissionMode}
              disabled={busy}
            />
          ) : null}
          <LiveVoice
            api={services.voice ?? null}
            target={{
              hostId: window.location.origin,
              sessionId: session.sessionId,
              ...(ownActive ? { runId: ownActive.runId } : {}),
              ...(ownActive && steerTarget ? { executionId: steerTarget } : {}),
            }}
            targetLabel={session.title}
            onTranscript={submitVoice}
          />
        </>
      }
    />
  );
  return (
    <ComposerSurface.Shell>
      {/* One line above the input: intent, an ended run, plan, changes, activity, held items, Overview. */}
      <ComposerDock
        planId={planRegion}
        lead={
          <ComposerHeader
            choosingAuto={choosingAuto}
            onCancelAuto={cancelAuto}
            allowed={allowed}
            blocked={resolved.blocked}
            intent={intent}
            onChooseIntent={chooseIntent}
            steerTarget={steerTarget}
            targets={targets}
            targetName={targetName}
            onChooseTarget={chooseTarget}
            about={latest?.label ?? null}
            quiet={home}
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
        onAutoStartChange={setAutoStart}
        startDisabled={Boolean(active) || busy || savedRequestUnavailable}
        onStart={(entry) => void startQueued(entry)}
        onEdit={(entry) => void editQueued(entry)}
        onRemove={(entry) => void removeQueued(entry)}
      />
      {compose}
      {home && corrals.length > 0 ? (
        // The kit home's start suggestions: a saved team picks the team chip, never a prompt.
        <ul aria-label={t('startSuggestions')} className="mt-4 flex flex-wrap justify-center gap-2">
          {corrals.slice(0, 4).map((corral) => (
            <li key={corral.corralId}>
              <Button
                variant="tertiary"
                size="compact"
                disabled={busy}
                onClick={() => {
                  void updateTeam(corral.corralId);
                  input.current?.focus();
                }}
              >
                {t('startWithTeam', { team: corral.name })}
              </Button>
            </li>
          ))}
        </ul>
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
      <Dialog open={materialsOpen} onOpenChange={setMaterialsOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{materialMessages('attachPlaceholder')}</DialogTitle>
            <DialogDescription>{materialMessages('hint')}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {materialsOpen ? (
              <ProjectMaterialPicker
                key={attachmentEpoch}
                projectId={session.projectId}
                value={attachments}
                onChange={(value) => {
                  setAttachments(value);
                  setMaterialsOpen(false);
                }}
                onBusyChange={setAttachmentsBusy}
                disabled={busy || (intent !== 'next' && intent !== 'queue')}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog open={modelsOpen} onOpenChange={setModelsOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tc('models.title')}</DialogTitle>
            <DialogDescription>
              {runMode === 'live' ? tc('models.liveNote') : tc('models.mockNote')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {team ? (
              <ModelAssignments roles={roles} profiles={profiles} />
            ) : (
              <p
                className="text-body text-muted-foreground"
                data-testid={isAuto ? 'auto-model' : undefined}
              >
                {missingTeam
                  ? t('selectedTeamMissing')
                  : `${t('autoHint')} ${autoProfile?.label ?? autoChoice.modelProfile}`}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {team ? (
              <Button
                variant="tertiary"
                render={
                  <Link
                    to="/corrals/$corralId/edit"
                    params={{ corralId: team.corralId }}
                    search={{ fromSession: session.sessionId }}
                  />
                }
              >
                {t('editTeam')}
              </Button>
            ) : null}
            {mode === 'server' ? (
              <Button render={<Link {...navigation.link('models')} />}>
                {tc('models.settings')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={confirmStop && !runControlsOwnConfirmation} onOpenChange={setConfirmStop}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr('cancelRun')}</DialogTitle>
            <DialogDescription>
              {tr('cancelRunExplain')} {tr('cancelNotSent')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="tertiary" onClick={() => setConfirmStop(false)}>
              {tr('keepRunning')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmStop(false);
                if (ownActive) void runCommand('cancel', ownActive.runId);
              }}
            >
              {tr('confirmCancelRun')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </ComposerSurface.Shell>
  );
}

/** The newest final result among the session's ended runs. */
function useLatestResult(runs: RunSummary[]) {
  const { transport } = useServices();
  const [latest, setLatest] = useState<{ runId: string; id: string; label: string } | null>(null);
  // Newest first; a joined key so the lookup reruns only when the ended runs change.
  const key = runs
    .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
    .map((r) => r.runId)
    .reverse()
    .join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const runId of key ? key.split(',') : []) {
        const { projection } = await transport.getSnapshot(runId);
        const id = finalResultId(projection);
        const artifact = id ? projection.artifacts[id] : undefined;
        if (id && artifact) {
          if (live) setLatest({ runId, id, label: `${artifact.name} v${artifact.version}` });
          return;
        }
      }
      if (live) setLatest(null);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [transport, key]);
  return latest;
}

/** Each role of the team, the model profile it uses, and whether that model is ready. */
function ModelAssignments({
  roles,
  profiles,
}: {
  roles: RoleModel[];
  profiles: ProfileInfo[] | null;
}) {
  const tc = useTranslations('Composer');
  if (!roles.length)
    return <p className="text-body text-muted-foreground">{tc('models.noTeam')}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line/60 text-body" data-testid="model-assignments">
      {roles.map((role) => {
        const profile = profiles?.find((p) => p.profileId === role.profileId);
        const state = !profiles
          ? 'simulated'
          : !profile
            ? 'missing'
            : profile.available
              ? 'ready'
              : 'signin';
        return (
          <li key={role.roleId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span style={{ fontVariationSettings: fontWeights.semibold }}>{role.name}</span>
            <span className="font-mono text-caption text-muted-foreground">{role.profileId}</span>
            <span className="min-w-0 flex-1 text-caption text-muted-foreground">
              {profile?.label ?? ''}
            </span>
            <span
              className={`text-caption ${state === 'ready' ? 'text-success' : state === 'simulated' ? 'text-muted-foreground' : 'text-warning'}`}
            >
              {tc(`models.state.${state}`)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
