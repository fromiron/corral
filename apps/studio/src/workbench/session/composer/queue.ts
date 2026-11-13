import type { AutoModelChoice, RunReference } from '@corral/contracts';
import type { RunSummary, SessionEntry } from '@corral/core';
import { queuedSessionCommandId } from '@corral/core';
import { useEffect, useRef } from 'react';
import type { StudioServices } from '../../../services.tsx';
import { autoCommandSeed } from '../../autoChoice.ts';
import { RESEND_REQUEST } from '../../RefusalHelp.tsx';
import {
  clearPending,
  commandFor,
  entryStart,
  type Ref,
  type StartDeps,
  startNext,
} from './send.ts';

// Starting a waiting request by the person, now or again after a run that did not finish. The
// server starts queued requests when the session's run ends; this page does not.

/** The same queued item under the same model and team keeps one command. */
export const entryCommandKey = (
  entry: SessionEntry,
  resend: boolean,
  choice: AutoModelChoice,
  teamKey: string,
) =>
  `${resend ? 'resend' : 'queue'}\u0000${entry.entryId}\u0000${autoCommandSeed(entry.text, [...(entry.attachments ?? []), ...(resend ? (entry.images ?? []) : [])], choice, teamKey)}\u0000${entry.permissionMode ?? ''}`;

export interface QueueDeps extends StartDeps {
  services: Pick<StudioServices, 'mode' | 'live' | 'startAuto' | 'repository'>;
  messages: { selectedTeamMissing: string; failed: (message: string) => string };
  /** The team chip's value: a saved Corral, or the team mode. */
  teamKey: string;
  busy: boolean;
  active: boolean;
  autoSaving: Ref<boolean>;
  /** A saved request cannot start now (models, team or live runtime). */
  savedRequestUnavailable: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  invalidate: () => Promise<void>;
  onChange: () => void;
}

export async function startQueued(deps: QueueDeps, entry: SessionEntry, resend = false) {
  const { services, session } = deps;
  if (
    deps.busy ||
    deps.autoRequest.current ||
    deps.autoSaving.current ||
    deps.active ||
    deps.savedRequestUnavailable
  )
    return;
  deps.setBusy(true);
  const queuedReferences: RunReference[] = [
    ...(entry.attachments ?? []),
    ...(resend ? (entry.images ?? []) : []),
  ];
  try {
    if (!resend) {
      const current = await services.repository.getSession(session.sessionId);
      const persisted = current?.entries.find((item) => item.entryId === entry.entryId);
      if (
        persisted?.state !== 'queued' ||
        queuedSessionCommandId(session.sessionId, persisted) !==
          queuedSessionCommandId(session.sessionId, entry)
      ) {
        await deps.invalidate();
        deps.onChange();
        return;
      }
    }
    const commandId = commandFor(
      deps.commands,
      entryCommandKey(entry, resend, deps.choice, deps.teamKey),
      resend ? undefined : queuedSessionCommandId(session.sessionId, entry),
    );
    const {
      runId,
      detail,
      error: commandError,
      auto,
      cancelError,
      request,
    } = await startNext(
      deps,
      entry.text,
      commandId,
      queuedReferences,
      entry.permissionMode,
      // Started now, a saved request goes with its own snapshot, as the server would start it;
      // sent again after a failed run, it is a new request with today's choices.
      resend ? undefined : entry.start,
    );
    if (!resend && commandError?.code === 'IDEMPOTENCY_CONFLICT') {
      // Another tab can have a different model/history snapshot of the same queue item.
      // Its original receipt owns the outcome, including while that start is pending.
      deps.setError(detail ?? commandError.message);
      await deps.invalidate();
      deps.onChange();
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
      ? await services.repository.addSessionEntry(session.sessionId, {
          intent: 'next',
          text: entry.text,
          commandId,
          ...outcome,
          ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
          ...(entry.attachments ? { attachments: entry.attachments } : {}),
          ...(entry.images ? { images: entry.images } : {}),
          ...(request ? { start: entryStart(request) } : {}),
        })
      : await services.repository.updateSessionEntry(session.sessionId, entry.entryId, outcome);
    if (!saved.ok) throw new Error(deps.messages.failed(saved.message));
    clearPending(deps.commands);
    if (cancelError) deps.setError(cancelError);
    await deps.invalidate();
    deps.onChange();
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === 'AbortError')
      clearPending(deps.commands);
    else
      deps.setError(
        deps.messages.failed(failure instanceof Error ? failure.message : String(failure)),
      );
  } finally {
    deps.setBusy(false);
  }
}

export interface ResendState {
  sessionId: string;
  active: boolean;
  pending: boolean;
}

export interface ResendDeps {
  services: Pick<StudioServices, 'transport'>;
  sessionId: string;
  entries: SessionEntry[];
  runs: RunSummary[];
  active: boolean;
  busy: boolean;
  autoRequest: Ref<unknown>;
  pending: Ref<{ key: string } | null>;
  state: Ref<ResendState>;
  /** The command key this entry would resend under. */
  commandKey: (entry: SessionEntry) => string;
  resolvePendingMessage: string;
  setError: (message: string | null) => void;
  start: (entry: SessionEntry) => Promise<void>;
}

/** Sends a request again whose run, or instruction, did not get through. */
export async function resendQueued(deps: ResendDeps, entryId: string) {
  const entry = deps.entries.find((item) => item.entryId === entryId);
  if (
    !entry?.runId ||
    deps.active ||
    deps.busy ||
    deps.autoRequest.current ||
    deps.state.current.pending
  )
    return;
  deps.state.current.pending = true;
  try {
    if (entry.intent === 'steer') {
      const { projection } = await deps.services.transport.getSnapshot(entry.runId);
      const directive = Object.values(projection.directives).find(
        (item) => item.commandId === entry.commandId,
      );
      if (!directive || !['not_delivered', 'expired', 'cancelled'].includes(directive.status))
        return;
    } else if (
      !deps.runs.some(
        (run) =>
          run.runId === entry.runId && ['cancelled', 'interrupted', 'failed'].includes(run.status),
      )
    )
      return;
    if (
      deps.state.current.sessionId !== deps.sessionId ||
      deps.state.current.active ||
      deps.autoRequest.current
    )
      return;
    if (deps.pending.current && deps.pending.current.key !== deps.commandKey(entry)) {
      deps.setError(deps.resolvePendingMessage);
      return;
    }
    await deps.start(entry);
  } finally {
    deps.state.current.pending = false;
  }
}

/**
 * The queue's actions: start now, resend, edit and remove. The server starts queued requests
 * when the session's run ends (features/composer-flow.md "대기 요청과 넘겨받기"); this page
 * never starts one by itself.
 */
export function useQueuedRequests({
  deps,
  runs,
  pending,
  resolvePendingMessage,
  onEdit,
}: {
  deps: QueueDeps & {
    services: Pick<StudioServices, 'mode' | 'live' | 'startAuto' | 'repository' | 'transport'>;
  };
  runs: RunSummary[];
  pending: Ref<{ key: string } | null>;
  resolvePendingMessage: string;
  /** Takes a queued request back into the box. */
  onEdit: (entry: SessionEntry) => void;
}) {
  const { services, session } = deps;
  const start = (entry: SessionEntry, resend = false) => startQueued(deps, entry, resend);
  const resend = useResendRequests(session.sessionId, deps.active, deps.setError);
  resend.resend.current = (entryId) =>
    resendQueued(
      {
        services,
        sessionId: session.sessionId,
        entries: session.entries,
        runs,
        active: deps.active,
        busy: deps.busy,
        autoRequest: deps.autoRequest,
        pending,
        state: resend.state,
        commandKey: (entry) => entryCommandKey(entry, true, deps.choice, deps.teamKey),
        resolvePendingMessage,
        setError: deps.setError,
        start: (entry) => start(entry, true),
      },
      entryId,
    );
  const remove = async (entry: SessionEntry) => {
    await services.repository.updateSessionEntry(session.sessionId, entry.entryId, {
      state: 'dismissed',
    });
    await deps.invalidate();
  };
  /** Editing a queued task takes it back into the box; sending again records a new version. */
  const edit = async (entry: SessionEntry) => {
    onEdit(entry);
    await services.repository.updateSessionEntry(session.sessionId, entry.entryId, {
      state: 'dismissed',
      detail: 'edited',
    });
    await deps.invalidate();
  };
  return { start, remove, edit };
}

/** The session's resend state, and the handler a refused turn's "send again" reaches. */
export function useResendRequests(
  sessionId: string,
  active: boolean,
  setError: (message: string | null) => void,
) {
  const state = useRef<ResendState>({ sessionId, active, pending: false });
  state.current = { ...state.current, sessionId, active };
  const resend = useRef<(entryId: string) => Promise<void>>(async () => {});
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; entryId: string }>).detail;
      if (detail?.sessionId === sessionId && typeof detail.entryId === 'string')
        void resend
          .current(detail.entryId)
          .catch((failure: unknown) =>
            setError(failure instanceof Error ? failure.message : String(failure)),
          );
    };
    window.addEventListener(RESEND_REQUEST, listener);
    return () => window.removeEventListener(RESEND_REQUEST, listener);
  }, [sessionId, setError]);
  return { state, resend };
}
