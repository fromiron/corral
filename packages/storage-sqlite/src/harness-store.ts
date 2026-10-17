import {
  type Clock,
  ContentHash,
  type HarnessBindingRef,
  type HarnessDefault,
  HarnessProfile,
  HarnessProfileRevision,
  HarnessResource,
  type HarnessResourceView,
  Identifier,
} from '@corral/contracts';
import type { Db } from './database.ts';

/** Immutable content and revisions; trust and default selections are separate decisions. */
export class SqliteHarnessStore {
  private readonly db: Db;
  private readonly clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  getProfile(binding: HarnessBindingRef): HarnessProfileRevision | null {
    const row = this.db
      .prepare(
        'SELECT profile_json FROM harness_profile_revisions WHERE profile_id = ? AND revision = ?',
      )
      .get(binding.profileId, binding.revision) as { profile_json: string } | undefined;
    return row ? HarnessProfileRevision.parse(JSON.parse(row.profile_json)) : null;
  }

  listProfiles(): HarnessProfileRevision[] {
    return (
      this.db
        .prepare(`SELECT profile_json FROM harness_profile_revisions h
      WHERE revision = (SELECT max(revision) FROM harness_profile_revisions WHERE profile_id = h.profile_id)
      ORDER BY profile_id`)
        .all() as { profile_json: string }[]
    ).map((row) => HarnessProfileRevision.parse(JSON.parse(row.profile_json)));
  }

  saveProfile(
    profileId: string,
    expectedRevision: number,
    raw: HarnessProfile,
  ): HarnessProfileRevision {
    Identifier.parse(profileId);
    const profile = HarnessProfile.parse(raw);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('invalid profile revision');
    return this.db.transaction(() => {
      const current = this.db
        .prepare(
          'SELECT coalesce(max(revision), 0) AS revision FROM harness_profile_revisions WHERE profile_id = ?',
        )
        .get(profileId) as { revision: number };
      if (current.revision !== expectedRevision) throw new Error('profile revision changed');
      const next = HarnessProfileRevision.parse({
        ...profile,
        profileId,
        revision: expectedRevision + 1,
        createdAt: this.clock.nowIso(),
      });
      this.db
        .prepare(
          'INSERT INTO harness_profile_revisions (profile_id, revision, profile_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(profileId, next.revision, JSON.stringify(next), next.createdAt);
      return next;
    })();
  }

  getDefault(scope: HarnessDefault['scope'], scopeId: string): HarnessDefault {
    const row = this.db
      .prepare(
        'SELECT revision, profile_id, profile_revision FROM harness_defaults WHERE scope = ? AND scope_id = ?',
      )
      .get(scope, scopeId) as
      | { revision: number; profile_id: string | null; profile_revision: number | null }
      | undefined;
    return {
      scope,
      scopeId,
      revision: row?.revision ?? 0,
      binding:
        row?.profile_id && row.profile_revision
          ? { profileId: row.profile_id, revision: row.profile_revision }
          : null,
    };
  }

  setDefault(
    scope: HarnessDefault['scope'],
    scopeId: string,
    expectedRevision: number,
    binding: HarnessBindingRef | null,
  ): HarnessDefault {
    Identifier.parse(scopeId);
    if (scope !== 'personal' && scope !== 'project') throw new Error('invalid default scope');
    return this.db.transaction(() => {
      if (this.getDefault(scope, scopeId).revision !== expectedRevision)
        throw new Error('default revision changed');
      if (binding && !this.getProfile(binding)) throw new Error('profile not found');
      this.db
        .prepare(`INSERT INTO harness_defaults (scope, scope_id, revision, profile_id, profile_revision) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (scope, scope_id) DO UPDATE SET revision = excluded.revision, profile_id = excluded.profile_id, profile_revision = excluded.profile_revision`)
        .run(
          scope,
          scopeId,
          expectedRevision + 1,
          binding?.profileId ?? null,
          binding?.revision ?? null,
        );
      return this.getDefault(scope, scopeId);
    })();
  }

  putResource(raw: HarnessResource): HarnessResourceView {
    const resource = HarnessResource.parse(raw);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO harness_resources (hash, resource_json, created_at) VALUES (?, ?, ?)',
      )
      .run(resource.hash, JSON.stringify(resource), resource.createdAt);
    const saved = this.getResource(resource.hash);
    if (!saved) throw new Error('resource was not stored');
    return saved;
  }

  getResource(hash: string): HarnessResourceView | null {
    ContentHash.parse(hash);
    const row = this.db
      .prepare(`SELECT r.resource_json, t.trusted_at FROM harness_resources r
      LEFT JOIN harness_resource_trust t ON t.hash = r.hash WHERE r.hash = ?`)
      .get(hash) as { resource_json: string; trusted_at: string | null } | undefined;
    return row
      ? { ...HarnessResource.parse(JSON.parse(row.resource_json)), trustedAt: row.trusted_at }
      : null;
  }

  listResources(): HarnessResourceView[] {
    return (
      this.db
        .prepare('SELECT hash FROM harness_resources ORDER BY created_at DESC, hash')
        .all() as { hash: string }[]
    ).flatMap((row) => {
      const resource = this.getResource(row.hash);
      return resource ? [resource] : [];
    });
  }

  trustResource(hash: string, trusted: boolean): HarnessResourceView {
    const resource = this.getResource(hash);
    if (!resource) throw new Error('resource not found');
    const trustedAt = trusted ? this.clock.nowIso() : null;
    this.db
      .prepare(
        'INSERT INTO harness_resource_trust (hash, trusted_at) VALUES (?, ?) ON CONFLICT (hash) DO UPDATE SET trusted_at = excluded.trusted_at',
      )
      .run(hash, trustedAt);
    return { ...resource, trustedAt };
  }
}
