import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunStatus } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { FakeClock, linearCorral } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, SqliteCorralRepository, SqliteRunStore } from '../src/index.ts';
import { deleteSessionRecords, previewSessionDeletion } from '../src/session-deletion.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tree = 'a'.repeat(40);
const now = '2026-11-12T00:00:00.000Z';

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-session-delete-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'corral.db'));
  const repository = new SqliteCorralRepository(db, {
    clock: new FakeClock(),
    newCorralId: () => 'corral_new',
  });
  return { dir, db, repository, runs: new SqliteRunStore(db) };
}

async function session(
  db: ReturnType<typeof database>['db'],
  repository: SqliteCorralRepository,
  title: string,
  entries = '[]',
) {
  const created = await repository.createSession({ projectId: 'default', title, objective: title });
  if (!created.ok) throw new Error(created.message);
  db.prepare('UPDATE work_sessions SET entries_json=? WHERE id=?').run(
    entries,
    created.session.sessionId,
  );
  return created.session;
}

function addRun(store: SqliteRunStore, id: string, sessionId: string | null, status: RunStatus) {
  const projection = emptyProjection(id);
  projection.status = status;
  store.insertRun({
    runId: id,
    sessionId,
    projection,
    snapshot: {
      definition: linearCorral(['writer']),
      definitionHash: 'b'.repeat(64),
      criteriaVersionId: 'crit_1',
      source: null,
      mode: 'mock',
      models: {},
      startedAt: now,
    },
  });
}

/** One row in every session-owned table, plus a team and a run with no session. */
async function seed() {
  const opened = database();
  const { db, repository, runs, dir } = opened;
  const alpha = await session(db, repository, 'Alpha', '[{"text":"hello"}]');
  const beta = await session(db, repository, 'Beta', '[{"text":"stay"}]');
  db.prepare(
    `INSERT INTO corrals (id, name, definition_revision, updated_at, project_id)
     VALUES ('corral_keep', 'Keep', 1, ?, 'default')`,
  ).run(now);
  db.prepare(
    `INSERT INTO workspace_bindings
       (id, project_id, root_path, is_git, trusted, verify_json, created_at, updated_at)
     VALUES ('bind_1', 'default', '/tmp/keep-repo', 1, 1, '[]', ?, ?)`,
  ).run(now, now);
  addRun(runs, 'run_alpha', alpha.sessionId, 'succeeded');
  addRun(runs, 'run_beta', beta.sessionId, 'succeeded');
  addRun(runs, 'run_loose', null, 'succeeded');
  const media = {
    alpha: join(dir, 'alpha-media.png'),
    beta: join(dir, 'beta-media.png'),
  };
  writeFileSync(media.alpha, 'alpha-bytes');
  writeFileSync(media.beta, 'beta-bytes');
  for (const [sessionId, runId, path] of [
    [alpha.sessionId, 'run_alpha', media.alpha],
    [beta.sessionId, 'run_beta', media.beta],
  ] as const) {
    const mark = sessionId === alpha.sessionId ? 'a' : 'b';
    db.prepare(
      `INSERT INTO run_events (run_id, seq, event_id, type, event_json)
       VALUES (?, 1, ?, 'note', '{}')`,
    ).run(runId, `event_${mark}`);
    db.prepare('INSERT INTO artifact_texts VALUES (?, ?, ?)').run(runId, `art_${mark}`, 'body');
    db.prepare('INSERT INTO effect_intents VALUES (?, ?, ?, ?, 1, ?, NULL)').run(
      `effect_${mark}`,
      runId,
      'tool',
      'run',
      'settled',
    );
    db.prepare('INSERT INTO generated_media VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      runId,
      `media_${mark}`,
      `effect_media_${mark}`,
      '{}',
      '{}',
      Buffer.from(mark),
      now,
    );
    db.prepare(
      `INSERT INTO image_generation_operations VALUES (?, ?, ?, 'profile', 'completed', NULL)`,
    ).run(runId, `effect_media_${mark}`, `hash_${mark}`);
    db.prepare('INSERT INTO conversation_turns VALUES (?, ?)').run(runId, '{"answer":"x"}');
    db.prepare('INSERT INTO artifact_body_retention VALUES (?, ?)').run(runId, '[]');
    db.prepare(
      `INSERT INTO commands
         (scope, command_id, run_id, payload_hash, receipt_json, directive_id, original_request_hash)
       VALUES ('run', ?, ?, 'hash', '{}', NULL, NULL)`,
    ).run(`cmd_${mark}`, runId);
    db.prepare('INSERT INTO run_snapshots VALUES (?, ?, ?, ?, ?)').run(
      runId,
      'start',
      sessionId,
      tree,
      now,
    );
    db.prepare(
      `INSERT INTO file_operations
         (id, session_id, run_id, execution_id, tool_call_id, kind, path, to_path,
          before_hash, after_hash, state, detail, created_at, updated_at)
       VALUES (?, ?, ?, 'exec', 'tool', 'write', 'a.txt', NULL, NULL, NULL, 'applied', NULL, ?, ?)`,
    ).run(`file_${mark}`, sessionId, runId, now, now);
    db.prepare(
      `INSERT INTO verifications
         (id, session_id, command_id, command_json, tree, exit_code, signal, timed_out,
          duration_ms, output_tail, state, started_at, ended_at, report_json)
       VALUES (?, ?, 'check', '{}', ?, 0, NULL, 0, 1, '', 'passed', ?, ?, NULL)`,
    ).run(`verify_${mark}`, sessionId, tree, now, now);
    db.prepare(
      `INSERT INTO review_comments
         (id, session_id, from_tree, to_tree, path, side, start_line, end_line, quote, body,
          state, batch_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'a.txt', 'after', 1, 1, 'q', 'note', 'draft', NULL, ?, ?)`,
    ).run(`comment_${mark}`, sessionId, tree, tree, now, now);
    db.prepare(
      `INSERT INTO feedback_batches
         (id, session_id, intent, run_id, execution_id, text, state, detail, created_at)
       VALUES (?, ?, 'next', ?, NULL, 'text', 'sent', NULL, ?)`,
    ).run(`batch_${mark}`, sessionId, runId, now);
    db.prepare(
      `INSERT INTO review_decisions
         (id, session_id, from_tree, to_tree, decision, note, created_at)
       VALUES (?, ?, ?, ?, 'approved', '', ?)`,
    ).run(`decision_${mark}`, sessionId, tree, tree, now);
    db.prepare(
      `INSERT INTO integrations
         (id, session_id, decision_id, from_tree, to_tree, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'applied', ?, ?)`,
    ).run(`integ_${mark}`, sessionId, `decision_${mark}`, tree, tree, now, now);
    db.prepare(
      `INSERT INTO integration_files
         (integration_id, path, action, expected_hash, after_hash, outcome, detail)
       VALUES (?, 'a.txt', 'write', NULL, NULL, 'applied', NULL)`,
    ).run(`integ_${mark}`);
    db.prepare(
      `INSERT INTO session_worktrees
         (session_id, binding_id, worktree_path, base_commit, base_tree, reviewed_tree,
          created_at, removed_at, copy_generation)
       VALUES (?, 'bind_1', ?, ?, ?, NULL, ?, NULL, 1)`,
    ).run(sessionId, join(dir, `copy-${mark}`), tree, tree, now);
    db.prepare(
      `INSERT INTO lsp_proposals
         (id, session_id, content_json, summary_json, content_hash, state, outcomes_json,
          created_at, updated_at)
       VALUES (?, ?, '{}', '{}', 'hash', 'pending', '[]', ?, ?)`,
    ).run(`lsp_${mark}`, sessionId, now, now);
    db.prepare(
      `INSERT INTO file_checkpoints
         (id, session_id, run_id, kind, manifest_json, manifest_hash, state, pinned, created_at)
       VALUES (?, ?, ?, 'manual', '{}', NULL, 'ready', 0, ?)`,
    ).run(`checkpoint_${mark}`, sessionId, runId, now);
    db.prepare('INSERT INTO checkpoint_restores VALUES (?, ?, ?, ?)').run(
      `restore_${mark}`,
      sessionId,
      'hash',
      '{}',
    );
    db.prepare('INSERT INTO input_images VALUES (?, ?, ?, ?, ?)').run(
      sessionId,
      `image_${mark}`,
      '{}',
      Buffer.from(mark),
      now,
    );
    db.prepare('INSERT INTO message_branches VALUES (?, ?, ?, ?, ?, ?)').run(
      `branch_${mark}`,
      'hash',
      runId,
      `art_${mark}`,
      sessionId,
      now,
    );
    db.prepare(
      `INSERT INTO file_edit_proposals
         (id, session_id, request_id, request_hash, content_json, content_hash, dismissed,
          operation_id, created_at)
       VALUES (?, ?, 'req', 'hash', '{}', 'hash', 0, NULL, ?)`,
    ).run(`edit_${mark}`, sessionId, now);
    db.prepare(
      `INSERT INTO command_operations
         (id, session_id, run_id, request_hash, owner_json, plan_json, state, report_json,
          before_tree, after_tree, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', '{}', '{}', 'completed', NULL, ?, NULL, ?, ?)`,
    ).run(`op_${mark}`, sessionId, runId, tree, now, now);
    db.prepare(
      `INSERT INTO workspace_access
         (owner_kind, owner_id, session_id, worktree_key, copy_generation, writer, state, tree)
       VALUES ('run', ?, ?, ?, 1, 0, 'released', NULL)`,
    ).run(runId, sessionId, `key-${mark}`);
    db.prepare(
      `INSERT INTO candidate_worktrees
         (run_id, candidate_id, session_id, binding_id, copy_generation, worktree_path,
          baseline_tree, state, created_at)
       VALUES (?, 'cand', ?, 'bind_1', 1, ?, ?, 'ready', ?)`,
    ).run(runId, sessionId, path, tree, now);
    db.prepare('INSERT INTO candidate_executions VALUES (?, ?, ?)').run(runId, 'exec', 'cand');
    db.prepare('INSERT INTO candidate_promotions VALUES (?, ?, ?, ?)').run(
      runId,
      'hash',
      `cmd_${mark}`,
      `checkpoint_${mark}`,
    );
    db.prepare(
      `INSERT INTO workbench_operations
         (operation_id, request_hash, target_json, kind, state, result_json, created_at, updated_at)
       VALUES (?, 'hash', ?, 'document', 'succeeded', NULL, ?, ?)`,
    ).run(`wb_${mark}`, JSON.stringify({ sessionId }), now, now);
    db.prepare('INSERT INTO model_attempts VALUES (?, ?, ?)').run(
      `attempt_${mark}`,
      'owner',
      JSON.stringify({ intent: { owner: { sessionId, runId } } }),
    );
    db.prepare('INSERT INTO model_attempt_events VALUES (?, ?, ?)').run(
      mark === 'a' ? 1 : 2,
      `attempt_${mark}`,
      '{}',
    );
    db.prepare(
      `INSERT INTO session_search_v1
         (id, session_id, run_id, entry_id, artifact_id, sequence, kind, normalized, source_text, source_hash)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'session', 'text', 'text', 'hash')`,
    ).run(`metadata:${sessionId}`, sessionId, null);
    db.prepare('INSERT INTO session_search_state_v1 VALUES (?, ?)').run(
      `metadata:${sessionId}`,
      '1',
    );
    db.prepare('INSERT INTO session_search_state_v1 VALUES (?, ?)').run(`run:${runId}`, '1');
    db.prepare('INSERT INTO schedules VALUES (?, 1, ?)').run(
      `sched_${mark}`,
      JSON.stringify({
        id: `sched_${mark}`,
        title: `Schedule ${mark}`,
        sessionId,
        deletedAt: null,
      }),
    );
    db.prepare(
      `INSERT INTO scheduled_occurrences
         (id, schedule_id, revision, occurrence_key, schedule_json, occurrence_json)
       VALUES (?, ?, 1, 'once', '{}', '{}')`,
    ).run(`occ_${mark}`, `sched_${mark}`);
  }
  db.prepare('INSERT INTO schedules VALUES (?, 1, ?)').run(
    'sched_alpha_gone',
    JSON.stringify({
      id: 'sched_alpha_gone',
      title: 'Already removed',
      sessionId: alpha.sessionId,
      deletedAt: now,
    }),
  );
  db.prepare('INSERT INTO image_generation_profiles VALUES (?, ?)').run('img', '{}');
  db.prepare(
    `INSERT INTO meeting_handoffs
       (source_session_id, command_id, target_session_id, request_hash, payload_json)
     VALUES (?, 'handoff_1', ?, 'hash', ?)`,
  ).run(
    alpha.sessionId,
    beta.sessionId,
    JSON.stringify({
      receipt: {
        commandId: 'handoff_1',
        sourceSessionId: alpha.sessionId,
        targetSessionId: beta.sessionId,
      },
    }),
  );
  return { ...opened, alpha, beta, media };
}

const count = (db: ReturnType<typeof database>['db'], sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

it('removes one session’s rows and leaves the other session, its runs and the team', async () => {
  const { db, dir, alpha, beta } = await seed();
  const before = count(db, 'SELECT COUNT(*) AS n FROM runs WHERE session_id=?', beta.sessionId);
  const removed = deleteSessionRecords(db, alpha.sessionId, 1, dir);
  expect(removed).toEqual({ ok: true });
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', alpha.sessionId)).toBe(0);
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', beta.sessionId)).toBe(1);
  expect(count(db, 'SELECT COUNT(*) AS n FROM runs WHERE session_id=?', beta.sessionId)).toBe(
    before,
  );
  expect(count(db, 'SELECT COUNT(*) AS n FROM runs WHERE id=?', 'run_loose')).toBe(1);
  expect(count(db, 'SELECT COUNT(*) AS n FROM runs WHERE session_id=?', alpha.sessionId)).toBe(0);
  for (const [table, column] of [
    ['run_events', 'run_id'],
    ['artifact_texts', 'run_id'],
    ['effect_intents', 'run_id'],
    ['generated_media', 'run_id'],
    ['conversation_turns', 'run_id'],
    ['commands', 'run_id'],
  ] as const) {
    expect(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`, 'run_alpha')).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`, 'run_beta')).toBe(1);
  }
  for (const table of [
    'run_snapshots',
    'file_operations',
    'verifications',
    'review_comments',
    'feedback_batches',
    'review_decisions',
    'integrations',
    'session_worktrees',
    'lsp_proposals',
    'file_checkpoints',
    'checkpoint_restores',
    'input_images',
    'message_branches',
    'file_edit_proposals',
    'command_operations',
    'workspace_access',
    'candidate_worktrees',
  ]) {
    expect(
      count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE session_id=?`, alpha.sessionId),
      table,
    ).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE session_id=?`, beta.sessionId)).toBe(
      1,
    );
  }
  expect(
    count(db, 'SELECT COUNT(*) AS n FROM integration_files WHERE integration_id=?', 'integ_a'),
  ).toBe(0);
  expect(
    count(db, 'SELECT COUNT(*) AS n FROM integration_files WHERE integration_id=?', 'integ_b'),
  ).toBe(1);
  expect(count(db, 'SELECT COUNT(*) AS n FROM schedules WHERE id LIKE ?', 'sched_a%')).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM schedules WHERE id='sched_b'")).toBe(1);
  expect(
    count(db, "SELECT COUNT(*) AS n FROM scheduled_occurrences WHERE schedule_id='sched_b'"),
  ).toBe(1);
  expect(
    count(db, 'SELECT COUNT(*) AS n FROM session_search_v1 WHERE session_id=?', alpha.sessionId),
  ).toBe(0);
  expect(
    count(db, 'SELECT COUNT(*) AS n FROM session_search_v1 WHERE session_id=?', beta.sessionId),
  ).toBe(1);
  expect(
    count(db, "SELECT COUNT(*) AS n FROM session_search_state_v1 WHERE id='run:run_beta'"),
  ).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM corrals WHERE id='corral_keep'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM projects WHERE id='default'")).toBe(1);
  expect(count(db, 'SELECT COUNT(*) AS n FROM image_generation_profiles')).toBe(1);
  expect(() => db.prepare('DELETE FROM run_events WHERE run_id=?').run('run_beta')).toThrow(
    /immutable/,
  );
  expect(() => db.prepare('DELETE FROM conversation_turns WHERE run_id=?').run('run_beta')).toThrow(
    /immutable/,
  );
  db.close();
});

it('refuses while a run is unfinished and does not remove the other session', async () => {
  const { db, dir, repository, runs } = database();
  const alpha = await session(db, repository, 'Alpha');
  const beta = await session(db, repository, 'Beta');
  addRun(runs, 'run_open', alpha.sessionId, 'running');
  addRun(runs, 'run_beta', beta.sessionId, 'succeeded');
  const refused = deleteSessionRecords(db, alpha.sessionId, 1, dir);
  expect(refused).toMatchObject({ ok: false, error: 'unfinished', runIds: ['run_open'] });
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', alpha.sessionId)).toBe(1);
  expect(count(db, 'SELECT COUNT(*) AS n FROM runs WHERE id=?', 'run_beta')).toBe(1);
  db.prepare("UPDATE runs SET status='succeeded' WHERE id='run_open'").run();
  expect(deleteSessionRecords(db, alpha.sessionId, 1, dir)).toEqual({ ok: true });
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', beta.sessionId)).toBe(1);
  db.close();
});

it('a stale revision is a conflict and a repeated delete is not found', async () => {
  const { db, dir, repository } = database();
  const alpha = await session(db, repository, 'Alpha');
  expect(deleteSessionRecords(db, alpha.sessionId, 2, dir)).toEqual({
    ok: false,
    error: 'conflict',
  });
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', alpha.sessionId)).toBe(1);
  expect(deleteSessionRecords(db, alpha.sessionId, 1, dir)).toEqual({ ok: true });
  expect(deleteSessionRecords(db, alpha.sessionId, 1, dir)).toEqual({
    ok: false,
    error: 'not_found',
  });
  db.close();
});

it('deletes the session another session branched from and keeps the branch', async () => {
  const { db, dir, repository, runs } = database();
  const source = await session(db, repository, 'Source');
  const branch = await session(db, repository, 'Branch');
  addRun(runs, 'run_source', source.sessionId, 'succeeded');
  addRun(runs, 'run_branch', branch.sessionId, 'succeeded');
  db.prepare('INSERT INTO message_branches VALUES (?, ?, ?, ?, ?, ?)').run(
    'branch_cmd',
    'hash',
    'run_source',
    'art',
    branch.sessionId,
    now,
  );
  expect(deleteSessionRecords(db, source.sessionId, 1, dir)).toEqual({ ok: true });
  expect(count(db, 'SELECT COUNT(*) AS n FROM runs WHERE id=?', 'run_source')).toBe(0);
  expect(count(db, 'SELECT COUNT(*) AS n FROM message_branches')).toBe(0);
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', branch.sessionId)).toBe(1);
  expect(count(db, 'SELECT COUNT(*) AS n FROM runs WHERE id=?', 'run_branch')).toBe(1);
  db.close();
});

it('keeps a meeting handoff for the session that remains and names the deleted side', async () => {
  const { db, dir, alpha, beta } = await seed();
  expect(deleteSessionRecords(db, alpha.sessionId, 1, dir)).toEqual({ ok: true });
  const row = db
    .prepare('SELECT payload_json FROM meeting_handoffs WHERE command_id=?')
    .get('handoff_1') as { payload_json: string };
  const payload = JSON.parse(row.payload_json) as {
    receipt: { sourceDeleted?: boolean; sourceTitle?: string; targetSessionId: string };
  };
  expect(payload.receipt.sourceDeleted).toBe(true);
  expect(payload.receipt.sourceTitle).toBe('Alpha');
  expect(payload.receipt.targetSessionId).toBe(beta.sessionId);
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', beta.sessionId)).toBe(1);
  expect(deleteSessionRecords(db, beta.sessionId, 1, dir)).toEqual({ ok: true });
  expect(count(db, 'SELECT COUNT(*) AS n FROM meeting_handoffs')).toBe(0);
  db.close();
});

it('removes that session’s generated media bytes and its file in a temp directory', async () => {
  const { db, dir, alpha, media } = await seed();
  const preview = previewSessionDeletion(db, alpha.sessionId);
  expect(preview).toMatchObject({
    runs: 1,
    messages: 1,
    generatedMedia: 1,
    unfinishedRunIds: [],
    schedules: [{ id: 'sched_a', title: 'Schedule a' }],
  });
  expect(preview?.schedules.map((item) => item.id)).not.toContain('sched_alpha_gone');
  expect(deleteSessionRecords(db, alpha.sessionId, 1, dir)).toEqual({ ok: true });
  expect(existsSync(media.alpha)).toBe(false);
  expect(existsSync(media.beta)).toBe(true);
  expect(count(db, 'SELECT COUNT(*) AS n FROM generated_media WHERE run_id=?', 'run_alpha')).toBe(
    0,
  );
  expect(count(db, 'SELECT COUNT(*) AS n FROM generated_media WHERE run_id=?', 'run_beta')).toBe(1);
  db.close();
});

it('leaves a recorded copy path outside the copies folder on disk', async () => {
  const { db, dir, alpha, media } = await seed();
  const copies = join(dir, 'copies');
  expect(deleteSessionRecords(db, alpha.sessionId, 1, copies)).toEqual({ ok: true });
  expect(existsSync(media.alpha)).toBe(true);
  expect(count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE id=?', alpha.sessionId)).toBe(0);
  db.close();
});
