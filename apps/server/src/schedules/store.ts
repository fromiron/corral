import { createHash } from 'node:crypto';
import type { Schedule, ScheduledOccurrence } from '@corral/contracts';
import type { Db } from '@corral/storage-sqlite';

export class ScheduleStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  atomic<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  importOperation(id: string): { hash: string; revision: string } | null {
    return (
      (this.db
        .prepare(
          'SELECT payload_hash AS hash, revision FROM schedule_import_operations WHERE operation_id=?',
        )
        .get(id) as { hash: string; revision: string } | undefined) ?? null
    );
  }
  saveImportOperation(id: string, hash: string, revision: string) {
    this.db
      .prepare('INSERT INTO schedule_import_operations VALUES (?, ?, ?)')
      .run(id, hash, revision);
  }
  list(): Schedule[] {
    return (
      this.db.prepare('SELECT schedule_json FROM schedules').all() as { schedule_json: string }[]
    ).map((row) => JSON.parse(row.schedule_json) as Schedule);
  }
  get(id: string): Schedule | null {
    const row = this.db.prepare('SELECT schedule_json FROM schedules WHERE id=?').get(id) as
      | { schedule_json: string }
      | undefined;
    return row ? (JSON.parse(row.schedule_json) as Schedule) : null;
  }
  insert(schedule: Schedule) {
    this.db
      .prepare('INSERT INTO schedules VALUES (?, ?, ?)')
      .run(schedule.id, schedule.revision, JSON.stringify(schedule));
  }
  replace(schedule: Schedule, expectedRevision: number): boolean {
    return (
      this.db
        .prepare('UPDATE schedules SET revision=?, schedule_json=? WHERE id=? AND revision=?')
        .run(schedule.revision, JSON.stringify(schedule), schedule.id, expectedRevision).changes ===
      1
    );
  }
  occurrences(scheduleId?: string): ScheduledOccurrence[] {
    const rows = scheduleId
      ? this.db
          .prepare(
            'SELECT occurrence_json FROM scheduled_occurrences WHERE schedule_id=? ORDER BY rowid DESC',
          )
          .all(scheduleId)
      : this.db
          .prepare('SELECT occurrence_json FROM scheduled_occurrences ORDER BY rowid DESC')
          .all();
    return (rows as { occurrence_json: string }[]).map((row) => JSON.parse(row.occurrence_json));
  }
  save(occurrence: ScheduledOccurrence) {
    this.db
      .prepare('UPDATE scheduled_occurrences SET occurrence_json=? WHERE id=?')
      .run(JSON.stringify(occurrence), occurrence.id);
  }
  snapshot(id: string): Schedule {
    const row = this.db
      .prepare('SELECT schedule_json FROM scheduled_occurrences WHERE id=?')
      .get(id) as { schedule_json: string };
    return JSON.parse(row.schedule_json);
  }
  claim(
    schedule: Schedule,
    dueAt: string,
    now: string,
    manualId?: string,
  ): ScheduledOccurrence | null {
    return this.db
      .transaction(() => {
        const current = this.get(schedule.id);
        if (
          !current ||
          current.deletedAt ||
          current.revision !== schedule.revision ||
          (!manualId && !current.enabled)
        )
          return null;
        const key = manualId ? `manual:${manualId}` : dueAt;
        const digest = createHash('sha256')
          .update(`${schedule.id}:${schedule.revision}:${key}`)
          .digest('hex');
        const existing = this.db
          .prepare('SELECT occurrence_json FROM scheduled_occurrences WHERE id=?')
          .get(`occ_${digest}`) as { occurrence_json: string } | undefined;
        if (existing) return null;
        const occurrence: ScheduledOccurrence = {
          id: `occ_${digest}`,
          scheduleId: schedule.id,
          revision: schedule.revision,
          dueAt,
          commandId: `scheduled_${digest}`,
          manual: !!manualId,
          status: 'dispatching',
          runId: null,
          detail: null,
          createdAt: now,
        };
        this.db
          .prepare('INSERT INTO scheduled_occurrences VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            occurrence.id,
            schedule.id,
            schedule.revision,
            key,
            JSON.stringify(schedule),
            JSON.stringify(occurrence),
          );
        return occurrence;
      })
      .immediate();
  }
}
