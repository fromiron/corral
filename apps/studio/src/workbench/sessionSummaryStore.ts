import type { SessionCompactionOutcome, SessionCompactionView } from '@corral/contracts';

export interface SessionSummaryState {
  /** The kept summary the next request attaches. */
  view: SessionCompactionView | null;
  /** The accepted compaction this screen is waiting on, or how it settled. */
  outcome: SessionCompactionOutcome | null;
}

export type SessionSummaryRead = (
  sessionId: string,
  commandId?: string,
) => Promise<{
  compaction: SessionCompactionView | null;
  outcome: SessionCompactionOutcome | null;
}>;

export interface SummaryTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: SummaryTimers = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const EMPTY: SessionSummaryState = { view: null, outcome: null };

/** About two minutes in all. A summary that takes longer shows the next time the session opens. */
export const SUMMARY_POLL_DELAYS: readonly number[] = [500, 1_000, 2_000, ...Array(40).fill(3_000)];

interface Watch {
  state: SessionSummaryState;
  listeners: Set<() => void>;
  awaiting: string | null;
  handle: unknown;
}

/**
 * The session summary every view of one session shares. Idle compaction has no run and so no
 * event stream: after the server accepts it, the outcome is read again until it settles. Reading
 * stops when no view shows that session, and a late answer for a session no longer shown is dropped.
 */
export class SessionSummaryStore {
  private readonly watches = new Map<string, Watch>();
  private readonly read: SessionSummaryRead;
  private readonly timers: SummaryTimers;

  constructor(read: SessionSummaryRead, timers: SummaryTimers = browserTimers) {
    this.read = read;
    this.timers = timers;
  }

  get(sessionId: string): SessionSummaryState {
    return this.watches.get(sessionId)?.state ?? EMPTY;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let watch = this.watches.get(sessionId);
    if (!watch) {
      const opened: Watch = { state: EMPTY, listeners: new Set(), awaiting: null, handle: null };
      watch = opened;
      this.watches.set(sessionId, opened);
      this.read(sessionId).then(
        (result) => {
          if (this.watches.get(sessionId) !== opened || opened.awaiting) return;
          this.set(opened, { ...opened.state, view: result.compaction });
        },
        () => {},
      );
    }
    watch.listeners.add(listener);
    const owned = watch;
    return () => {
      owned.listeners.delete(listener);
      if (owned.listeners.size || this.watches.get(sessionId) !== owned) return;
      if (owned.handle !== null) this.timers.clearTimeout(owned.handle);
      owned.handle = null;
      owned.awaiting = null;
      this.watches.delete(sessionId);
    };
  }

  /** The server accepted this command. Nothing is read when no view shows the session. */
  accepted(sessionId: string, commandId: string) {
    const watch = this.watches.get(sessionId);
    if (!watch) return;
    if (watch.handle !== null) this.timers.clearTimeout(watch.handle);
    watch.awaiting = commandId;
    this.set(watch, { ...watch.state, outcome: { commandId, phase: 'pending' } });
    this.poll(sessionId, watch, commandId, 0);
  }

  private poll(sessionId: string, watch: Watch, commandId: string, attempt: number) {
    const current = () => this.watches.get(sessionId) === watch && watch.awaiting === commandId;
    const delay = SUMMARY_POLL_DELAYS[attempt];
    if (delay === undefined) {
      watch.handle = null;
      watch.awaiting = null;
      this.set(watch, { ...watch.state, outcome: null });
      return;
    }
    watch.handle = this.timers.setTimeout(() => {
      watch.handle = null;
      if (!current()) return;
      this.read(sessionId, commandId).then(
        (result) => {
          if (!current()) return;
          // Accepted, then neither pending nor recorded: the server lost it.
          const outcome = result.outcome ?? { commandId, phase: 'failed' as const };
          if (outcome.phase === 'pending') {
            this.poll(sessionId, watch, commandId, attempt + 1);
            return;
          }
          watch.awaiting = null;
          this.set(watch, { view: result.compaction, outcome });
        },
        () => {
          if (current()) this.poll(sessionId, watch, commandId, attempt + 1);
        },
      );
    }, delay);
  }

  private set(watch: Watch, state: SessionSummaryState) {
    watch.state = state;
    for (const listener of [...watch.listeners]) listener();
  }
}
