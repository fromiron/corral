import { ApiError, type AutoCancelResult } from '@corral/client';
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
  SessionIntent,
  WorkSession,
} from '@corral/core';
import { createPendingSessionCommands } from '../../../pendingCommands.ts';
import type { StudioServices } from '../../../services.tsx';
import { conversationRequest } from '../../../sessionActions.ts';
import { autoCommandSeed } from '../../autoChoice.ts';

// The composer's send paths as plain functions: a new request, a queued one, an instruction to
// a running execution, and a question about the latest result. The component owns the state;
// these get it, and the services, as arguments.

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
}

/** Starts a follow-up with the team; returns the run or why not. */
export async function startNext(
  deps: StartDeps,
  brief: string,
  commandId: string = deps.commands.newId(),
  refs: RunReference[] = [],
  requestPermissionMode?: PermissionMode,
): Promise<StartOutcome> {
  // every chat turn is the conversation lead; a saved Corral lends it its roles.
  // A deleted Corral is never replaced by another way of working.
  if (deps.missingTeam) return { runId: null, detail: deps.messages.selectedTeamMissing };
  return startAuto(deps, brief, commandId, refs, requestPermissionMode);
}

/** with no team chosen, the runtime picks a template for this request. */
async function startAuto(
  deps: StartDeps,
  brief: string,
  commandId: string,
  refs: RunReference[],
  requestPermissionMode?: PermissionMode,
): Promise<StartOutcome> {
  const { services, session, commands } = deps;
  const controller = new AbortController();
  const proposed = conversationRequest(services, session, {
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
}

export interface SendDeps extends StartDeps, RecordDeps {
  services: Pick<
    StudioServices,
    'mode' | 'live' | 'startAuto' | 'startExplain' | 'transport' | 'repository'
  >;
  messages: {
    selectedTeamMissing: string;
    noResult: string;
    failed: (message: string) => string;
  };
  team: CorralSummary | null;
  ownActive: RunSummary | null;
  /** The newest final result, which an explain question asks about. */
  latest: { runId: string; id: string } | null;
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
  steerTarget: string;
  references: RunReference[];
  attachments: TextAttachment[];
  images: ImageAttachment[];
  permissionMode: PermissionMode | undefined;
  /** The draft revision written when this send began. */
  revision: number;
}

/** A refused request keeps its text, intent and references so it can be fixed and resent. */
async function refused(
  deps: SendDeps,
  message: string,
  code?: string,
  owner?: CommandError['owner'],
) {
  // A refusal is final for that command; the next attempt is a new command.
  clearPending(deps.commands);
  deps.setRefusal({ message, code, owner });
  await deps.invalidate();
  deps.onChange();
}

/** Sends the composer's text as its intent says. */
export async function sendRequest(deps: SendDeps, input: SendInput) {
  const { services, session, team, ownActive } = deps;
  const { body, intent, steerTarget, attachments, images, permissionMode } = input;
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
        ...(attachments.length ? { attachments } : {}),
        ...(images.length ? { images } : {}),
      });
      if (cancelled) {
        clearPending(deps.commands);
        if (cancelError) deps.setError(cancelError);
        await deps.invalidate();
        deps.onChange();
        return;
      }
      if (!runId)
        return await refused(deps, detail ?? deps.messages.failed(''), code, commandError?.owner);
    } else if (intent === 'queue') {
      await recordEntry(deps, {
        intent,
        text: body,
        state: 'queued',
        ...(attachments.length ? { attachments } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      });
    } else if (intent === 'steer' && ownActive && steerTarget) {
      const commandId = commandFor(deps.commands, `steer\u0000${steerTarget}\u0000${body}`);
      const receipt = await services.transport.sendCommand({
        schemaVersion: '0.1',
        commandId,
        runId: ownActive.runId,
        type: 'steer',
        payload: { targetExecutionId: steerTarget, text: body, delivery: 'next_request' },
      });
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
      if (receipt.error)
        return await refused(deps, receipt.error.message, receipt.error.code, receipt.error.owner);
    } else if (intent === 'explain') {
      const corral = team ? await services.repository.get(team.corralId) : null;
      // An auto session asks with its own model.
      const profile = team
        ? (corral?.definition.roles[0]?.modelProfile ?? 'model-a')
        : deps.choice.modelProfile;
      const latest = deps.latest;
      if (!latest) {
        deps.setError(deps.messages.noResult);
        return;
      }
      const result = await services.startExplain({
        commandId: commandFor(deps.commands, `explain\u0000${body}`),
        sessionId: session.sessionId,
        question: body,
        modelProfile: profile,
        mode: deps.runMode,
        startFrom: { runId: latest.runId, artifactVersionId: latest.id },
      });
      await recordEntry(deps, {
        intent,
        text: body,
        state: result.runId ? 'started' : 'refused',
        runId: result.runId,
        detail: result.receipt.error?.message ?? null,
        refusal: result.receipt.error ?? null,
      });
      if (!result.runId)
        return await refused(
          deps,
          result.receipt.error?.message ?? deps.messages.noResult,
          result.receipt.error?.code,
          result.receipt.error?.owner,
        );
    } else {
      return;
    }
    clearPending(deps.commands);
    deps.clearDraft(input.revision, intent !== 'next' && intent !== 'queue', intent !== 'next');
    await deps.invalidate();
    deps.onChange();
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === 'AbortError') {
      clearPending(deps.commands);
      return;
    }
    if (
      failure instanceof ApiError &&
      failure.owner &&
      ['RUN_ALREADY_ACTIVE', 'RESOURCE_CAPACITY'].includes(failure.code)
    )
      return await refused(deps, failure.message, failure.code, failure.owner);
    // The answer was lost: the request may or may not have arrived. The text stays, and a
    // retry reuses the same command ID, so the runtime returns the first receipt.
    deps.setRefusal({
      message: failure instanceof Error ? failure.message : String(failure),
      network: true,
    });
  } finally {
    deps.setBusy(false);
  }
}
