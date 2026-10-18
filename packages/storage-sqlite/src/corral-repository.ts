import { type Clock, CorralDefinition, CorralDefinitionDraft } from '@corral/contracts';
import {
  type CorralRecord,
  type CorralRepository,
  type CorralSummary,
  DEFAULT_PROJECT_ID,
  type DefinitionSource,
  type NewSessionEntry,
  type ProjectChange,
  type ProjectResult,
  type ProjectSummary,
  parseCorralRecord,
  planDuplicate,
  planMove,
  planProjectCreate,
  planProjectUpdate,
  planSave,
  planSessionCreate,
  planSessionEntry,
  planSessionEntryUpdate,
  planSessionUpdate,
  projectRefusal,
  type SaveRequest,
  type SaveResult,
  type SessionChange,
  type SessionEntryState,
  type SessionResult,
  sortProjects,
  sortSessions,
  type WorkSession,
} from '@corral/core';
import type { Db } from './database.ts';

// Saved Corrals in SQLite (C-009, C-011). Every definition revision is kept, so a run can
// start from the exact revision the user saw, and later edits never reach it (CRL-CAN-002).

export class SqliteCorralRepository implements CorralRepository, DefinitionSource {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly newCorralId: () => string;
  private readonly newProjectId: () => string;
  private readonly sql;

  constructor(
    db: Db,
    options: { clock: Clock; newCorralId: () => string; newProjectId?: () => string },
  ) {
    this.db = db;
    this.clock = options.clock;
    this.newCorralId = options.newCorralId;
    this.newProjectId =
      options.newProjectId ?? (() => `project_${globalThis.crypto.randomUUID().slice(0, 8)}`);
    this.sql = {
      list: db.prepare(
        `SELECT c.id, c.name, c.definition_revision, c.layout_revision, c.updated_at,
           c.project_id, d.definition_json
         FROM corrals c JOIN definition_versions d
           ON d.corral_id = c.id AND d.revision = c.definition_revision
         ORDER BY c.updated_at DESC, c.name`,
      ),
      corral: db.prepare(
        `SELECT c.id, c.name, c.definition_revision, c.layout_revision, c.updated_at,
           c.project_id, d.definition_json, d.definition_hash, l.layout_json
         FROM corrals c
         JOIN definition_versions d ON d.corral_id = c.id AND d.revision = c.definition_revision
         JOIN layouts l ON l.corral_id = c.id AND l.layout_revision = c.layout_revision
         WHERE c.id = ?`,
      ),
      definition: db.prepare(
        'SELECT definition_json FROM definition_versions WHERE corral_id = ? AND revision = ?',
      ),
      upsertCorral: db.prepare(
        `INSERT INTO corrals (id, name, definition_revision, layout_revision, updated_at,
           project_id)
         VALUES (@id, @name, @definitionRevision, @layoutRevision, @updatedAt, @projectId)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name,
           definition_revision = excluded.definition_revision,
           layout_revision = excluded.layout_revision, updated_at = excluded.updated_at,
           project_id = excluded.project_id`,
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
      projects: db.prepare(
        `SELECT id, name, description, revision, created_at, updated_at, archived_at
         FROM projects`,
      ),
      project: db.prepare(
        `SELECT id, name, description, revision, created_at, updated_at, archived_at
         FROM projects WHERE id = ?`,
      ),
      upsertProject: db.prepare(
        `INSERT INTO projects (id, name, description, revision, created_at, updated_at,
           archived_at)
         VALUES (@projectId, @name, @description, @revision, @createdAt, @updatedAt, @archivedAt)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name,
           description = excluded.description, revision = excluded.revision,
           updated_at = excluded.updated_at, archived_at = excluded.archived_at`,
      ),
      moveCorral: db.prepare('UPDATE corrals SET project_id = ?, updated_at = ? WHERE id = ?'),
      sessions: db.prepare(
        `SELECT id, project_id, corral_id, title, objective, pinned, revision, created_at,
           updated_at, archived_at, entries_json, auto_json FROM work_sessions WHERE project_id = ?`,
      ),
      session: db.prepare(
        `SELECT id, project_id, corral_id, title, objective, pinned, revision, created_at,
           updated_at, archived_at, entries_json, auto_json FROM work_sessions WHERE id = ?`,
      ),
      upsertSession: db.prepare(
        `INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision,
           created_at, updated_at, archived_at, entries_json, auto_json)
         VALUES (@sessionId, @projectId, @corralId, @title, @objective, @pinned, @revision,
           @createdAt, @updatedAt, @archivedAt, @entries, @auto)
         ON CONFLICT (id) DO UPDATE SET corral_id = excluded.corral_id, title = excluded.title,
           auto_json = excluded.auto_json,
           objective = excluded.objective, pinned = excluded.pinned,
           revision = excluded.revision, updated_at = excluded.updated_at,
           archived_at = excluded.archived_at, entries_json = excluded.entries_json`,
      ),
    };
  }

  async list(): Promise<CorralSummary[]> {
    const rows = this.sql.list.all() as {
      id: string;
      name: string;
      definition_revision: number;
      layout_revision: number;
      updated_at: string;
      project_id: string | null;
      definition_json: string;
    }[];
    return rows.map((row) => ({
      corralId: row.id,
      projectId: row.project_id ?? DEFAULT_PROJECT_ID,
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
      if (request.expectedDefinitionRevision === null) {
        const projectId = request.projectId ?? DEFAULT_PROJECT_ID;
        const refused = projectRefusal(this.project(projectId), projectId);
        if (refused) return refused;
      }
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

  async listProjects(): Promise<ProjectSummary[]> {
    return sortProjects((this.sql.projects.all() as ProjectRow[]).map(projectFromRow));
  }

  async createProject(input: { name: string; description?: string }): Promise<ProjectResult> {
    const planned = planProjectCreate(input, {
      now: this.clock.nowIso(),
      projectId: this.newProjectId(),
    });
    if (planned.ok) this.sql.upsertProject.run(planned.project);
    return planned;
  }

  async updateProject(projectId: string, change: ProjectChange): Promise<ProjectResult> {
    return this.db.transaction(() => {
      const planned = planProjectUpdate(
        this.project(projectId),
        projectId,
        change,
        this.clock.nowIso(),
      );
      if (planned.ok) this.sql.upsertProject.run(planned.project);
      return planned;
    })();
  }

  async moveCorral(corralId: string, projectId: string): Promise<SaveResult> {
    return this.db.transaction(() => {
      const refused = projectRefusal(this.project(projectId), projectId);
      if (refused) return refused;
      const moved = planMove(this.read(corralId), corralId, projectId, this.clock.nowIso());
      if (moved.ok) this.sql.moveCorral.run(projectId, moved.record.updatedAt, corralId);
      return moved;
    })();
  }

  async listSessions(projectId: string): Promise<WorkSession[]> {
    return sortSessions((this.sql.sessions.all(projectId) as SessionRow[]).map(sessionFromRow));
  }

  async getSession(sessionId: string): Promise<WorkSession | null> {
    return this.session(sessionId);
  }

  async createSession(input: {
    projectId: string;
    title: string;
    objective?: string;
    corralId?: string | null;
  }): Promise<SessionResult> {
    return this.db.transaction((): SessionResult => {
      const refused = projectRefusal(this.project(input.projectId), input.projectId);
      if (refused && !refused.ok)
        return { ok: false, error: 'not_found', message: refused.message };
      return this.saveSession(
        planSessionCreate(input, { now: this.clock.nowIso(), sessionId: this.newId('session') }),
      );
    })();
  }

  async updateSession(sessionId: string, change: SessionChange): Promise<SessionResult> {
    return this.db.transaction(() =>
      this.saveSession(
        planSessionUpdate(this.session(sessionId), sessionId, change, this.clock.nowIso()),
      ),
    )();
  }

  async addSessionEntry(sessionId: string, entry: NewSessionEntry): Promise<SessionResult> {
    return this.db.transaction(() =>
      this.saveSession(
        planSessionEntry(this.session(sessionId), sessionId, entry, {
          now: this.clock.nowIso(),
          entryId: this.newId('entry'),
        }),
      ),
    )();
  }

  async updateSessionEntry(
    sessionId: string,
    entryId: string,
    change: { state: SessionEntryState; runId?: string | null; detail?: string | null },
  ): Promise<SessionResult> {
    return this.db.transaction(() =>
      this.saveSession(
        planSessionEntryUpdate(
          this.session(sessionId),
          sessionId,
          entryId,
          change,
          this.clock.nowIso(),
        ),
      ),
    )();
  }

  private newId(prefix: string) {
    return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }

  private saveSession(result: SessionResult): SessionResult {
    if (!result.ok) return result;
    const s = result.session;
    this.sql.upsertSession.run({
      ...s,
      pinned: s.pinned ? 1 : 0,
      entries: JSON.stringify(s.entries),
      auto: s.auto ? JSON.stringify(s.auto) : null,
    });
    return result;
  }

  private session(sessionId: string): WorkSession | null {
    const row = this.sql.session.get(sessionId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  private project(projectId: string): ProjectSummary | null {
    const row = this.sql.project.get(projectId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
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
          project_id: string | null;
          definition_json: string;
          definition_hash: string;
          layout_json: string;
        }
      | undefined;
    if (!row) return null;
    return parseCorralRecord(
      {
        corralId: row.id,
        projectId: row.project_id ?? DEFAULT_PROJECT_ID,
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
      projectId: record.projectId,
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

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface SessionRow {
  id: string;
  project_id: string;
  corral_id: string | null;
  title: string;
  objective: string;
  pinned: number;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  entries_json: string;
  auto_json: string | null;
}

function sessionFromRow(row: SessionRow): WorkSession {
  return {
    sessionId: row.id,
    projectId: row.project_id,
    corralId: row.corral_id,
    title: row.title,
    objective: row.objective,
    pinned: row.pinned === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    entries: readJson(row.entries_json, row.id),
    auto: row.auto_json === null ? null : readJson(row.auto_json, row.id),
  };
}

function projectFromRow(row: ProjectRow): ProjectSummary {
  return {
    projectId: row.id,
    name: row.name,
    description: row.description,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function readJson<T = unknown>(text: string, corralId: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Saved Corral ${corralId} cannot be read.`);
  }
}
