import type { Scheduler } from '@corral/contracts';
import type { NewSessionEntry, SessionResult, WorkSession } from '@corral/core';
import {
  evaluatePullRequestWatch,
  PULL_REQUEST_WAKE_LIMIT,
  type PullRequestWatchState,
  pullRequestWakeEntry,
  pullRequestWakeText,
  type WatchedCheck,
} from '@corral/core';
import type { Db } from '@corral/storage-sqlite';

export const PULL_REQUEST_SWEEP_MS = 2 * 60_000;

export interface WatchedPr {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
  statusCheckRollup?: {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
    detailsUrl?: string;
    targetUrl?: string;
  }[];
  reviewDecision?: string;
  mergeable?: string;
  comments?: unknown[];
  reviews?: unknown[];
}

export type PullRequestNeed = 'review' | 'remarks' | 'wakes_stopped' | 'no_start';

interface Row {
  session_id: string;
  branch: string;
  number: number;
  url: string;
  base: string;
  head_sha: string;
  failed_checks_json: string;
  conflicting: number;
  wakes: number;
  review: string | null;
  remarks_seen: number;
  remarks_now: number;
  pending_entry: string | null;
  needs: string | null;
  ended_at: string | null;
}

export interface PullRequestWatcherDeps {
  db: Db;
  now(): string;
  timers: Scheduler;
  getSession(sessionId: string): Promise<WorkSession | null>;
  addEntry(sessionId: string, entry: NewSessionEntry): Promise<SessionResult>;
  dismissEntry(sessionId: string, entryId: string): Promise<void>;
  read(sessionId: string): Promise<void>;
  queued(sessionId: string): void;
}

const FAILED = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
]);

export function watchedChecks(pr: WatchedPr): WatchedCheck[] {
  return (pr.statusCheckRollup ?? []).map((check) => ({
    name: check.name ?? check.context ?? 'check',
    url: check.detailsUrl || check.targetUrl || null,
    failed: FAILED.has((check.conclusion || check.state || '').toUpperCase()),
  }));
}

const remarksOf = (pr: WatchedPr) => (pr.comments?.length ?? 0) + (pr.reviews?.length ?? 0);
const reviewOf = (pr: WatchedPr) =>
  pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED'
    ? pr.reviewDecision
    : null;

export class PullRequestWatcher {
  private readonly deps: PullRequestWatcherDeps;
  private cancelSweep: (() => void) | null = null;
  private closed = false;

  constructor(deps: PullRequestWatcherDeps) {
    this.deps = deps;
  }

  async observe(
    sessionId: string,
    context: { branch: string; base: string },
    prs: readonly WatchedPr[],
    source: 'screen' | 'server',
  ): Promise<void> {
    const row = this.row(sessionId);
    const open = prs.find((pr) => pr.state === 'OPEN');
    if (!open) {
      if (row && !row.ended_at && row.branch === context.branch) await this.end(row);
      return;
    }
    if (!row || row.ended_at || row.branch !== context.branch || row.number !== open.number) {
      this.start(sessionId, context, open);
      return;
    }
    if (source === 'screen') {
      this.deps.db
        .prepare(
          `UPDATE pull_request_watches SET remarks_seen=?, remarks_now=?, review=?,
             needs=CASE WHEN needs IN ('review','remarks') THEN NULL ELSE needs END
           WHERE session_id=?`,
        )
        .run(remarksOf(open), remarksOf(open), reviewOf(open), sessionId);
      return;
    }
    await this.evaluate(row, open);
  }

  onRunEnded(sessionId: string): Promise<void> {
    return this.deps.read(sessionId).catch(() => {});
  }

  onPersonRequest(sessionId: string) {
    this.deps.db
      .prepare(
        `UPDATE pull_request_watches SET wakes=0,
           needs=CASE WHEN needs IN ('wakes_stopped','no_start') THEN NULL ELSE needs END
         WHERE session_id=?`,
      )
      .run(sessionId);
  }

  inboxItems(sessions: readonly WorkSession[]) {
    const titles = new Map(sessions.map((session) => [session.sessionId, session.title]));
    const rows = this.deps.db
      .prepare(
        'SELECT session_id, number, needs FROM pull_request_watches WHERE needs IS NOT NULL AND ended_at IS NULL',
      )
      .all() as { session_id: string; number: number; needs: PullRequestNeed }[];
    return rows
      .filter((row) => titles.has(row.session_id))
      .map((row) => ({
        kind: 'pull_request' as const,
        sessionId: row.session_id,
        sessionTitle: titles.get(row.session_id) ?? '',
        runId: null,
        detail: `#${row.number} ${row.needs}`,
      }));
  }

  resume() {
    this.arm();
  }

  close() {
    this.closed = true;
    this.cancelSweep?.();
    this.cancelSweep = null;
  }

  private row(sessionId: string): Row | null {
    return (
      (this.deps.db
        .prepare('SELECT * FROM pull_request_watches WHERE session_id=?')
        .get(sessionId) as Row | undefined) ?? null
    );
  }

  private start(sessionId: string, context: { branch: string; base: string }, pr: WatchedPr) {
    const baseline = evaluatePullRequestWatch(null, {
      headSha: pr.headRefOid,
      checks: watchedChecks(pr),
      mergeable: pr.mergeable ?? 'UNKNOWN',
    }).next;
    this.deps.db
      .prepare(
        `INSERT OR REPLACE INTO pull_request_watches (session_id, branch, number, url, base,
           head_sha, failed_checks_json, conflicting, wakes, review, remarks_seen, remarks_now,
           pending_entry, needs, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, NULL)`,
      )
      .run(
        sessionId,
        context.branch,
        pr.number,
        pr.url,
        context.base,
        baseline.headSha,
        JSON.stringify(baseline.failedChecks),
        baseline.conflicting ? 1 : 0,
        reviewOf(pr),
        remarksOf(pr),
        remarksOf(pr),
        this.deps.now(),
      );
    this.arm();
  }

  private async end(row: Row) {
    await this.dropPending(row);
    this.deps.db
      .prepare('UPDATE pull_request_watches SET ended_at=?, needs=NULL WHERE session_id=?')
      .run(this.deps.now(), row.session_id);
  }

  private async dropPending(row: Row, unlessHead?: string) {
    if (!row.pending_entry) return;
    const session = await this.deps.getSession(row.session_id);
    const entry = session?.entries.find((item) => item.entryId === row.pending_entry);
    if (entry?.state === 'queued' && entry.pullRequest?.headSha !== unlessHead)
      await this.deps.dismissEntry(row.session_id, entry.entryId);
    this.deps.db
      .prepare('UPDATE pull_request_watches SET pending_entry=NULL WHERE session_id=?')
      .run(row.session_id);
  }

  private async evaluate(row: Row, pr: WatchedPr) {
    const session = await this.deps.getSession(row.session_id);
    if (!session || session.archivedAt) {
      await this.end(row);
      return;
    }
    let pending = row.pending_entry
      ? (session.entries.find((item) => item.entryId === row.pending_entry) ?? null)
      : null;
    if (pending && pending.state !== 'queued') pending = null;
    if (pending && pending.pullRequest?.headSha !== pr.headRefOid) {
      await this.deps.dismissEntry(row.session_id, pending.entryId);
      pending = null;
    }
    const state: PullRequestWatchState = {
      headSha: row.head_sha,
      failedChecks: JSON.parse(row.failed_checks_json) as string[],
      conflicting: row.conflicting === 1,
    };
    const report = evaluatePullRequestWatch(state, {
      headSha: pr.headRefOid,
      checks: watchedChecks(pr),
      mergeable: pr.mergeable ?? 'UNKNOWN',
    });
    let wakes = row.wakes;
    let pendingEntry = pending?.entryId ?? null;
    let needs = row.needs;
    if (report.changes.length > 0 && !pending) {
      if (wakes >= PULL_REQUEST_WAKE_LIMIT) needs = 'wakes_stopped';
      else {
        const entry = pullRequestWakeEntry(session, {
          number: pr.number,
          headSha: pr.headRefOid,
          text: pullRequestWakeText({
            number: pr.number,
            url: pr.url,
            base: row.base,
            headSha: pr.headRefOid,
            changes: report.changes,
          }),
        });
        if (!entry) needs = 'no_start';
        else {
          const saved = await this.deps.addEntry(row.session_id, entry);
          // The watch moves on only once the wake is saved, so a failed save is tried again.
          if (!saved.ok) return;
          pendingEntry = saved.session.entries.at(-1)?.entryId ?? null;
          wakes += 1;
          this.deps.queued(row.session_id);
        }
      }
    }
    const review = reviewOf(pr);
    if (review !== row.review && review !== null && needs === null) needs = 'review';
    if (remarksOf(pr) > row.remarks_seen && needs === null) needs = 'remarks';
    this.deps.db
      .prepare(
        `UPDATE pull_request_watches SET head_sha=?, failed_checks_json=?, conflicting=?,
           wakes=?, review=?, remarks_now=?, pending_entry=?, needs=? WHERE session_id=?`,
      )
      .run(
        report.next.headSha,
        JSON.stringify(report.next.failedChecks),
        report.next.conflicting ? 1 : 0,
        wakes,
        review,
        remarksOf(pr),
        pendingEntry,
        needs,
        row.session_id,
      );
  }

  private arm() {
    if (this.closed || this.cancelSweep) return;
    const active = this.deps.db
      .prepare('SELECT count(*) AS n FROM pull_request_watches WHERE ended_at IS NULL')
      .get() as { n: number };
    if (!active.n) return;
    this.cancelSweep = this.deps.timers.after(PULL_REQUEST_SWEEP_MS, () => {
      this.cancelSweep = null;
      void this.sweep();
    });
  }

  private async sweep() {
    const rows = this.deps.db
      .prepare('SELECT session_id FROM pull_request_watches WHERE ended_at IS NULL')
      .all() as { session_id: string }[];
    for (const row of rows) await this.deps.read(row.session_id).catch(() => {});
    this.arm();
  }
}
