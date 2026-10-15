import { type Clock, CorralDefinition, CorralDefinitionDraft } from '@corral/contracts';
import {
  type CorralRecord,
  type CorralRepository,
  type CorralSummary,
  type DefinitionSource,
  parseCorralRecord,
  planDuplicate,
  planSave,
  type SaveRequest,
  type SaveResult,
} from '@corral/core';
import type { Db } from './database.ts';

// Saved Corrals in SQLite (C-009, C-011). Every definition revision is kept, so a run can
// start from the exact revision the user saw, and later edits never reach it (CRL-CAN-002).

export class SqliteCorralRepository implements CorralRepository, DefinitionSource {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly newCorralId: () => string;
  private readonly sql;

  constructor(db: Db, options: { clock: Clock; newCorralId: () => string }) {
    this.db = db;
    this.clock = options.clock;
    this.newCorralId = options.newCorralId;
    this.sql = {
      list: db.prepare(
        `SELECT c.id, c.name, c.definition_revision, c.layout_revision, c.updated_at,
           d.definition_json
         FROM corrals c JOIN definition_versions d
           ON d.corral_id = c.id AND d.revision = c.definition_revision
         ORDER BY c.updated_at DESC, c.name`,
      ),
      corral: db.prepare(
        `SELECT c.id, c.name, c.definition_revision, c.layout_revision, c.updated_at,
           d.definition_json, d.definition_hash, l.layout_json
         FROM corrals c
         JOIN definition_versions d ON d.corral_id = c.id AND d.revision = c.definition_revision
         JOIN layouts l ON l.corral_id = c.id AND l.layout_revision = c.layout_revision
         WHERE c.id = ?`,
      ),
      definition: db.prepare(
        'SELECT definition_json FROM definition_versions WHERE corral_id = ? AND revision = ?',
      ),
      upsertCorral: db.prepare(
        `INSERT INTO corrals (id, name, definition_revision, layout_revision, updated_at)
         VALUES (@id, @name, @definitionRevision, @layoutRevision, @updatedAt)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name,
           definition_revision = excluded.definition_revision,
           layout_revision = excluded.layout_revision, updated_at = excluded.updated_at`,
      ),
      insertDefinition: db.prepare(
        `INSERT INTO definition_versions (corral_id, revision, definition_hash, definition_json,
           created_at) VALUES (?, ?, ?, ?, ?)`,
      ),
      insertLayout: db.prepare(
        `INSERT INTO layouts (corral_id, layout_revision, definition_revision, layout_json)
         VALUES (?, ?, ?, ?)`,
      ),
      remove: db.prepare('DELETE FROM corrals WHERE id = ?'),
    };
  }

  async list(): Promise<CorralSummary[]> {
    const rows = this.sql.list.all() as {
      id: string;
      name: string;
      definition_revision: number;
      layout_revision: number;
      updated_at: string;
      definition_json: string;
    }[];
    return rows.map((row) => ({
      corralId: row.id,
      name: row.name,
      definitionRevision: row.definition_revision,
      layoutRevision: row.layout_revision,
      nodeCount: readJson<{ nodes?: unknown[] }>(row.definition_json, row.id).nodes?.length ?? 0,
      updatedAt: row.updated_at,
    }));
  }

  async get(corralId: string): Promise<CorralRecord | null> {
    return this.read(corralId);
  }

  async save(request: SaveRequest): Promise<SaveResult> {
    return this.db.transaction(() => {
      const current =
        request.expectedDefinitionRevision === null ? null : this.read(request.definition.id);
      return this.persist(planSave(current, request, this.context()), current);
    })();
  }

  async duplicate(corralId: string, name: string): Promise<SaveResult> {
    return this.db.transaction(() =>
      this.persist(planDuplicate(this.read(corralId), corralId, name, this.context()), null),
    )();
  }

  async remove(corralId: string): Promise<void> {
    this.sql.remove.run(corralId);
  }

  /** A saved revision as a runnable definition, or null if it is missing or unfinished. */
  getDefinition(corralId: string, definitionRevision: number): CorralDefinition | null {
    const row = this.sql.definition.get(corralId, definitionRevision) as
      | { definition_json: string }
      | undefined;
    if (!row) return null;
    const parsed = CorralDefinition.safeParse(readJson(row.definition_json, corralId));
    return parsed.success ? parsed.data : null;
  }

  private context() {
    return { now: this.clock.nowIso(), newCorralId: this.newCorralId };
  }

  private read(corralId: string): CorralRecord | null {
    const row = this.sql.corral.get(corralId) as
      | {
          id: string;
          name: string;
          definition_revision: number;
          layout_revision: number;
          updated_at: string;
          definition_json: string;
          definition_hash: string;
          layout_json: string;
        }
      | undefined;
    if (!row) return null;
    return parseCorralRecord(
      {
        corralId: row.id,
        name: row.name,
        definition: CorralDefinitionDraft.safeParse(readJson(row.definition_json, row.id)).data,
        definitionRevision: row.definition_revision,
        definitionHash: row.definition_hash,
        layout: readJson(row.layout_json, row.id),
        layoutRevision: row.layout_revision,
        updatedAt: row.updated_at,
      },
      row.id,
    );
  }

  private persist(result: SaveResult, current: CorralRecord | null): SaveResult {
    if (!result.ok || (!result.changed.definition && !result.changed.layout)) return result;
    const { record } = result;
    this.sql.upsertCorral.run({
      id: record.corralId,
      name: record.name,
      definitionRevision: record.definitionRevision,
      layoutRevision: record.layoutRevision,
      updatedAt: record.updatedAt,
    });
    if (!current || result.changed.definition) {
      this.sql.insertDefinition.run(
        record.corralId,
        record.definitionRevision,
        record.definitionHash,
        JSON.stringify(record.definition),
        record.updatedAt,
      );
    }
    if (!current || result.changed.layout) {
      this.sql.insertLayout.run(
        record.corralId,
        record.layoutRevision,
        record.definitionRevision,
        JSON.stringify(record.layout),
      );
    }
    return result;
  }
}

function readJson<T = unknown>(text: string, corralId: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Saved Corral ${corralId} cannot be read.`);
  }
}
