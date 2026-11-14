import { ApiError, type AutoCancelResult, type AutoRunStart } from '@corral/client';
import type {
  AutoModelChoice,
  CommandError,
  ImageAttachment,
  PermissionMode,
  RunReference,
  TextAttachment,
} from '@corral/contracts';
import type {
  AutoStartResult,
  CorralSummary,
  RunSummary,
  SessionEntryAuto,
  SessionEntryStart,
  SessionIntent,
  WorkSession,
} from '@corral/core';
import { createPendingSessionCommands } from '../../../pendingCommands.ts';
import type { StudioServices } from '../../../services.tsx';
import { conversationRequest } from '../../../sessionActions.ts';
import { autoCommandSeed } from '../../autoChoice.ts';
import type { Delivery } from '../../composerIntent.ts';

// The composer's send paths as plain functions: a new request, a queued one, an instruction to
// a running execution (a join or an interrupt). The component owns the state; these get it, and the services, as arguments.

export const newCommandId = () => `cmd_${globalThis.crypto.randomUUID()}`;

// Keep uncertain requests across SPA navigation, never request controllers.
export const pendingSessionCommands = createPendingSessionCommands(
  typeof window !== 'undefined' && window.corralRemote ? window.localStorage : undefined,
  typeof window !== 'undefined' ? window.corralRemote?.hostId : undefined,
);
export type PendingSessionCommands = typeof pendingSessionCommands;
export type PendingCommand = NonNullable<ReturnType<PendingSessionCommands['get']>>;

export type Ref<T> = { current: T };

/** A session's one uncertain command: a retry after a lost answer reuses its ID. */
export interface CommandSlot {
  sessionId: string;
  pending: Ref<PendingCommand | null>;
  store: Pick<PendingSessionCommands, 'get' | 'set' | 'delete'>;
  newId: () => string;
  /** A send is in flight: pressing it again sends nothing more. */
  sending: Ref<boolean>;
}

// One command ID per request: a retry after a lost answer reuses it, so the runtime returns
// the first receipt instead of starting a second run.
export function commandFor(slot: CommandSlot, key: string, commandId?: string): string {
  if (slot.pending.current?.key !== key) {
    slot.pending.current = { key, commandId: commandId ?? slot.newId() };
    slot.store.set(slot.sessionId, slot.pending.current);
  }
  return slot.pending.current.commandId;
}

export function clearPending(slot: CommandSlot) {
  if (slot.store.get(slot.sessionId) === slot.pending.current) slot.store.delete(slot.sessionId);
  slot.pending.current = null;
}

/** An auto start in flight, so it can be cancelled before or after its run exists. */
export interface AutoRequest {
  controller: AbortController;
  commandId: string;
  result: Promise<AutoStartResult>;
  cancellation?: Promise<AutoCancelResult>;
}

export function cancelAutoRequest(
  services: Pick<StudioServices, 'cancelAuto' | 'transport'>,
  sessionId: string,
  request: AutoRequest | null,
  newId: () => string,
) {
  if (!request || request.cancellation) return;
  const cancelCommandId = newId();
  request.cancellation = services.cancelAuto
    ? services.cancelAuto({ commandId: request.commandId, sessionId, cancelCommandId })
    : request.result.then(
        async (start) => ({
          start,
          cancellation: start.runId
            ? await services.transport.sendCommand({
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
}

export type TeamMode = 'none' | 'auto';

export interface StartDeps {
  services: Pick<StudioServices, 'mode' | 'live' | 'startAuto'>;
  session: WorkSession;
  choice: AutoModelChoice;
  teamMode: TeamMode;
  /** A follow-up carries the session's turns through the newest ended run. */
  throughRunId: string | null;
  /** The session's saved Corral was deleted. */
  missingTeam: boolean;
  messages: { selectedTeamMissing: string };
  commands: CommandSlot;
  autoRequest: Ref<AutoRequest | null>;
  onChoosingAuto: (choosing: boolean) => void;
}

export interface StartOutcome {
  runId: string | null;
  detail: string | null;
  code?: string | undefined;
  error?: CommandError | undefined;
  auto?: SessionEntryAuto | null;
  cancelled?: boolean;
  cancelError?: string;
  /** The start body that was sent; a new request records its snapshot from it. */
  request?: AutoRunStart;
}

/**
 * What a session entry keeps of a start body for the server to start it with: the body without
 * the command, request text, session, conversation and references (features/composer-flow.md).
 */
export function entryStart(request: AutoRunStart): SessionEntryStart {
  const {
    commandId: _commandId,
    brief: _brief,
    sessionId: _sessionId,
    conversation: _conversation,
    references: _references,
    ...start
  } = request;
  return start;
}

/** The start a next request is saved with: the server starts it with this once the run ends. */
export function queuedStart(
  deps: Pick<StartDeps, 'services' | 'session' | 'choice' | 'teamMode'>,
  brief: string,
  permissionMode?: PermissionMode,
): SessionEntryStart {
  return entryStart(
    conversationRequest(deps.services, deps.session, {
      ...(permissionMode ? { permissionMode } : {}),
      commandId: '',
      brief,
      choice: deps.choice,
      team: deps.teamMode,
    }),
  );
}

/** Starts a follow-up with the team; returns the run or why not. */
export async function startNext(
  deps: StartDeps,
  brief: string,
  commandId: string = deps.commands.newId(),
  refs: RunReference[] = [],
  requestPermissionMode?: PermissionMode,
  /** A saved request's own start snapshot, so a person's start equals the server's. */
  start?: SessionEntryStart,
): Promise<StartOutcome> {
  // every chat turn is the conversation lead; a saved Corral lends it its roles.
  // A deleted Corral is never replaced by another way of working.
  if (deps.missingTeam) return { runId: null, detail: deps.messages.selectedTeamMissing };
  return startAuto(deps, brief, commandId, refs, requestPermissionMode, start);
}

/** with no team chosen, the runtime picks a template for this request. */
async function startAuto(
  deps: StartDeps,
  brief: string,
  commandId: string,
  refs: RunReference[],
  requestPermissionMode?: PermissionMode,
  start?: SessionEntryStart,
): Promise<StartOutcome> {
  const { services, session, commands } = deps;
  const controller = new AbortController();
  // The server starts a saved request with this body (apps/server/src/session-queue.ts).
  const proposed: AutoRunStart = start
    ? {
        ...start,
        commandId,
        sessionId: session.sessionId,
        brief,
        ...(deps.throughRunId ? { conversation: { throughRunId: deps.throughRunId } } : {}),
        ...(refs.length ? { references: refs } : {}),
      }
    : conversationRequest(services, session, {
        ...(requestPermissionMode ? { permissionMode: requestPermissionMode } : {}),
        commandId,
        brief,
        choice: deps.choice,
        team: deps.teamMode,
        ...(deps.throughRunId ? { throughRunId: deps.throughRunId } : {}),
        ...(refs.length ? { references: refs } : {}),
      });
  const command = commands.pending.current;
  // A completed run may change `lastEnded` before its lost start receipt is recovered.
  let body = proposed;
  if (command?.commandId === commandId) {
    command.autoRequest ??= structuredClone(proposed);
    commands.store.set(session.sessionId, command);
    body = command.autoRequest;
  }
  const request: AutoRequest = {
    controller,
    commandId,
    result: services.startAuto(body, controller.signal),
  };
  deps.autoRequest.current = request;
  deps.onChoosingAuto(true);
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
      request: body,
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
    if (deps.autoRequest.current === request) {
      deps.autoRequest.current = null;
      deps.onChoosingAuto(false);
    }
  }
}

export type SessionEntryInput = Parameters<StudioServices['repository']['addSessionEntry']>[1];

export interface RecordDeps {
  services: Pick<StudioServices, 'repository'>;
  session: WorkSession;
  messages: { failed: (message: string) => string };
  /** The first request names the session; project lists reload. */
  onTitleChange: () => void;
}

export async function recordEntry(deps: RecordDeps, entry: SessionEntryInput) {
  const saved = await deps.services.repository.addSessionEntry(deps.session.sessionId, entry);
  if (!saved.ok) throw new Error(deps.messages.failed(saved.message));
  if (saved.session.title !== deps.session.title) deps.onTitleChange();
}

/** Why the last request did not start; the text stays in the box to send again. */
export interface Refusal {
  message: string;
  code?: string | undefined;
  owner?: CommandError['owner'];
  network?: boolean;
  /**
   * The refused request is in the conversation with its reason: its message's meta line says
   * why, so the composer does not say it again (features/composer-flow.md).
   */
  recorded?: boolean;
}

export interface SendDeps extends StartDeps, RecordDeps {
  services: Pick<StudioServices, 'mode' | 'live' | 'startAuto' | 'transport' | 'repository'>;
  messages: {
    selectedTeamMissing: string;
    failed: (message: string) => string;
  };
  team: CorralSummary | null;
  ownActive: RunSummary | null;
  runMode: 'mock' | 'live';
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  setRefusal: (refusal: Refusal | null) => void;
  invalidate: () => Promise<void>;
  onChange: () => void;
  /** Clears the sent draft; an intent that did not carry an item keeps it in the box. */
  clearDraft: (revision: number, preserveAttachments: boolean, preserveImages: boolean) => void;
}

export interface SendInput {
  body: string;
  intent: SessionIntent;
  /** An instruction's delivery, a join or an interrupt; null for any other intent. */
  delivery: Delivery | null;
  steerTarget: string;
  references: RunReference[];
  attachments: TextAttachment[];
  images: ImageAttachment[];
  permissionMode: PermissionMode | undefined;
  /** The draft revision written when this send began. */
  revision: number;
}

/** Whether a send went through, and whether the runtime lowered its interrupt to a join. */
export interface SendOutcome {
  sent: boolean;
  lowered: boolean;
}

/** A refused request keeps its text, intent and references so it can be fixed and resent. */
async function refused(
  deps: SendDeps,
  message: string,
  code?: string,
  owner?: CommandError['owner'],
  recorded = false,
) {
  // A refusal is final for that command; the next attempt is a new command.
  clearPending(deps.commands);
  deps.setRefusal({ message, code, owner, ...(recorded ? { recorded } : {}) });
  await deps.invalidate();
  deps.onChange();
}

/** Sends the composer's text as its intent says. */
export async function sendRequest(deps: SendDeps, input: SendInput): Promise<SendOutcome> {
  const { services, session, team, ownActive } = deps;
  const { body, intent, delivery, steerTarget, attachments, images, permissionMode } = input;
  const outcome: SendOutcome = { sent: false, lowered: false };
  // Pressing the same send again while it is in flight sends nothing more.
  if (deps.commands.sending.current) return outcome;
  deps.commands.sending.current = true;
  deps.setBusy(true);
  deps.setError(null);
  deps.setRefusal(null);
  try {
    if (intent === 'next') {
      const refs: RunReference[] = [...input.references, ...attachments, ...images];
      // The team is part of the request: changing it after a lost answer is a new request.
      const commandId = commandFor(
        deps.commands,
        autoCommandSeed(body, refs, deps.choice, team ? `corral:${team.corralId}` : deps.teamMode) +
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
        request,
      } = await startNext(deps, body, commandId, refs, permissionMode);
      await recordEntry(deps, {
        ...(permissionMode ? { permissionMode } : {}),
        intent,
        text: body,
        state: runId ? 'started' : 'refused',
        runId,
        detail,
        refusal: commandError ?? null,
        commandId,
        ...(auto ? { auto } : {}),
        ...(input.references.length ? { references: input.references } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(images.length ? { images } : {}),
        ...(request ? { start: entryStart(request) } : {}),
      });
      if (cancelled) {
        clearPending(deps.commands);
        if (cancelError) deps.setError(cancelError);
        await deps.invalidate();
        deps.onChange();
        return outcome;
      }
      if (!runId) {
        await refused(
          deps,
          detail ?? deps.messages.failed(''),
          code,
          commandError?.owner,
          Boolean(detail),
        );
        return outcome;
      }
    } else if (intent === 'queue') {
      await recordEntry(deps, {
        intent,
        text: body,
        state: 'queued',
        // Started later, it carries what a new request sent now would (session-queue.ts).
        ...(input.references.length ? { references: input.references } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(images.length ? { images } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        start: queuedStart(deps, body, permissionMode),
      });
    } else if (intent === 'steer' && delivery && ownActive && steerTarget) {
      // The delivery and the attachments are part of the instruction: changing either after a
      // lost answer is a new command.
      const commandId = commandFor(
        deps.commands,
        [
          'steer',
          steerTarget,
          delivery,
          body,
          attachments.map((item) => item.sha256).join(','),
        ].join('\u0000'),
      );
      const receipt = await services.transport.sendCommand({
        schemaVersion: '0.1',
        commandId,
        runId: ownActive.runId,
        type: 'steer',
        payload: {
          targetExecutionId: steerTarget,
          text: body,
          delivery,
          ...(attachments.length ? { attachments } : {}),
        },
      });
      // The instruction's own record (the run's directive) keeps its attachments.
      await recordEntry(deps, {
        intent,
        text: body,
        state: receipt.error ? 'refused' : 'sent',
        runId: ownActive.runId,
        executionId: steerTarget,
        detail: receipt.error?.message ?? null,
        refusal: receipt.error ?? null,
        commandId,
      });
      if (receipt.error) {
        await refused(
          deps,
          receipt.error.message,
          receipt.error.code,
          receipt.error.owner,
          Boolean(receipt.error.message),
        );
        return outcome;
      }
      // An interrupt the target cannot take is lowered to the next request by the runtime
      // (features/reins.md "전달 방식"); the receipt's boundary says so.
      outcome.lowered = delivery === 'interrupt' && receipt.requestedBoundary === 'next_request';
    } else {
      return outcome;
    }
    clearPending(deps.commands);
    // Text attachments ride every send; images a new or a next request (features/composer-flow.md).
    deps.clearDraft(input.revision, false, intent !== 'next' && intent !== 'queue');
    await deps.invalidate();
    deps.onChange();
    outcome.sent = true;
    return outcome;
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === 'AbortError') {
      clearPending(deps.commands);
      return outcome;
    }
    if (
      failure instanceof ApiError &&
      failure.owner &&
      ['RUN_ALREADY_ACTIVE', 'RESOURCE_CAPACITY'].includes(failure.code)
    ) {
      await refused(deps, failure.message, failure.code, failure.owner);
      return outcome;
    }
    // The answer was lost: the request may or may not have arrived. The text stays, and a
    // retry reuses the same command ID, so the runtime returns the first receipt.
    deps.setRefusal({
      message: failure instanceof Error ? failure.message : String(failure),
      network: true,
    });
    return outcome;
  } finally {
    deps.commands.sending.current = false;
    deps.setBusy(false);
  }
}
