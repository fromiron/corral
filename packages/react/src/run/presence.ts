import { type ExecutionStatus, type RunStatus, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { AgentStatus } from '../design-kit/components/agent/agent-primitives.tsx';

// One rule for what a Run, an Execution, and a session look like on screen
// (docs/specs/features/presence.md). Pure: no React, DOM, clock, or messages.

/** Display states, highest priority first. */
const KINDS = [
  'awaiting_user',
  'failed',
  'interrupted',
  'stopping',
  'pausing',
  'paused',
  'starting',
  'working',
  'succeeded',
  'cancelled',
  'ready',
  'empty',
] as const;
export type PresenceKind = (typeof KINDS)[number];
export type PresenceNeed = 'approval' | 'question' | 'continue';
export type PresenceDetail =
  | 'waiting_agents'
  | 'waiting_reply'
  | 'watching'
  | 'round_limit'
  | 'rounds_stalled';
export type PresenceTone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';
export type PresenceGroup = 'attention' | 'running' | 'completed' | 'cancelled' | 'ready' | 'empty';

export interface Presence {
  kind: PresenceKind;
  need?: PresenceNeed;
  detail?: PresenceDetail;
  tone: PresenceTone;
  /** The kit glyph; a session without a run has none. */
  glyph: AgentStatus | null;
  /** Key in the `Presence` message namespace. */
  labelKey: `state.${PresenceKind}`;
  detailKey?: `detail.${PresenceDetail}`;
}

export interface PresenceRequest {
  kind: PresenceNeed;
  /** Smaller is older. */
  order: number;
}

/** How a Loop's round ended (the `loop.iteration_finished` outcome). */
export type LoopOutcome =
  | 'pass'
  | 'revise'
  | 'inconclusive'
  | 'cap_reached'
  | 'stalled'
  | 'cancelled';

const OUT_OF_ROUNDS: Partial<Record<LoopOutcome, PresenceDetail>> = {
  cap_reached: 'round_limit',
  stalled: 'rounds_stalled',
};

export const PRESENCE_EXIT_GRACE_MS = 2_000;

const LOOK: Record<PresenceKind, { tone: PresenceTone; glyph: AgentStatus | null }> = {
  awaiting_user: { tone: 'warning', glyph: 'waiting' },
  failed: { tone: 'danger', glyph: 'failed' },
  interrupted: { tone: 'danger', glyph: 'failed' },
  stopping: { tone: 'active', glyph: 'running' },
  pausing: { tone: 'active', glyph: 'running' },
  paused: { tone: 'warning', glyph: 'stopped' },
  starting: { tone: 'active', glyph: 'queued' },
  working: { tone: 'active', glyph: 'running' },
  succeeded: { tone: 'success', glyph: 'done' },
  cancelled: { tone: 'neutral', glyph: 'stopped' },
  ready: { tone: 'neutral', glyph: null },
  empty: { tone: 'neutral', glyph: null },
};

const RUN_KIND: Record<RunStatus, PresenceKind> = {
  created: 'starting',
  validating: 'starting',
  running: 'working',
  pausing: 'pausing',
  paused: 'paused',
  awaiting_user: 'awaiting_user',
  cancelling: 'stopping',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

const EXECUTION_KIND: Record<ExecutionStatus, PresenceKind> = {
  queued: 'starting',
  ready: 'starting',
  active: 'working',
  waiting_children: 'working',
  waiting_message: 'working',
  waiting_approval: 'awaiting_user',
  pausing: 'pausing',
  paused: 'paused',
  cancelling: 'stopping',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

function presence(kind: PresenceKind, need?: PresenceNeed, detail?: PresenceDetail): Presence {
  return {
    kind,
    ...(need ? { need } : {}),
    ...(detail ? { detail, detailKey: `detail.${detail}` as const } : {}),
    ...LOOK[kind],
    labelKey: `state.${kind}`,
  };
}

export function executionPresence(execution: {
  status: ExecutionStatus;
  observer?: boolean;
}): Presence {
  const detail: PresenceDetail | undefined =
    execution.status === 'waiting_children'
      ? 'waiting_agents'
      : execution.status === 'waiting_message'
        ? execution.observer
          ? 'watching'
          : 'waiting_reply'
        : undefined;
  return presence(
    EXECUTION_KIND[execution.status],
    execution.status === 'waiting_approval' ? 'approval' : undefined,
    detail,
  );
}

/** An advisor resting between reviews: it watches, and waits for nobody's answer. */
export function executionWatching(
  execution: { status: ExecutionStatus; advisor?: boolean } | undefined,
): boolean {
  return (
    !!execution &&
    executionPresence({ status: execution.status, observer: execution.advisor === true }).detail ===
      'watching'
  );
}

/**
 * The Run's own status decides. Its executions and open requests only find out whether it waits
 * for the person, and an ended Run never does: a failed or cancelled execution shows on its own
 * row, not as the Run's state.
 */
export function runPresence(
  run: { status: RunStatus },
  executions: readonly { status: ExecutionStatus }[],
  pending: readonly PresenceRequest[],
  /** Each Loop's last finished round's outcome, in the order the Loops started. */
  loops: readonly (LoopOutcome | null)[] = [],
): Presence {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    const earliest = pending.reduce<PresenceRequest | undefined>(
      (first, request) => (!first || request.order < first.order ? request : first),
      undefined,
    );
    const approvalWaits = executions.some((execution) => execution.status === 'waiting_approval');
    if (earliest || approvalWaits || run.status === 'awaiting_user')
      // With nothing open, the Run waits on whether to restart a cancelled required task.
      return presence('awaiting_user', earliest?.kind ?? (approvalWaits ? 'approval' : 'continue'));
  }
  const kind = RUN_KIND[run.status];
  // A completed Run that went on from a Loop's last candidate says why: the first Loop to start
  // whose last round ran out. A Run that ended any other way says nothing of its Loops.
  const ranOut =
    kind === 'succeeded' ? loops.find((outcome) => outcome && OUT_OF_ROUNDS[outcome]) : null;
  return presence(kind, undefined, ranOut ? OUT_OF_ROUNDS[ranOut] : undefined);
}

/** The latest run's state, or `ready`/`empty` for a session without one. */
export function sessionPresence(
  latestRun: Presence | null,
  session: { terminalAttention: boolean; hasContent: boolean },
): Presence {
  if (latestRun) return latestRun;
  return presence(session.hasContent ? 'ready' : 'empty');
}

const GROUP: Record<PresenceKind, PresenceGroup> = {
  awaiting_user: 'attention',
  failed: 'attention',
  interrupted: 'attention',
  paused: 'attention',
  starting: 'running',
  working: 'running',
  pausing: 'running',
  stopping: 'running',
  succeeded: 'completed',
  cancelled: 'cancelled',
  ready: 'ready',
  empty: 'empty',
};

/** The session list group of a state; the review group is the inbox's call, not this one. */
export function sessionGroupOf(
  state: Pick<Presence, 'kind'>,
  terminalAttention: boolean,
): PresenceGroup {
  return terminalAttention ? 'attention' : GROUP[state.kind];
}

const IN_PROGRESS = new Set<PresenceKind>(['starting', 'working']);
const ENDED = new Set<PresenceKind>(['succeeded', 'cancelled']);

/**
 * What to show when the state changes. Only an end (`starting`/`working` into
 * `succeeded`/`cancelled`) is held: the previous state stays until two seconds after `endedAt`,
 * or, when the end time is unknown, after `since`, the first sight of the change. While held,
 * the result gives `holdUntil`, when to settle again, and the `since` to pass on that call, so
 * the end of the hold never moves. Every other change shows at once.
 */
export function settle(
  previous: Presence | null,
  next: Presence,
  timing: { endedAt?: number | null; since?: number | null; now: number },
): { presence: Presence; holdUntil: number | null; since: number | null } {
  const settled = { presence: next, holdUntil: null, since: null };
  if (!previous || !IN_PROGRESS.has(previous.kind) || !ENDED.has(next.kind)) return settled;
  const since = timing.endedAt == null ? (timing.since ?? timing.now) : null;
  const holdUntil = (timing.endedAt ?? since ?? timing.now) + PRESENCE_EXIT_GRACE_MS;
  if (timing.now >= holdUntil) return settled;
  return { presence: previous, holdUntil, since };
}
