import {
  type AutoRoute,
  type CommandError,
  type RunReference,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  type CorralRepository,
  carriedDirectives,
  carriedEntry,
  entryStartReferences,
  nextQueuedEntry,
  queuedSessionCommandId,
  type RunProjection,
  resendEntry,
  resendStep,
  type SessionEntryAuto,
  type SessionEntryStart,
  type WorkSession,
} from '@corral/core';

// The server starts a work session's first queued request when a run of that session ends
// in this process, or when a request is queued while the session has no open run
// (features/composer-flow.md, "대기 요청과 넘겨받기"). Its start command is the entry's own,
// so a screen starting the same entry reaches the same single run. A person's directive its
// target never read because the target succeeded first is carried to the front of the queue
// and started even without autoStart. A request failed on a usage limit is resent once it resets.

export type QueuedStartRequest = SessionEntryStart & {
  commandId: string;
  sessionId: string;
  brief: string;
  conversation?: { throughRunId: string };
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

export interface QueueRun {
  runId: string;
  sessionId?: string | null;
  status: RunStatus;
  startedAt: string;
}

export interface SessionQueueDeps {
  repository: Pick<CorralRepository, 'getSession' | 'updateSessionEntry' | 'addSessionEntry'>;
  runs(): readonly QueueRun[];
  setupRunning?(sessionId: string): boolean;
  /** The run of the session a directive was sent in, read from the runs' records. */
  directiveRun(sessionId: string, directiveId: string): string | null;
  start(request: QueuedStartRequest): Promise<QueuedStartOutcome>;
  projection(runId: string): RunProjection | null;
  now(): number;
  timer(sessionId: string, at: string, fire: () => void): () => void;
  /** Only the session and an error code; never a request body or a path. */
  log(sessionId: string, code: string): void;
}

/**
 * The run a session's next request continues, chosen as the screen chooses it: the ended run
 * that started last (the runs in list order, reversed, then stably ordered by start time).
 * The same entry then has the same start payload from the server and from a screen.
 */
export function conversationRun(runs: readonly QueueRun[], sessionId: string): string | null {
  const ordered = runs
    .filter((run) => run.sessionId === sessionId)
    .reverse()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return ordered.findLast((run) => TERMINAL_RUN_STATUSES.has(run.status))?.runId ?? null;
}

export function createSessionQueue(deps: SessionQueueDeps) {
  // One pass at a time per session, so two runs ending together start one request.
  const passes = new Map<string, Promise<void>>();
  const open = (sessionId: string) =>
    deps.setupRunning?.(sessionId) === true ||
    deps
      .runs()
      .some((run) => run.sessionId === sessionId && !TERMINAL_RUN_STATUSES.has(run.status));

  // A carried request starts without autoStart unless the person cancelled the run it came from.
  const carriedPast = (sessionId: string, directiveId: string | undefined) => {
    if (!directiveId) return false;
    const runId = deps.directiveRun(sessionId, directiveId);
    return deps.runs().find((run) => run.runId === runId)?.status !== 'cancelled';
  };

  const timers = new Map<string, { at: string; clear: () => void }>();
  const disarm = (sessionId: string) => {
    timers.get(sessionId)?.clear();
    timers.delete(sessionId);
  };
  const arm = (sessionId: string, at: string) => {
    if (timers.get(sessionId)?.at === at) return;
    disarm(sessionId);
    timers.set(sessionId, {
      at,
      clear: deps.timer(sessionId, at, () => {
        timers.delete(sessionId);
        void schedule(sessionId, () => pass(sessionId, true));
      }),
    });
  };

  const pass = async (sessionId: string, resendOnly = false): Promise<void> => {
    if (open(sessionId)) return;
    const session = await deps.repository.getSession(sessionId);
    if (!session || session.meeting) return;
    const entry = nextQueuedEntry(session);
    if (resendOnly && !entry?.resend) return;
    if (entry?.resend) {
      const step = resendStep(entry, session, conversationRun(deps.runs(), sessionId), deps.now());
      if (step.kind === 'dismiss') {
        disarm(sessionId);
        const result = await deps.repository.updateSessionEntry(sessionId, entry.entryId, {
          state: 'dismissed',
        });
        if (!result.ok) return deps.log(sessionId, result.error);
        return pass(sessionId);
      }
      if (step.kind === 'wait') return arm(sessionId, step.until);
      disarm(sessionId);
      if (step.kind === 'hold') return;
    }
    if (
      !entry?.start ||
      !(session.autoStart || entry.afterSetup || carriedPast(sessionId, entry.carriedFrom))
    )
      return;
    const commandId = queuedSessionCommandId(sessionId, entry);
    const throughRunId = conversationRun(deps.runs(), sessionId);
    // The same references, in the same order, as a person starting this entry sends.
    const references = entryStartReferences(entry);
    const outcome = await deps.start({
      ...entry.start,
      commandId,
      sessionId,
      brief: entry.text,
      ...(throughRunId ? { conversation: { throughRunId } } : {}),
      ...(references.length ? { references } : {}),
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

  // The repository records a directive once, so a repeated report adds nothing.
  const carry = async (sessionId: string, runId: string, projection: RunProjection) => {
    const directives = carriedDirectives(projection);
    if (directives.length === 0) return;
    const session = await deps.repository.getSession(sessionId);
    if (!session || session.meeting) return;
    for (const directive of directives) {
      if (session.entries.some((item) => item.carriedFrom === directive.directiveId)) continue;
      const entry = carriedEntry(session, runId, directive);
      if (!entry) continue;
      const saved = await deps.repository.addSessionEntry(sessionId, entry);
      if (!saved.ok) deps.log(sessionId, saved.error);
    }
    // Saved after the run's end may already have been reported: look at the queue again.
    if (!open(sessionId)) await pass(sessionId);
  };

  const copy = async (sessionId: string, runId: string) => {
    const projection = deps.projection(runId);
    const session = projection ? await deps.repository.getSession(sessionId) : null;
    const entry =
      session && projection ? resendEntry(session, runId, projection, deps.now()) : null;
    if (entry) {
      const saved = await deps.repository.addSessionEntry(sessionId, entry);
      if (!saved.ok) deps.log(sessionId, saved.error);
    }
    await pass(sessionId);
  };

  const schedule = (sessionId: string, work = () => pass(sessionId)): Promise<void> => {
    const previous = passes.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((error: unknown) => deps.log(sessionId, errorCode(error)));
    passes.set(sessionId, next);
    void next.finally(() => {
      if (passes.get(sessionId) === next) passes.delete(sessionId);
    });
    return next;
  };

  return {
    /** Called once when this process sees a run reach a terminal state. */
    onRunEnded(runId: string): Promise<void> {
      const sessionId = deps.runs().find((run) => run.runId === runId)?.sessionId;
      return sessionId ? schedule(sessionId, () => copy(sessionId, runId)) : Promise.resolve();
    },
    /** Called when this process sees directives of a run expire unread. */
    onDirectivesExpired(runId: string, projection: RunProjection): Promise<void> {
      const sessionId = deps.runs().find((run) => run.runId === runId)?.sessionId;
      return sessionId
        ? schedule(sessionId, () => carry(sessionId, runId, projection))
        : Promise.resolve();
    },
    /** Called after a queued entry is saved; a session with an open run waits for its end. */
    onEntryQueued(sessionId: string): Promise<void> {
      return open(sessionId) ? Promise.resolve() : schedule(sessionId);
    },
    onSetupEnded(sessionId: string): Promise<void> {
      return open(sessionId) ? Promise.resolve() : schedule(sessionId);
    },
    /** A screen records a request after its start answers; its run may have ended already. */
    onEntryRecorded(sessionId: string, runId: string | null): Promise<void> {
      const ended = deps
        .runs()
        .some((run) => run.runId === runId && TERMINAL_RUN_STATUSES.has(run.status));
      return runId && ended ? schedule(sessionId, () => copy(sessionId, runId)) : Promise.resolve();
    },
    async resume(sessions: readonly WorkSession[]): Promise<void> {
      await Promise.all(
        sessions
          .filter((session) => nextQueuedEntry(session)?.resend)
          .map((session) => schedule(session.sessionId)),
      );
    },
    close() {
      for (const sessionId of [...timers.keys()]) disarm(sessionId);
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
