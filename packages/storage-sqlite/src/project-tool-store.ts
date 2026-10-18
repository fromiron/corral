import { createHash } from 'node:crypto';
import {
  type Clock,
  canonicalJson,
  Identifier,
  ProjectToolConfig,
  ProjectToolConfigRevision,
  ProjectToolTrustTarget,
} from '@corral/contracts';
import type { Db } from './database.ts';

export class SqliteProjectToolStore {
  private readonly db: Db;
  private readonly clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  get(projectId: string, revision: number): ProjectToolConfigRevision | null {
    const row = this.db
      .prepare(
        'SELECT config_json FROM project_tool_revisions WHERE project_id = ? AND revision = ?',
      )
      .get(projectId, revision) as { config_json: string } | undefined;
    return row ? ProjectToolConfigRevision.parse(JSON.parse(row.config_json)) : null;
  }

  latest(projectId: string): ProjectToolConfigRevision | null {
    const row = this.db
      .prepare(
        'SELECT config_json FROM project_tool_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 1',
      )
      .get(projectId) as { config_json: string } | undefined;
    return row ? ProjectToolConfigRevision.parse(JSON.parse(row.config_json)) : null;
  }

  history(projectId: string): ProjectToolConfigRevision[] {
    return (
      this.db
        .prepare(
          'SELECT config_json FROM project_tool_revisions WHERE project_id = ? ORDER BY revision DESC',
        )
        .all(projectId) as { config_json: string }[]
    ).map((row) => ProjectToolConfigRevision.parse(JSON.parse(row.config_json)));
  }

  save(
    projectId: string,
    expectedRevision: number,
    raw: ProjectToolConfig,
  ): ProjectToolConfigRevision {
    Identifier.parse(projectId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('invalid project tool revision');
    const config = ProjectToolConfig.parse(raw);
    return this.db.transaction(() => {
      if ((this.latest(projectId)?.revision ?? 0) !== expectedRevision)
        throw new Error('project tool revision changed');
      const next = ProjectToolConfigRevision.parse({
        ...config,
        projectId,
        revision: expectedRevision + 1,
        hash: createHash('sha256').update(canonicalJson(config)).digest('hex'),
        createdAt: this.clock.nowIso(),
      });
      this.db
        .prepare(
          'INSERT INTO project_tool_revisions (project_id, revision, config_json) VALUES (?, ?, ?)',
        )
        .run(projectId, next.revision, JSON.stringify(next));
      return next;
    })();
  }

  trust(raw: ProjectToolTrustTarget): string | null {
    const target = ProjectToolTrustTarget.parse(raw);
    const row = this.db
      .prepare(
        'SELECT trusted_at FROM project_tool_trust WHERE project_id = ? AND kind = ? AND tool_id = ? AND fingerprint = ?',
      )
      .get(target.projectId, target.kind, target.id, target.fingerprint) as
      | { trusted_at: string | null }
      | undefined;
    return row?.trusted_at ?? null;
  }

  setTrust(raw: ProjectToolTrustTarget, trusted: boolean): void {
    const target = ProjectToolTrustTarget.parse(raw);
    this.db
      .prepare(`INSERT INTO project_tool_trust (project_id, kind, tool_id, fingerprint, trusted_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (project_id, kind, tool_id, fingerprint) DO UPDATE SET trusted_at = excluded.trusted_at`)
      .run(
        target.projectId,
        target.kind,
        target.id,
        target.fingerprint,
        trusted ? this.clock.nowIso() : null,
      );
  }
}
