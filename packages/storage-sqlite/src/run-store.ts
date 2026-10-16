import type { RunEvent, RunStatus } from '@corral/contracts';
import {
  applyEvent,
  emptyProjection,
  type RunProjection,
  type RunStore,
  type RunSummary,
  type StoredCommand,
  type StoredRun,
} from '@corral/core';
import type { Db } from './database.ts';

/** RunStore over SQLite (C-011). Every method runs inside the caller's transaction. */
export class SqliteRunStore implements RunStore {
  private readonly db: Db;
  private readonly sql;

  constructor(db: Db) {
    this.db = db;
    this.sql = {
      insertRun: db.prepare(
        // The run joins its session's project (CR-011), else its saved Corral's project as it
        // is now (CR-010); inline definitions without a session go to the default project.
        `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
           projection_json, started_at, project_id, session_id)
         VALUES (@id, @corralId, @definitionHash, @snapshot, @status, @lastSeq, @projection,
           @startedAt,
           COALESCE((SELECT project_id FROM work_sessions WHERE id = @sessionId),
             (SELECT project_id FROM corrals WHERE id = @sourceCorralId), 'default'),
           @sessionId)`,
      ),
      saveProjection: db.prepare(
        'UPDATE runs SET projection_json = ?, status = ?, last_seq = ? WHERE id = ?',
      ),
      upsertEffect: db.prepare(
        `INSERT INTO effect_intents (effect_id, run_id, kind, scope, epoch, status, outcome)
         VALUES (@effectId, @runId, @kind, @scope, @epoch, @status, @outcome)
         ON CONFLICT (effect_id) DO UPDATE SET status = excluded.status,
           outcome = excluded.outcome
         WHERE effect_intents.run_id = excluded.run_id`,
      ),
      lastSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM run_events WHERE run_id = ?'),
      insertEvent: db.prepare(
        'INSERT INTO run_events (run_id, seq, event_id, type, event_json) VALUES (?, ?, ?, ?, ?)',
      ),
      insertCommand: db.prepare(
        `INSERT INTO commands (scope, command_id, run_id, payload_hash, receipt_json, directive_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      insertArtifact: db.prepare(
        'INSERT INTO artifact_texts (run_id, artifact_version_id, text_body) VALUES (?, ?, ?)',
      ),
      getRun: db.prepare('SELECT snapshot_json, projection_json FROM runs WHERE id = ?'),
      listRuns: db.prepare(
        `SELECT id, status, corral_id, started_at, project_id, session_id FROM runs
         ORDER BY started_at DESC, rowid DESC`,
      ),
      readEvents: db.prepare(
        'SELECT event_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      ),
      getCommand: db.prepare(
        `SELECT scope, command_id, run_id, payload_hash, receipt_json, directive_id
         FROM commands WHERE scope = ? AND command_id = ?`,
      ),
      getArtifact: db.prepare(
        'SELECT text_body FROM artifact_texts WHERE run_id = ? AND artifact_version_id = ?',
      ),
    };
  }

  transaction<T>(write: () => T): T {
    return this.db.transaction(write)();
  }

  insertRun(run: StoredRun) {
    this.sql.insertRun.run({
      id: run.runId,
      corralId: run.snapshot.definition.id,
      definitionHash: run.snapshot.definitionHash,
      snapshot: JSON.stringify(run.snapshot),
      status: run.projection.status,
      lastSeq: run.projection.lastSeq,
      projection: JSON.stringify(run.projection),
      startedAt: run.snapshot.startedAt,
      sourceCorralId: run.snapshot.source?.corralId ?? null,
      sessionId: run.sessionId ?? null,
    });
  }

  saveProjection(runId: string, projection: RunProjection) {
    const result = this.sql.saveProjection.run(
      JSON.stringify(projection),
      projection.status,
      projection.lastSeq,
      runId,
    );
    if (result.changes !== 1) throw new Error(`run ${runId} does not exist`);
    for (const effect of Object.values(projection.effects)) {
      this.sql.upsertEffect.run({ ...effect, runId });
    }
  }

  appendEvents(runId: string, events: readonly RunEvent[]) {
    let last = (this.sql.lastSeq.get(runId) as { last: number }).last;
    for (const event of events) {
      if (event.runId !== runId || event.runSeq !== last + 1) {
        throw new Error(`runSeq ${event.runSeq} is not next for ${runId}`);
      }
      this.sql.insertEvent.run(
        runId,
        event.runSeq,
        event.eventId,
        event.type,
        JSON.stringify(event),
      );
      last = event.runSeq;
    }
  }

  putCommand(command: StoredCommand) {
    this.sql.insertCommand.run(
      command.scope,
      command.commandId,
      command.runId,
      command.payloadHash,
      JSON.stringify(command.receipt),
      command.directiveId,
    );
  }

  putArtifactText(runId: string, artifactVersionId: string, text: string) {
    this.sql.insertArtifact.run(runId, artifactVersionId, text);
  }

  getRun(runId: string): StoredRun | null {
    const row = this.sql.getRun.get(runId) as
      | { snapshot_json: string; projection_json: string }
      | undefined;
    if (!row) return null;
    let projection = JSON.parse(row.projection_json) as RunProjection;
    const initial = emptyProjection(runId);
    // Cached projections from older phases are rebuilt; committed snapshots and events stay immutable.
    if (!projection || Object.keys(initial).some((key) => !Object.hasOwn(projection, key))) {
      projection = this.readEvents(runId, 0).reduce(applyEvent, initial);
    }
    return { runId, snapshot: JSON.parse(row.snapshot_json), projection };
  }

  listRuns(): RunSummary[] {
    const rows = this.sql.listRuns.all() as {
      id: string;
      status: RunStatus;
      corral_id: string;
      started_at: string;
      project_id: string | null;
      session_id: string | null;
    }[];
    return rows.map((row) => ({
      runId: row.id,
      status: row.status,
      corralId: row.corral_id,
      startedAt: row.started_at,
      projectId: row.project_id ?? 'default',
      sessionId: row.session_id,
    }));
  }

  readEvents(runId: string, afterSeq: number, limit = -1): RunEvent[] {
    const rows = this.sql.readEvents.all(runId, afterSeq, limit) as { event_json: string }[];
    return rows.map((row) => JSON.parse(row.event_json) as RunEvent);
  }

  getCommand(scope: string, commandId: string): StoredCommand | null {
    const row = this.sql.getCommand.get(scope, commandId) as
      | {
          scope: string;
          command_id: string;
          run_id: string | null;
          payload_hash: string;
          receipt_json: string;
          directive_id: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      scope: row.scope,
      commandId: row.command_id,
      runId: row.run_id,
      payloadHash: row.payload_hash,
      receipt: JSON.parse(row.receipt_json),
      directiveId: row.directive_id,
    };
  }

  getArtifactText(runId: string, artifactVersionId: string): string | null {
    const row = this.sql.getArtifact.get(runId, artifactVersionId) as
      | { text_body: string }
      | undefined;
    return row?.text_body ?? null;
  }
}
