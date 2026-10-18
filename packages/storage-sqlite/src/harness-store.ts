import { createHash } from 'node:crypto';
import {
  type Clock,
  ContentHash,
  canonicalJson,
  HarnessBindingRef,
  type HarnessDefault,
  type HarnessEntryKey,
  type HarnessManagementState,
  HarnessProfile,
  HarnessProfileRevision,
  type HarnessProfileView,
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

  receipt<T>(operationId: string, input: unknown, work: () => T): T {
    Identifier.parse(operationId);
    const requestHash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    return this.db.transaction(() => {
      const prior = this.db
        .prepare(
          'SELECT request_hash, result_json FROM harness_management_receipts WHERE operation_id = ?',
        )
        .get(operationId) as { request_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error('operation payload changed');
        return JSON.parse(prior.result_json) as T;
      }
      const result = work();
      this.db
        .prepare('INSERT INTO harness_management_receipts VALUES (?, ?, ?)')
        .run(operationId, requestHash, JSON.stringify(result));
      return result;
    })();
  }

  receiptResult<T>(operationId: string, input: unknown): T | undefined {
    const prior = this.db
      .prepare(
        'SELECT request_hash, result_json FROM harness_management_receipts WHERE operation_id = ?',
      )
      .get(operationId) as { request_hash: string; result_json: string } | undefined;
    if (!prior) return undefined;
    if (prior.request_hash !== createHash('sha256').update(canonicalJson(input)).digest('hex'))
      throw new Error('operation payload changed');
    return JSON.parse(prior.result_json) as T;
  }

  receiptOutcome<T>(operationId: string): T | undefined {
    const row = this.db
      .prepare('SELECT result_json FROM harness_management_receipts WHERE operation_id = ?')
      .get(operationId) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as T) : undefined;
  }

  entryManagement(
    key: HarnessEntryKey,
  ): HarnessManagementState & { successor: HarnessEntryKey | null; displayName: string | null } {
    const row = this.db
      .prepare(
        'SELECT revision, archived_at, successor_json, display_name FROM harness_entry_management WHERE hash = ? AND entry = ? AND kind = ?',
      )
      .get(key.resourceHash, key.entry, key.kind) as
      | {
          revision: number;
          archived_at: string | null;
          successor_json: string | null;
          display_name: string | null;
        }
      | undefined;
    return {
      managementRevision: row?.revision ?? 0,
      archivedAt: row?.archived_at ?? null,
      successor: row?.successor_json ? JSON.parse(row.successor_json) : null,
      displayName: row?.display_name ?? null,
    };
  }

  manageEntry(
    key: HarnessEntryKey,
    expectedRevision: number,
    archived: boolean,
    successor?: HarnessEntryKey,
    displayName?: string,
  ) {
    const current = this.entryManagement(key);
    if (current.managementRevision !== expectedRevision)
      throw new Error('management revision changed');
    this.db
      .prepare(`INSERT INTO harness_entry_management VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash, entry, kind) DO UPDATE SET revision = excluded.revision, archived_at = excluded.archived_at, successor_json = excluded.successor_json, display_name = excluded.display_name`)
      .run(
        key.resourceHash,
        key.entry,
        key.kind,
        expectedRevision + 1,
        archived ? this.clock.nowIso() : null,
        JSON.stringify(successor ?? current.successor),
        displayName ?? current.displayName,
      );
    return this.entryManagement(key);
  }

  profileManagement(profileId: string): HarnessManagementState {
    const row = this.db
      .prepare('SELECT revision, archived_at FROM harness_profile_management WHERE profile_id = ?')
      .get(profileId) as { revision: number; archived_at: string | null } | undefined;
    return { managementRevision: row?.revision ?? 0, archivedAt: row?.archived_at ?? null };
  }

  manageProfile(profileId: string, expectedRevision: number, archived: boolean) {
    if (!this.listProfiles().some((profile) => profile.profileId === profileId))
      throw new Error('profile not found');
    if (this.profileManagement(profileId).managementRevision !== expectedRevision)
      throw new Error('management revision changed');
    this.db
      .prepare(`INSERT INTO harness_profile_management VALUES (?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET revision = excluded.revision, archived_at = excluded.archived_at`)
      .run(profileId, expectedRevision + 1, archived ? this.clock.nowIso() : null);
    return this.profileManagement(profileId);
  }

  currentBindings(projectId?: string): {
    id: string;
    binding: HarnessBindingRef;
    scope: 'personal' | 'project' | 'role';
    name: string;
  }[] {
    const defaults = this.db
      .prepare(
        'SELECT scope, scope_id, profile_id, profile_revision FROM harness_defaults WHERE profile_id IS NOT NULL',
      )
      .all() as {
      scope: 'personal' | 'project';
      scope_id: string;
      profile_id: string;
      profile_revision: number;
    }[];
    const bindings = defaults
      .filter((row) => !projectId || row.scope === 'personal' || row.scope_id === projectId)
      .map((row) => ({
        binding: { profileId: row.profile_id, revision: row.profile_revision },
        scope: row.scope as 'personal' | 'project' | 'role',
        name: row.scope_id,
        id: `${row.scope}:${row.scope_id}`,
      }));
    const teams = this.db
      .prepare(`SELECT c.id, c.name, c.project_id, d.definition_json FROM corrals c
      JOIN definition_versions d ON d.corral_id = c.id AND d.revision = c.definition_revision`)
      .all() as { id: string; name: string; project_id: string; definition_json: string }[];
    for (const team of teams.filter((row) => !projectId || row.project_id === projectId)) {
      const definition = JSON.parse(team.definition_json) as {
        roles: { id: string; harness?: unknown }[];
      };
      for (const role of definition.roles ?? []) {
        const parsed = HarnessBindingRef.safeParse(role.harness);
        if (parsed.success)
          bindings.push({
            id: `${team.id}:${role.id}`,
            binding: parsed.data,
            scope: 'role',
            name: `${team.name} / ${role.id}`,
          });
      }
    }
    return bindings;
  }

  profileViews(): HarnessProfileView[] {
    const bindings = this.currentBindings();
    return this.listProfiles().map((profile) => ({
      ...profile,
      ...this.profileManagement(profile.profileId),
      usages: bindings
        .filter((item) => item.binding.profileId === profile.profileId)
        .map((item) => ({
          scope: item.scope,
          name: item.name,
          id: item.id,
          revision: item.binding.revision,
        })),
    }));
  }

  referencedProfiles(): HarnessProfileRevision[] {
    const profiles = new Map(
      this.listProfiles().map((profile) => [`${profile.profileId}:${profile.revision}`, profile]),
    );
    for (const { binding } of this.currentBindings()) {
      const profile = this.getProfile(binding);
      if (profile) profiles.set(`${profile.profileId}:${profile.revision}`, profile);
    }
    return [...profiles.values()];
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
