import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Clock } from '@corral/contracts';
import type { Db } from '@corral/storage-sqlite';
import { safeRelative, WorkspaceError, type WorkspaceService } from './service.ts';

// Review comments, decisions, applying to the linked folder and reverting (CR-013). Comments and
// decisions are fixed to two trees; applying writes the approved tree's immutable contents and
// records each file's outcome; reverting undoes only what was applied and is unchanged since.

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const now = (clock: Clock) => clock.nowIso();

export interface CommentView {
  commentId: string;
  from: string;
  to: string;
  path: string;
  side: 'before' | 'after';
  startLine: number;
  endLine: number;
  quote: string;
  body: string;
  state: 'draft' | 'submitted' | 'addressed' | 'obsolete';
  batchId: string | null;
  createdAt: string;
}

export interface DecisionView {
  decisionId: string;
  from: string;
  to: string;
  decision: 'approved' | 'changes_requested';
  note: string;
  createdAt: string;
  /** The working copy changed after this decision. */
  stale: boolean;
}

export interface PlanFile {
  path: string;
  action: 'write' | 'delete';
  outcome: 'apply' | 'skip' | 'conflict';
  reason: string | null;
}

export interface IntegrationView {
  integrationId: string;
  decisionId: string;
  state: 'applying' | 'applied' | 'partial' | 'conflict' | 'reverted' | 'failed';
  createdAt: string;
  files: { path: string; action: string; outcome: string; detail: string | null }[];
}

export interface InboxItem {
  kind: 'decision' | 'queued' | 'uncertain_write' | 'integration' | 'check_failed' | 'unreviewed';
  sessionId: string;
  sessionTitle: string;
  runId: string | null;
  detail: string | null;
}

/** The file in the linked folder as it is now: absent, its hash, or refused (a link). */
async function originalState(
  root: string,
  rel: string,
): Promise<{ kind: 'absent' } | { kind: 'file'; hash: string } | { kind: 'other' }> {
  const parts = rel.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch {
      return { kind: 'absent' };
    }
    if (info.isSymbolicLink()) return { kind: 'other' };
    if (index === parts.length - 1)
      return info.isFile()
        ? { kind: 'file', hash: sha256(await readFile(current)) }
        : { kind: 'other' };
    if (!info.isDirectory()) return { kind: 'other' };
  }
  return { kind: 'absent' };
}

async function writeAtomically(full: string, bytes: Buffer) {
  await mkdir(dirname(full), { recursive: true });
  const temporary = join(dirname(full), `.${basename(full)}.corral-${randomUUID().slice(0, 8)}`);
  await writeFile(temporary, bytes);
  await rename(temporary, full);
}

export class ReviewService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly files: WorkspaceService;

  constructor(options: { db: Db; clock: Clock; files: WorkspaceService }) {
    this.db = options.db;
    this.clock = options.clock;
    this.files = options.files;
    // A file whose write was planned when the server stopped has an unknown outcome.
    this.db
      .prepare(
        `UPDATE integration_files SET outcome = 'uncertain',
           detail = 'the server stopped while applying this file' WHERE outcome = 'planned'`,
      )
      .run();
    this.db
      .prepare(`UPDATE integrations SET state = 'partial', updated_at = ? WHERE state = 'applying'`)
      .run(now(this.clock));
  }

  private copy(sessionId: string) {
    const copy = this.files.copyOf(sessionId);
    if (!copy) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    return copy;
  }

  // ── comments ────────────────────────────────────────────────────────────────

  comments(sessionId: string): CommentView[] {
    const rows = this.db
      .prepare('SELECT * FROM review_comments WHERE session_id = ? ORDER BY created_at')
      .all(sessionId) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      commentId: String(r.id),
      from: String(r.from_tree),
      to: String(r.to_tree),
      path: String(r.path),
      side: r.side as CommentView['side'],
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
      quote: String(r.quote),
      body: String(r.body),
      state: r.state as CommentView['state'],
      batchId: (r.batch_id as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  addComment(
    sessionId: string,
    input: Omit<CommentView, 'commentId' | 'state' | 'batchId' | 'createdAt'>,
  ): CommentView {
    const path = safeRelative(input.path);
    if (!input.body.trim()) throw new WorkspaceError('SCHEMA_INVALID', 'a comment needs text');
    const id = `comment_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO review_comments (id, session_id, from_tree, to_tree, path, side, start_line,
           end_line, quote, body, state, batch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.from,
        input.to,
        path,
        input.side,
        input.startLine,
        Math.max(input.startLine, input.endLine),
        input.quote.slice(0, 2000),
        input.body.trim().slice(0, 10_000),
        now(this.clock),
        now(this.clock),
      );
    return this.comments(sessionId).find((c) => c.commentId === id) as CommentView;
  }

  /** People decide when a comment is addressed or obsolete; drafts may also be deleted. */
  setCommentState(sessionId: string, commentId: string, state: CommentView['state'] | 'deleted') {
    const comment = this.comments(sessionId).find((c) => c.commentId === commentId);
    if (!comment) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such comment');
    if (state === 'deleted') {
      if (comment.state !== 'draft')
        throw new WorkspaceError('REVISION_CONFLICT', 'only drafts can be deleted');
      this.db.prepare('DELETE FROM review_comments WHERE id = ?').run(commentId);
      return;
    }
    this.db
      .prepare('UPDATE review_comments SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, now(this.clock), commentId);
  }

  /** The text a batch of drafts sends: each comment with where it points and what it quotes. */
  batchText(sessionId: string, commentIds: string[]): string {
    const chosen = this.comments(sessionId).filter(
      (c) => commentIds.includes(c.commentId) && c.state === 'draft',
    );
    if (chosen.length === 0) throw new WorkspaceError('SCHEMA_INVALID', 'choose draft comments');
    return [
      'Review comments on the working copy. Change the files so each one is addressed:',
      ...chosen.map(
        (c, i) =>
          `${i + 1}. ${c.path} lines ${c.startLine}–${c.endLine} (${c.side === 'after' ? 'current' : 'removed'} text):\n   > ${c.quote.split('\n').join('\n   > ')}\n   ${c.body}`,
      ),
    ].join('\n');
  }

  recordBatch(
    sessionId: string,
    input: {
      commentIds: string[];
      intent: 'steer' | 'next';
      runId: string | null;
      executionId: string | null;
      text: string;
      sent: boolean;
      detail: string | null;
    },
  ): string {
    const id = `batch_${randomUUID().slice(0, 8)}`;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO feedback_batches (id, session_id, intent, run_id, execution_id, text, state,
             detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sessionId,
          input.intent,
          input.runId,
          input.executionId,
          input.text,
          input.sent ? 'sent' : 'refused',
          input.detail,
          now(this.clock),
        );
      if (input.sent) {
        const mark = this.db.prepare(
          `UPDATE review_comments SET state = 'submitted', batch_id = ?, updated_at = ?
           WHERE id = ? AND session_id = ? AND state = 'draft'`,
        );
        for (const commentId of input.commentIds)
          mark.run(id, now(this.clock), commentId, sessionId);
      }
    })();
    return id;
  }

  // ── decisions ───────────────────────────────────────────────────────────────

  async decisions(sessionId: string): Promise<DecisionView[]> {
    const latest = await this.files.latestTree(sessionId);
    const rows = this.db
      .prepare('SELECT * FROM review_decisions WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as Record<string, string>[];
    return rows.map((r) => ({
      decisionId: String(r.id),
      from: String(r.from_tree),
      to: String(r.to_tree),
      decision: r.decision as DecisionView['decision'],
      note: String(r.note),
      createdAt: String(r.created_at),
      stale: latest !== null && latest !== r.to_tree,
    }));
  }

  decide(
    sessionId: string,
    input: { from: string; to: string; decision: DecisionView['decision']; note: string },
  ): string {
    this.copy(sessionId);
    const id = `decision_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO review_decisions (id, session_id, from_tree, to_tree, decision, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.from,
        input.to,
        input.decision,
        input.note.slice(0, 2000),
        now(this.clock),
      );
    return id;
  }

  private decision(sessionId: string, decisionId: string) {
    const row = this.db
      .prepare('SELECT * FROM review_decisions WHERE id = ? AND session_id = ?')
      .get(decisionId, sessionId) as Record<string, string> | undefined;
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such decision');
    if (row.decision !== 'approved')
      throw new WorkspaceError('CAPABILITY_DENIED', 'only approved changes are applied');
    return row;
  }

  // ── applying to the linked folder ───────────────────────────────────────────

  /** What applying would do, file by file, judged against the folder as it is now. */
  async plan(sessionId: string, decisionId: string): Promise<PlanFile[]> {
    const copy = this.copy(sessionId);
    const decision = this.decision(sessionId, decisionId);
    // The whole session's change: from the copy's starting point to the approved tree.
    const changed = await this.files.changedPaths(
      copy.worktree,
      copy.baseTree,
      String(decision.to_tree),
    );
    const plan: PlanFile[] = [];
    for (const { path, status } of changed) {
      const rel = safeRelative(path);
      const action = status === 'D' ? 'delete' : 'write';
      const base = await this.files.blob(copy.worktree, copy.baseTree, rel);
      const target = await this.files.blob(copy.worktree, String(decision.to_tree), rel);
      const now = await originalState(copy.root, rel);
      if (now.kind === 'other') {
        plan.push({
          path: rel,
          action,
          outcome: 'conflict',
          reason: 'not a plain file in the folder',
        });
        continue;
      }
      const current = now.kind === 'file' ? now.hash : null;
      const expected = base ? sha256(base) : null;
      const wanted = target ? sha256(target) : null;
      if (current === wanted)
        plan.push({ path: rel, action, outcome: 'skip', reason: 'already like this' });
      else if (current === expected)
        plan.push({ path: rel, action, outcome: 'apply', reason: null });
      else
        plan.push({
          path: rel,
          action,
          outcome: 'conflict',
          reason: 'changed in the folder since the copy was made',
        });
    }
    return plan;
  }

  async integrate(sessionId: string, decisionId: string): Promise<IntegrationView> {
    const copy = this.copy(sessionId);
    const decision = this.decision(sessionId, decisionId);
    const plan = await this.plan(sessionId, decisionId);
    const id = `integration_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO integrations (id, session_id, decision_id, from_tree, to_tree, state, created_at,
           updated_at) VALUES (?, ?, ?, ?, ?, 'applying', ?, ?)`,
      )
      .run(
        id,
        sessionId,
        decisionId,
        copy.baseTree,
        String(decision.to_tree),
        now(this.clock),
        now(this.clock),
      );
    const record = this.db.prepare(
      `INSERT INTO integration_files (integration_id, path, action, expected_hash, after_hash, outcome,
         detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const settle = this.db.prepare(
      'UPDATE integration_files SET outcome = ?, detail = ? WHERE integration_id = ? AND path = ?',
    );
    for (const file of plan) {
      const base = await this.files.blob(copy.worktree, copy.baseTree, file.path);
      const target = await this.files.blob(copy.worktree, String(decision.to_tree), file.path);
      const expected = base ? sha256(base) : null;
      const after = target ? sha256(target) : null;
      if (file.outcome !== 'apply') {
        record.run(
          id,
          file.path,
          file.action,
          expected,
          after,
          file.outcome === 'skip' ? 'skipped' : 'conflict',
          file.reason,
        );
        continue;
      }
      // Recorded before the folder is touched, so a stop leaves an uncertain file, not a lost one.
      record.run(id, file.path, file.action, expected, after, 'planned', null);
      try {
        // The folder may have changed since the plan: check again right before writing.
        const state = await originalState(copy.root, file.path);
        const current =
          state.kind === 'file' ? state.hash : state.kind === 'absent' ? null : 'other';
        if (current !== expected) {
          settle.run('conflict', 'changed in the folder while applying', id, file.path);
          continue;
        }
        const full = join(copy.root, file.path);
        if (file.action === 'delete') await unlink(full);
        else await writeAtomically(full, target as Buffer);
        settle.run('applied', null, id, file.path);
      } catch (error) {
        settle.run(
          'failed',
          String(error instanceof Error ? error.message : error).slice(0, 200),
          id,
          file.path,
        );
      }
    }
    const outcomes = this.integrationFiles(id).map((f) => f.outcome);
    const state = outcomes.every((o) => o === 'applied' || o === 'skipped')
      ? 'applied'
      : outcomes.some((o) => o === 'applied')
        ? 'partial'
        : outcomes.some((o) => o === 'failed')
          ? 'failed'
          : 'conflict';
    this.db
      .prepare('UPDATE integrations SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, now(this.clock), id);
    return this.integration(id);
  }

  private integrationFiles(id: string) {
    return this.db
      .prepare(
        'SELECT path, action, outcome, detail, expected_hash, after_hash FROM integration_files WHERE integration_id = ? ORDER BY path',
      )
      .all(id) as {
      path: string;
      action: string;
      outcome: string;
      detail: string | null;
      expected_hash: string | null;
      after_hash: string | null;
    }[];
  }

  integration(id: string): IntegrationView {
    const row = this.db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as
      | Record<string, string>
      | undefined;
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such integration');
    return {
      integrationId: id,
      decisionId: String(row.decision_id),
      state: row.state as IntegrationView['state'],
      createdAt: String(row.created_at),
      files: this.integrationFiles(id).map(({ path, action, outcome, detail }) => ({
        path,
        action,
        outcome,
        detail,
      })),
    };
  }

  integrations(sessionId: string): IntegrationView[] {
    const rows = this.db
      .prepare('SELECT id FROM integrations WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as { id: string }[];
    return rows.map((r) => this.integration(r.id));
  }

  /** Undoes applied files that still hold what was applied; later edits are left alone. */
  async revert(sessionId: string, integrationId: string): Promise<IntegrationView> {
    const copy = this.copy(sessionId);
    const row = this.db
      .prepare('SELECT * FROM integrations WHERE id = ? AND session_id = ?')
      .get(integrationId, sessionId) as Record<string, string> | undefined;
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such integration');
    const settle = this.db.prepare(
      'UPDATE integration_files SET outcome = ?, detail = ? WHERE integration_id = ? AND path = ?',
    );
    for (const file of this.integrationFiles(integrationId)) {
      if (file.outcome !== 'applied') continue;
      const state = await originalState(copy.root, file.path);
      const current = state.kind === 'file' ? state.hash : state.kind === 'absent' ? null : 'other';
      if (current !== file.after_hash) {
        settle.run(
          'revert_conflict',
          'changed in the folder after it was applied',
          integrationId,
          file.path,
        );
        continue;
      }
      try {
        const base = await this.files.blob(copy.worktree, String(row.from_tree), file.path);
        const full = join(copy.root, file.path);
        if (base) await writeAtomically(full, base);
        else await unlink(full);
        settle.run('reverted', null, integrationId, file.path);
      } catch (error) {
        settle.run(
          'failed',
          String(error instanceof Error ? error.message : error).slice(0, 200),
          integrationId,
          file.path,
        );
      }
    }
    const outcomes = this.integrationFiles(integrationId).map((f) => f.outcome);
    if (outcomes.some((o) => o === 'reverted'))
      this.db
        .prepare('UPDATE integrations SET state = ?, updated_at = ? WHERE id = ?')
        .run(
          outcomes.every((o) => o !== 'applied' && o !== 'revert_conflict')
            ? 'reverted'
            : 'partial',
          now(this.clock),
          integrationId,
        );
    return this.integration(integrationId);
  }

  // ── what needs a person ─────────────────────────────────────────────────────

  inbox(
    sessions: { sessionId: string; title: string; entries: { state: string; text: string }[] }[],
    runs: { runId: string; status: string; sessionId: string | null }[],
  ): InboxItem[] {
    const items: InboxItem[] = [];
    const titleOf = new Map(sessions.map((s) => [s.sessionId, s.title]));
    for (const run of runs) {
      if (run.status === 'awaiting_user' && run.sessionId && titleOf.has(run.sessionId))
        items.push({
          kind: 'decision',
          sessionId: run.sessionId,
          sessionTitle: titleOf.get(run.sessionId) ?? '',
          runId: run.runId,
          detail: null,
        });
    }
    for (const session of sessions) {
      const title = session.title;
      const id = session.sessionId;
      for (const entry of session.entries.filter((e) => e.state === 'queued'))
        items.push({
          kind: 'queued',
          sessionId: id,
          sessionTitle: title,
          runId: null,
          detail: entry.text.slice(0, 120),
        });
      const uncertain = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM file_operations WHERE session_id = ? AND state = 'uncertain'`,
        )
        .get(id) as { n: number };
      if (uncertain.n > 0)
        items.push({
          kind: 'uncertain_write',
          sessionId: id,
          sessionTitle: title,
          runId: null,
          detail: String(uncertain.n),
        });
      const integration = this.db
        .prepare(
          `SELECT state FROM integrations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(id) as { state: string } | undefined;
      if (integration && ['partial', 'conflict', 'failed'].includes(integration.state))
        items.push({
          kind: 'integration',
          sessionId: id,
          sessionTitle: title,
          runId: null,
          detail: integration.state,
        });
      const check = this.db
        .prepare(
          `SELECT state, name FROM (SELECT state, json_extract(command_json, '$.name') AS name,
             started_at FROM verifications WHERE session_id = ? ORDER BY started_at DESC LIMIT 1)`,
        )
        .get(id) as { state: string; name: string } | undefined;
      if (check && (check.state === 'failed' || check.state === 'error'))
        items.push({
          kind: 'check_failed',
          sessionId: id,
          sessionTitle: title,
          runId: null,
          detail: check.name,
        });
      const copy = this.files.copyOf(id);
      if (copy) {
        const since = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM file_operations WHERE session_id = ? AND state = 'applied'
               AND (? IS NULL OR created_at > ?)`,
          )
          .get(id, copy.reviewedAt, copy.reviewedAt) as { n: number };
        if (since.n > 0)
          items.push({
            kind: 'unreviewed',
            sessionId: id,
            sessionTitle: title,
            runId: null,
            detail: String(since.n),
          });
      }
    }
    return items;
  }
}
