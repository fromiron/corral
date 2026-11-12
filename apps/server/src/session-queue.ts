import {
  type AutoRoute,
  type CommandError,
  type RunReference,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  type CorralRepository,
  queuedSessionCommandId,
  type SessionEntryAuto,
  type SessionEntryStart,
} from '@corral/core';

// The server starts a work session's first queued request when a run of that session ends
// in this process (features/composer-flow.md, "대기 요청과 넘겨받기"). Its start command is
// the entry's own, so a screen starting the same entry reaches the same single run.

export type QueuedStartRequest = SessionEntryStart & {
  commandId: string;
  sessionId: string;
  brief: string;
  conversation: { throughRunId: string };
  references?: RunReference[];
};

export type QueuedStartOutcome =
  | { ok: false; code: string }
  | {
      ok: true;
      runId: string | null;
      error: CommandError | null;
      autoRoute: AutoRoute | null;
    };

export interface SessionQueueDeps {
  repository: Pick<CorralRepository, 'getSession' | 'updateSessionEntry'>;
  runs(): readonly { runId: string; sessionId?: string | null; status: RunStatus }[];
  start(request: QueuedStartRequest): Promise<QueuedStartOutcome>;
  /** Only the session and an error code; never a request body or a path. */
  log(sessionId: string, code: string): void;
}

export function createSessionQueue(deps: SessionQueueDeps) {
  // One pass at a time per session, so two runs ending together start one request.
  const passes = new Map<string, Promise<void>>();

  const pass = async (sessionId: string, endedRunId: string) => {
    const active = deps
      .runs()
      .some(
        (run) =>
          run.sessionId === sessionId &&
          run.runId !== endedRunId &&
          !TERMINAL_RUN_STATUSES.has(run.status),
      );
    if (active) return;
    const session = await deps.repository.getSession(sessionId);
    if (!session || session.meeting) return;
    const entry = session.entries.find((item) => item.state === 'queued');
    if (!entry?.start || !(session.autoStart || entry.carriedFrom)) return;
    const commandId = queuedSessionCommandId(sessionId, entry);
    const outcome = await deps.start({
      ...entry.start,
      commandId,
      sessionId,
      brief: entry.text,
      conversation: { throughRunId: endedRunId },
      ...(entry.attachments?.length ? { references: entry.attachments } : {}),
    });
    if (!outcome.ok) {
      deps.log(sessionId, outcome.code);
      return;
    }
    // Another start with this command owns the outcome, including one still pending.
    if (outcome.error?.code === 'IDEMPOTENCY_CONFLICT') return;
    const current = await deps.repository.getSession(sessionId);
    const saved = current?.entries.find((item) => item.entryId === entry.entryId);
    if (saved?.state !== 'queued' || queuedSessionCommandId(sessionId, saved) !== commandId) return;
    const auto = outcome.autoRoute ? entryAuto(outcome.autoRoute) : null;
    const result = await deps.repository.updateSessionEntry(sessionId, entry.entryId, {
      state: outcome.runId ? 'started' : 'refused',
      runId: outcome.runId,
      detail: outcome.error?.message ?? null,
      refusal: outcome.error,
      ...(auto ? { auto } : {}),
    });
    if (!result.ok) deps.log(sessionId, result.error);
  };

  return {
    /** Called once when this process sees a run reach a terminal state. */
    runEnded(runId: string): Promise<void> {
      const sessionId = deps.runs().find((run) => run.runId === runId)?.sessionId;
      if (!sessionId) return Promise.resolve();
      const previous = passes.get(sessionId) ?? Promise.resolve();
      const next = previous
        .then(() => pass(sessionId, runId))
        .catch((error: unknown) => deps.log(sessionId, errorCode(error)));
      passes.set(sessionId, next);
      void next.finally(() => {
        if (passes.get(sessionId) === next) passes.delete(sessionId);
      });
      return next;
    },
  };
}

/** The same record a screen keeps for an auto request's template and reasoning. */
function entryAuto(route: AutoRoute): SessionEntryAuto {
  return {
    template: route.template,
    ...(route.harness ? { harness: route.harness } : {}),
    source: route.source,
    reason: route.reason,
    modelProfile: route.modelProfile,
    ...(route.fallback ? { fallback: route.fallback } : {}),
    ...(route.reasoning ? { requestedReasoning: route.reasoning } : {}),
    ...(route.reasoningChoice
      ? { reasoning: route.reasoningChoice.level, reasoningSource: route.reasoningChoice.source }
      : {}),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.name : 'unknown';
}
