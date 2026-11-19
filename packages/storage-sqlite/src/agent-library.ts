import {
  type Clock,
  type CreateLibraryAgent,
  LibraryAgent,
  type UpdateLibraryAgent,
} from '@corral/contracts';
import {
  type AgentLibrary,
  type AgentLibraryResult,
  planAgentCreate,
  planAgentUpdate,
} from '@corral/core';
import type { Db } from './database.ts';

type AgentRow = Omit<LibraryAgent, 'role'> & { role: string };
const CURRENT = `SELECT id AS agentId, project_id AS projectId, revision, role_json AS role,
  created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt FROM library_agents`;
const UNREADABLE = 'Saved agent cannot be read.';

function agentFromRow(row: AgentRow): LibraryAgent {
  return LibraryAgent.parse({ ...row, role: JSON.parse(row.role) });
}

function storageUnavailable(): AgentLibraryResult {
  return { ok: false, error: 'storage_unavailable', message: 'Agent storage is unavailable.' };
}

export class SqliteAgentLibrary implements AgentLibrary {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly newAgentId: () => string;
  private readonly sql;

  constructor(db: Db, options: { clock: Clock; newAgentId: () => string }) {
    this.db = db;
    this.clock = options.clock;
    this.newAgentId = options.newAgentId;
    this.sql = {
      list: db.prepare<[string], AgentRow>(
        `${CURRENT} WHERE project_id = ? ORDER BY created_at, id`,
      ),
      get: db.prepare<[string, string], AgentRow>(`${CURRENT} WHERE project_id = ? AND id = ?`),
      activeProject: db.prepare('SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL'),
      // Only the creation role, project, ID and creation time belong to the original receipt.
      original: db.prepare<[string, string], AgentRow>(
        `SELECT id AS agentId, project_id AS projectId, 1 AS revision, creation_role_json AS role,
           created_at AS createdAt, created_at AS updatedAt, NULL AS archivedAt
         FROM library_agents WHERE project_id = ? AND operation_id = ?`,
      ),
      insert: db.prepare(`INSERT INTO library_agents
        (id, project_id, revision, role_json, created_at, updated_at, archived_at, operation_id, creation_role_json)
        VALUES (@agentId, @projectId, @revision, @role, @createdAt, @updatedAt, @archivedAt, @operationId, @role)`),
      update:
        db.prepare(`UPDATE library_agents SET revision = ?, role_json = COALESCE(?, role_json),
        updated_at = ?, archived_at = ? WHERE project_id = ? AND id = ?`),
    };
  }

  async list(projectId: string): Promise<LibraryAgent[]> {
    try {
      return this.sql.list.all(projectId).map(agentFromRow);
    } catch {
      throw new Error(UNREADABLE);
    }
  }

  private current(projectId: string, agentId: string): LibraryAgent | null {
    const row = this.sql.get.get(projectId, agentId);
    return row ? agentFromRow(row) : null;
  }

  async get(projectId: string, agentId: string): Promise<LibraryAgent | null> {
    try {
      return this.current(projectId, agentId);
    } catch {
      throw new Error(UNREADABLE);
    }
  }

  async create(projectId: string, input: CreateLibraryAgent): Promise<AgentLibraryResult> {
    try {
      return this.db
        .transaction(() => {
          const active = this.sql.activeProject.get(projectId) !== undefined;
          const row =
            typeof input?.operationId === 'string'
              ? this.sql.original.get(projectId, input.operationId)
              : undefined;
          const original = row ? agentFromRow(row) : null;
          const result = planAgentCreate(projectId, active, original, input, {
            now: this.clock.nowIso(),
            newAgentId: this.newAgentId,
          });
          if (result.ok && !original) {
            this.sql.insert.run({
              ...result.agent,
              role: JSON.stringify(result.agent.role),
              operationId: input.operationId,
            });
          }
          return result;
        })
        .immediate();
    } catch {
      return storageUnavailable();
    }
  }

  async update(
    projectId: string,
    agentId: string,
    change: UpdateLibraryAgent,
  ): Promise<AgentLibraryResult> {
    try {
      return this.db
        .transaction(() => {
          const current = this.current(projectId, agentId);
          const result = planAgentUpdate(current, change, this.clock.nowIso());
          if (result.ok && result.agent !== current) {
            const { agent } = result;
            this.sql.update.run(
              agent.revision,
              agent.revision === current?.revision ? null : JSON.stringify(agent.role),
              agent.updatedAt,
              agent.archivedAt,
              projectId,
              agentId,
            );
          }
          return result;
        })
        .immediate();
    } catch {
      return storageUnavailable();
    }
  }
}
