import { rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { type RunStatus, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { Db } from './database.ts';

export interface SessionDeletionSchedule {
  id: string;
  title: string;
}

export interface SessionDeletionHandoff {
  commandId: string;
  direction: 'outgoing' | 'incoming';
  otherSessionId: string;
  otherTitle: string;
  otherDeleted: boolean;
}

/** Facts a deletion confirmation can show. Browser drafts are not in here. */
export interface SessionDeletionPreview {
  sessionId: string;
  revision: number;
  title: string;
  meeting: boolean;
  archived: boolean;
  runs: number;
  messages: number;
  unfinishedRunIds: string[];
  generatedMedia: number;
  inputImages: number;
  schedules: SessionDeletionSchedule[];
  handoffs: SessionDeletionHandoff[];
  /** Ready file checkpoints of the working copy. */
  checkpoints: number;
  /** Ready checkpoints of the linked source folder, such as the one pinned before applying. */
  sourceCheckpoints: number;
  /** Applies whose written files are still in the source folder; their revert record goes too. */
  revertibleIntegrations: number;
  reviewDecisions: number;
  /** Sent review comments; drafts are in the working copy summary. */
  reviewComments: number;
  verifications: number;
  /** Set only while a working copy row is still live. */
  copyGeneration: number | null;
}

export type SessionDeletionResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'conflict' }
  | { ok: false; error: 'unfinished'; runIds: string[] };

const DELETE_TRIGGERS = [
  'run_events_no_delete',
  'conversation_turns_no_delete',
  'model_attempt_events_no_delete',
] as const;

interface SessionRow {
  id: string;
  revision: number;
  title: string;
  archived_at: string | null;
  entries_json: string;
  meeting_json: string | null;
}

interface RunRow {
  id: string;
  status: string;
}

interface HandoffRow {
  source_session_id: string;
  command_id: string;
  target_session_id: string;
  payload_json: string;
}

const countOf = (db: Db, sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

const terminal = (status: string) => TERMINAL_RUN_STATUSES.has(status as RunStatus);

const runsOf = (db: Db, sessionId: string) =>
  db
    .prepare('SELECT id, status FROM runs WHERE session_id=? ORDER BY id')
    .all(sessionId) as RunRow[];

function messageCount(entriesJson: string, meetingJson: string | null) {
  let messages = 0;
  try {
    const entries = JSON.parse(entriesJson) as unknown;
    if (Array.isArray(entries)) messages += entries.length;
  } catch {
    // A row that cannot be read still has no countable requests.
  }
  if (!meetingJson) return messages;
  try {
    const meeting = JSON.parse(meetingJson) as {
      rounds?: { message?: unknown }[];
      queued?: { text?: unknown } | null;
    };
    if (Array.isArray(meeting.rounds)) {
      messages += meeting.rounds.filter(
        (round) => typeof round.message === 'string' && round.message.length > 0,
      ).length;
    }
    if (meeting.queued && typeof meeting.queued.text === 'string' && meeting.queued.text.length > 0)
      messages += 1;
  } catch {
    // The meeting body is unreadable; the stored requests above still count.
  }
  return messages;
}

function schedulesTargeting(db: Db, sessionId: string, includeRemoved: boolean) {
  const rows = db.prepare('SELECT id, schedule_json FROM schedules').all() as {
    id: string;
    schedule_json: string;
  }[];
  const found: { id: string; title: string; removed: boolean }[] = [];
  for (const row of rows) {
    let parsed: { sessionId?: unknown; title?: unknown; deletedAt?: unknown };
    try {
      parsed = JSON.parse(row.schedule_json) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.sessionId !== sessionId) continue;
    const removed = parsed.deletedAt != null;
    if (removed && !includeRemoved) continue;
    found.push({
      id: row.id,
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : row.id,
      removed,
    });
  }
  return found;
}

function readPayload(json: string): { receipt: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(json) as { receipt?: unknown };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const receipt =
        parsed.receipt && typeof parsed.receipt === 'object' && !Array.isArray(parsed.receipt)
          ? { ...(parsed.receipt as Record<string, unknown>) }
          : {};
      return { ...parsed, receipt };
    }
  } catch {
    // Replaced below with the deletion marks the columns can still support.
  }
  return { receipt: {} };
}

function handoffSides(db: Db, sessionId: string): SessionDeletionHandoff[] {
  const rows = db
    .prepare(
      `SELECT source_session_id, command_id, target_session_id, payload_json
       FROM meeting_handoffs WHERE source_session_id=? OR target_session_id=?`,
    )
    .all(sessionId, sessionId) as HandoffRow[];
  const titleOf = db.prepare('SELECT title FROM work_sessions WHERE id=?');
  const sides: SessionDeletionHandoff[] = [];
  for (const row of rows) {
    const receipt = readPayload(row.payload_json).receipt;
    const describe = (direction: SessionDeletionHandoff['direction'], otherId: string) => {
      const live = titleOf.get(otherId) as { title: string } | undefined;
      const snapshot = direction === 'outgoing' ? receipt.targetTitle : receipt.sourceTitle;
      sides.push({
        commandId: row.command_id,
        direction,
        otherSessionId: otherId,
        otherTitle: live?.title ?? (typeof snapshot === 'string' ? snapshot : ''),
        otherDeleted: !live,
      });
    };
    if (row.source_session_id === sessionId) describe('outgoing', row.target_session_id);
    if (row.target_session_id === sessionId && row.source_session_id !== sessionId)
      describe('incoming', row.source_session_id);
  }
  return sides;
}

function copyGeneration(db: Db, sessionId: string) {
  const row = db
    .prepare(
      'SELECT copy_generation AS generation, removed_at AS removed FROM session_worktrees WHERE session_id=?',
    )
    .get(sessionId) as { generation: number; removed: string | null } | undefined;
  return row && row.removed == null ? row.generation : null;
}

export function previewSessionDeletion(db: Db, sessionId: string): SessionDeletionPreview | null {
  const row = db
    .prepare(
      `SELECT id, revision, title, archived_at, entries_json, meeting_json
       FROM work_sessions WHERE id=?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (!row) return null;
  const runs = runsOf(db, sessionId);
  return {
    sessionId: row.id,
    revision: row.revision,
    title: row.title,
    meeting: row.meeting_json != null,
    archived: row.archived_at != null,
    runs: runs.length,
    messages: messageCount(row.entries_json, row.meeting_json),
    unfinishedRunIds: runs.filter((run) => !terminal(run.status)).map((run) => run.id),
    generatedMedia: countOf(
      db,
      'SELECT COUNT(*) AS n FROM generated_media WHERE run_id IN (SELECT id FROM runs WHERE session_id=?)',
      sessionId,
    ),
    inputImages: countOf(
      db,
      'SELECT COUNT(*) AS n FROM input_images WHERE session_id=?',
      sessionId,
    ),
    schedules: schedulesTargeting(db, sessionId, false).map(({ id, title }) => ({ id, title })),
    handoffs: handoffSides(db, sessionId),
    checkpoints: countOf(
      db,
      `SELECT COUNT(*) AS n FROM file_checkpoints WHERE session_id=? AND state='ready'
         AND COALESCE(json_extract(manifest_json, '$.target'), 'working_copy') <> 'original'`,
      sessionId,
    ),
    sourceCheckpoints: countOf(
      db,
      `SELECT COUNT(*) AS n FROM file_checkpoints WHERE session_id=? AND state='ready'
         AND json_extract(manifest_json, '$.target')='original'`,
      sessionId,
    ),
    revertibleIntegrations: countOf(
      db,
      `SELECT COUNT(DISTINCT integration_id) AS n FROM integration_files
       WHERE outcome IN ('applied', 'uncertain', 'revert_conflict')
         AND integration_id IN (SELECT id FROM integrations WHERE session_id=?)`,
      sessionId,
    ),
    reviewDecisions: countOf(
      db,
      'SELECT COUNT(*) AS n FROM review_decisions WHERE session_id=?',
      sessionId,
    ),
    reviewComments: countOf(
      db,
      "SELECT COUNT(*) AS n FROM review_comments WHERE session_id=? AND state <> 'draft'",
      sessionId,
    ),
    verifications: countOf(
      db,
      'SELECT COUNT(*) AS n FROM verifications WHERE session_id=?',
      sessionId,
    ),
    copyGeneration: copyGeneration(db, sessionId),
  };
}

function ownedPaths(db: Db, sessionId: string) {
  const copies = db
    .prepare('SELECT worktree_path AS path FROM session_worktrees WHERE session_id=?')
    .all(sessionId) as { path: string }[];
  const candidates = db
    .prepare('SELECT worktree_path AS path FROM candidate_worktrees WHERE session_id=?')
    .all(sessionId) as { path: string }[];
  return [...copies, ...candidates].map((row) => row.path);
}

/** A session path is removed only when it lies strictly inside the copies folder. */
function removeOwnedPath(path: string, copiesRoot: string) {
  if (!isAbsolute(path)) return;
  const inside = relative(resolve(copiesRoot), resolve(path));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return;
  rmSync(resolve(path), { recursive: true, force: true });
}

function deleteMatching(db: Db, sql: string, ids: string[]) {
  if (ids.length === 0) return;
  db.prepare(sql).run(JSON.stringify(ids));
}

function releaseHandoffs(db: Db, sessionId: string, title: string) {
  const rows = db
    .prepare(
      `SELECT source_session_id, command_id, target_session_id, payload_json
       FROM meeting_handoffs WHERE source_session_id=? OR target_session_id=?`,
    )
    .all(sessionId, sessionId) as HandoffRow[];
  const remains = db.prepare('SELECT 1 FROM work_sessions WHERE id=?');
  const update = db.prepare(
    'UPDATE meeting_handoffs SET payload_json=? WHERE source_session_id=? AND command_id=?',
  );
  const remove = db.prepare(
    'DELETE FROM meeting_handoffs WHERE source_session_id=? AND command_id=?',
  );
  for (const row of rows) {
    const other =
      row.source_session_id === sessionId ? row.target_session_id : row.source_session_id;
    if (other === sessionId || !remains.get(other)) {
      remove.run(row.source_session_id, row.command_id);
      continue;
    }
    const payload = readPayload(row.payload_json);
    if (row.source_session_id === sessionId) {
      payload.receipt.sourceDeleted = true;
      payload.receipt.sourceTitle = title;
    }
    if (row.target_session_id === sessionId) {
      payload.receipt.targetDeleted = true;
      payload.receipt.targetTitle = title;
    }
    update.run(JSON.stringify(payload), row.source_session_id, row.command_id);
  }
}

function suspendDeletes(db: Db) {
  for (const name of DELETE_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

function restoreDeletes(db: Db) {
  db.exec(`
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events rows are immutable'); END;
CREATE TRIGGER conversation_turns_no_delete BEFORE DELETE ON conversation_turns
BEGIN SELECT RAISE(ABORT, 'conversation_turns rows are immutable'); END;
CREATE TRIGGER model_attempt_events_no_delete BEFORE DELETE ON model_attempt_events
BEGIN SELECT RAISE(ABORT, 'model_attempt_events rows are immutable'); END;
`);
}

const byRun = (table: string) =>
  `DELETE FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?))`;

function removeRows(db: Db, sessionId: string, runIds: string[], title: string) {
  suspendDeletes(db);
  releaseHandoffs(db, sessionId, title);
  for (const table of [
    'run_events',
    'artifact_texts',
    'effect_intents',
    'generated_media',
    'image_generation_operations',
    'artifact_body_retention',
    'conversation_turns',
    'execution_views',
  ])
    deleteMatching(db, byRun(table), runIds);
  deleteMatching(db, byRun('commands'), runIds);
  deleteMatching(
    db,
    'DELETE FROM candidate_executions WHERE run_id IN (SELECT value FROM json_each(?))',
    runIds,
  );
  deleteMatching(db, byRun('candidate_promotions'), runIds);
  db.prepare('DELETE FROM candidate_worktrees WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM command_operations WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM message_branches WHERE session_id=?').run(sessionId);
  deleteMatching(
    db,
    'DELETE FROM message_branches WHERE source_run_id IN (SELECT value FROM json_each(?))',
    runIds,
  );
  db.prepare(
    `DELETE FROM integration_files WHERE integration_id IN
       (SELECT id FROM integrations WHERE session_id=?)`,
  ).run(sessionId);
  for (const table of [
    'integrations',
    'review_decisions',
    'review_comments',
    'feedback_batches',
    'verifications',
    'file_operations',
    'run_snapshots',
    'lsp_proposals',
    'file_checkpoints',
    'checkpoint_restores',
    'input_images',
    'file_edit_proposals',
    'workspace_access',
    'session_worktrees',
  ])
    db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
  db.prepare(
    `DELETE FROM workbench_operations WHERE json_extract(target_json, '$.sessionId')=?`,
  ).run(sessionId);
  const attempts = (
    db
      .prepare(
        `SELECT attempt_id AS id FROM model_attempts
         WHERE json_extract(record_json, '$.intent.owner.sessionId')=?
            OR json_extract(record_json, '$.intent.owner.runId') IN (SELECT value FROM json_each(?))`,
      )
      .all(sessionId, JSON.stringify(runIds)) as { id: string }[]
  ).map((row) => row.id);
  deleteMatching(
    db,
    'DELETE FROM model_attempt_events WHERE attempt_id IN (SELECT value FROM json_each(?))',
    attempts,
  );
  deleteMatching(
    db,
    'DELETE FROM model_attempts WHERE attempt_id IN (SELECT value FROM json_each(?))',
    attempts,
  );
  db.prepare('DELETE FROM session_search_v1 WHERE session_id=?').run(sessionId);
  deleteMatching(
    db,
    'DELETE FROM session_search_v1 WHERE run_id IN (SELECT value FROM json_each(?))',
    runIds,
  );
  db.prepare('DELETE FROM session_search_v1 WHERE id=? OR id=?').run(
    `metadata:${sessionId}`,
    `entries:${sessionId}`,
  );
  db.prepare('DELETE FROM session_search_state_v1 WHERE id=? OR id=?').run(
    `metadata:${sessionId}`,
    `entries:${sessionId}`,
  );
  if (runIds.length) {
    const encoded = JSON.stringify(runIds);
    db.prepare(
      `DELETE FROM session_search_state_v1 WHERE id IN (
         SELECT 'run:' || value FROM json_each(?)
         UNION SELECT 'conversation:' || value FROM json_each(?)
       )`,
    ).run(encoded, encoded);
  }
  const scheduleIds = schedulesTargeting(db, sessionId, true).map((item) => item.id);
  deleteMatching(
    db,
    'DELETE FROM scheduled_occurrences WHERE schedule_id IN (SELECT value FROM json_each(?))',
    scheduleIds,
  );
  deleteMatching(
    db,
    'DELETE FROM schedules WHERE id IN (SELECT value FROM json_each(?))',
    scheduleIds,
  );
  deleteMatching(db, 'DELETE FROM runs WHERE id IN (SELECT value FROM json_each(?))', runIds);
  db.prepare('DELETE FROM work_sessions WHERE id=?').run(sessionId);
  restoreDeletes(db);
}

export function deleteSessionRecords(
  db: Db,
  sessionId: string,
  expectedRevision: number,
  copiesRoot: string,
): SessionDeletionResult {
  const paths: string[] = [];
  const result = db.transaction((): SessionDeletionResult => {
    const row = db
      .prepare('SELECT id, revision, title FROM work_sessions WHERE id=?')
      .get(sessionId) as { id: string; revision: number; title: string } | undefined;
    if (!row) return { ok: false, error: 'not_found' };
    if (row.revision !== expectedRevision) return { ok: false, error: 'conflict' };
    const runs = runsOf(db, sessionId);
    const unfinished = runs.filter((run) => !terminal(run.status)).map((run) => run.id);
    if (unfinished.length) return { ok: false, error: 'unfinished', runIds: unfinished };
    paths.splice(0, paths.length, ...ownedPaths(db, sessionId));
    removeRows(
      db,
      sessionId,
      runs.map((run) => run.id),
      row.title,
    );
    return { ok: true };
  })();
  if (result.ok) for (const path of paths) removeOwnedPath(path, copiesRoot);
  return result;
}
