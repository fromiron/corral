import { canonicalJson, ModelAttempt, type ModelAttemptStore } from '@corral/contracts';
import type { Db } from './database.ts';

/** Independent operation owners let pre-Run and media requests share the durable ledger. */
export class SqliteModelAttemptStore implements ModelAttemptStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  recoverInterrupted(endedAt: string) {
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT record_json FROM model_attempts WHERE json_extract(record_json, '$.status')='started'",
        )
        .all() as { record_json: string }[];
      for (const row of rows)
        this.put({
          ...ModelAttempt.parse(JSON.parse(row.record_json)),
          status: 'unknown',
          endedAt,
          failure: {
            code: 'PROCESS_INTERRUPTED',
            status: null,
            retryAfterMs: null,
            requestId: null,
          },
        });
    })();
  }
  put(raw: ModelAttempt) {
    const next = ModelAttempt.parse(raw);
    this.db.transaction(() => {
      const previous = this.get(next.attemptId);
      if (
        previous &&
        (canonicalJson(previous.intent) !== canonicalJson(next.intent) ||
          previous.provider !== next.provider ||
          previous.modelId !== next.modelId ||
          previous.startedAt !== next.startedAt)
      )
        throw new Error('model attempt identity changed');
      if (previous?.status !== 'started' && next.status === 'started' && previous)
        throw new Error('model attempt cannot restart');
      const text = canonicalJson(next);
      if (previous && canonicalJson(previous) === text) return;
      this.db
        .prepare(
          'INSERT INTO model_attempts(attempt_id, owner_id, record_json) VALUES (?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET record_json=excluded.record_json',
        )
        .run(next.attemptId, next.intent.owner.id, text);
      this.db
        .prepare('INSERT INTO model_attempt_events(attempt_id, record_json) VALUES (?, ?)')
        .run(next.attemptId, text);
    })();
  }
  get(id: string): ModelAttempt | null {
    const row = this.db
      .prepare('SELECT record_json FROM model_attempts WHERE attempt_id=?')
      .get(id) as { record_json: string } | undefined;
    return row ? ModelAttempt.parse(JSON.parse(row.record_json)) : null;
  }
  list(ownerId?: string): ModelAttempt[] {
    const rows =
      ownerId === undefined
        ? this.db.prepare('SELECT record_json FROM model_attempts ORDER BY rowid').all()
        : this.db
            .prepare('SELECT record_json FROM model_attempts WHERE owner_id=? ORDER BY rowid')
            .all(ownerId);
    return (rows as { record_json: string }[]).map((row) =>
      ModelAttempt.parse(JSON.parse(row.record_json)),
    );
  }
  page(
    query: {
      ownerId?: string;
      runId?: string;
      sessionId?: string;
      before?: number;
      limit?: number;
    } = {},
  ): import('@corral/contracts').ModelAttemptPage {
    const where: string[] = [],
      values: (string | number)[] = [];
    for (const [key, expression] of [
      ['ownerId', 'owner_id'],
      ['runId', "json_extract(record_json, '$.intent.owner.runId')"],
      ['sessionId', "json_extract(record_json, '$.intent.owner.sessionId')"],
    ] as const)
      if (query[key]) {
        where.push(`${expression}=?`);
        values.push(query[key]);
      }
    if (query.before !== undefined) {
      where.push('rowid<?');
      values.push(query.before);
    }
    const limit = query.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT rowid,record_json FROM model_attempts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...values, limit + 1) as { rowid: number; record_json: string }[];
    return {
      items: rows.slice(0, limit).map((row) => ModelAttempt.parse(JSON.parse(row.record_json))),
      nextCursor: rows.length > limit ? rows[limit - 1]!.rowid : null,
    };
  }
}
