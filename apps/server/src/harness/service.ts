import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadPiPackage,
  inspectPiPackage,
  type SdkResources,
  staticToolDescriptors,
} from '@corral/adapter-pi';
import type { McpChallenge } from '@corral/contracts';
import {
  type AgentStartInput,
  type Clock,
  CorralDefinition,
  canonicalJson,
  EffectiveHarnessSnapshot,
  type HarnessBindingRef,
  type HarnessDefault,
  HarnessDocumentDraft,
  HarnessEntryKey,
  type HarnessEntryView,
  type HarnessPreview,
  type HarnessPreviewRole,
  HarnessProfile,
  type HarnessProfileRevision,
  HarnessPublish,
  HarnessResource,
  type HarnessResourceView,
  isHarnessMcpTool,
  MAX_SNAPSHOT_RESOURCES,
  ManagedHook,
  McpServerDraft,
  type PackageInspection,
  PinnedPackageSource,
  RegisteredMcpServer,
  ResourcePath,
  ROLE_SKILLS_MINIMAL_BINDING,
  type RoleHarnessPreview,
  RoleHarnessResolutionError,
  type RoleMcpToolProblem,
  type RoleMcpToolProblemReason,
  type RoleSkillProblem,
  type RoleSkillRef,
  WorkTool,
} from '@corral/contracts';
import { type Db, SqliteHarnessStore, SqliteProjectToolStore } from '@corral/storage-sqlite';
import builtinManifest from '../../resources/builtin/manifest.json' with { type: 'json' };
import { managedHookSource } from './managed-hook.ts';
import type { McpService } from './mcp-service.ts';
import { inspectPackageManifest } from './package-manifest.ts';
import { hash, inside, scan, treeHash } from './resource-tree.ts';

interface ResourceReview {
  reviewId: string;
  resource: HarnessResource;
  directory: string;
  expiresAt: number;
  previous?: HarnessEntryKey;
  previousPackageHash?: string;
  display?: { entry: string; kind: HarnessEntryKey['kind']; name: string };
}
const MAX_SKILL_BYTES = 64 * 1024;

/** Resource discovery and preview read bytes only. Execution imports happen in the Pi worker. */
const SESSION_DEFAULT_PROFILE = 'session-default';
const SESSION_DEFAULT: HarnessProfile = {
  name: 'Session default',
  policy: 'trusted-native',
  allowedTools: [
    ...WorkTool.options,
    'read',
    'edit',
    'write',
    'run_check',
    'lsp_query',
    'submit_result',
    'spawn_subagents',
    'await_tasks',
    'ask',
    'ask_user',
    'update_plan',
    'reply',
    'read_artifact',
  ],
  resources: [],
  startupCommands: [],
};

// Immutable installation data: extend the broker vocabulary in a new policy revision.
const MINIMAL_PROFILE_V1: HarnessProfile = {
  name: 'Role skills',
  policy: 'strict',
  allowedTools: [
    'search',
    'read_document',
    'write_artifact',
    'generate_image',
    'preview_file',
    'preview_app',
    'preview_action',
    'list_files',
    'read_file',
    'write_file',
    'delete_file',
    'move_file',
    'run_command',
    'read_hashline',
    'edit_hashline',
    'submit_result',
    'ask_user',
    'update_plan',
    'spawn_subagents',
    'await_tasks',
    'ask',
    'reply',
    'read_artifact',
    'advise',
    'read',
  ],
  resources: [],
  startupCommands: [],
  checkIds: [],
  lspServerIds: [],
  mcpServerIds: [],
};

/** An explicit MCP pick cannot create a native role policy. */
function roleBinding(role: HarnessPreviewRole, runOverride?: HarnessBindingRef) {
  if (role.harness) return role.harness;
  if (runOverride) throw new Error('run work style requires a role with a bound harness');
  if (role.skills) return ROLE_SKILLS_MINIMAL_BINDING;
  if (role.mcpTools?.length)
    throw new RoleHarnessResolutionError(null, {
      roleId: role.id,
      tools: role.mcpTools.map((ref) => ({ ...ref, reason: 'execution_policy_required' })),
    });
  return null;
}

class ResourceVerificationError extends Error {
  readonly reason: 'missing' | 'untrusted';
  constructor(reason: 'missing' | 'untrusted', message: string) {
    super(message);
    this.reason = reason;
  }
}

const resourceKey = (ref: RoleSkillRef) => `${ref.resourceHash}:${ref.entry}`;

type BuiltinManifest = Record<
  string,
  { hash: string; files: number; skills: number; source: string }
>;
const BUILTIN = {
  root: fileURLToPath(new URL('../../resources/builtin/', import.meta.url)),
  manifest: builtinManifest as BuiltinManifest,
};
/**
 * Pi's reading of a bundled pack, per inspector and exact content hash. The same bytes read the
 * same way, so each process inspects a bundled version once (every inspection spawns a worker).
 */
const builtinInspections = new WeakMap<object, Map<string, PackageInspection>>();
/** Recorded by the startup pass for a bundled version it installs or first sees; an import never is. */
const builtinMark = (id: string, hash = '') => `builtin:${id}:${hash}`;
const requiredResource = (ref: HarnessProfile['resources'][number]) =>
  ref.required || ref.skillMode === 'mandatory';

export class HarnessService {
  private readonly evaluationDefinitions = new Map<string, HarnessBindingRef>();
  readonly store: SqliteHarnessStore;
  readonly projectTools: SqliteProjectToolStore;
  private readonly root: string;
  private readonly newId: () => string;
  readonly mcp: McpService | undefined;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly inspect: (directory: string) => Promise<PackageInspection>;
  private readonly download: (source: string, directory: string) => Promise<PackageInspection>;
  private readonly reviews = new Map<string, ResourceReview>();
  private readonly builtin: { root: string; manifest: BuiltinManifest };

  constructor(options: {
    root: string;
    newId?: () => string;
    mcp?: McpService;
    db: Db;
    clock: Clock;
    inspect?: (directory: string) => Promise<PackageInspection>;
    download?: (source: string, directory: string) => Promise<PackageInspection>;
    /** The bundled packs and their manifest; tests pass fixture packs. */
    builtin?: { root: string; manifest: BuiltinManifest };
  }) {
    this.root = resolve(options.root);
    this.builtin = options.builtin ?? BUILTIN;
    this.newId = options.newId ?? randomUUID;
    this.mcp = options.mcp;
    this.mcp?.setPackageVerifier((hash) => {
      if (!this.verify(hash).trustedAt) throw new Error('package requires trust before MCP launch');
    });
    this.db = options.db;
    this.clock = options.clock;
    this.inspect = options.inspect ?? inspectPiPackage;
    this.download = options.download ?? downloadPiPackage;
    this.store = new SqliteHarnessStore(options.db, options.clock);
    this.projectTools = new SqliteProjectToolStore(options.db, options.clock);
    mkdirSync(join(this.root, 'reviews'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, 'resources'), { recursive: true, mode: 0o700 });
  }

  entries(): HarnessEntryView[] {
    const profiles = this.store.referencedProfiles();
    return this.store
      .listResources()
      .filter((resource) => this.store.packageManagement(resource.hash).status !== 'removed')
      .flatMap((resource) =>
        [
          ...resource.skills.map((skill) => ({
            entry: skill.entry,
            kind: 'skill' as const,
            name: skill.name,
            description: skill.description,
          })),
          ...resource.extensions.map((entry) => ({
            entry,
            kind: 'extension' as const,
            name: entry.split('/').at(-1) ?? resource.name,
            description: '',
          })),
        ].map((entry) => {
          const key = { resourceHash: resource.hash, entry: entry.entry, kind: entry.kind };
          const { files, ...bundle } = resource;
          return {
            ...entry,
            ...key,
            ...this.store.entryManagement(key),
            resource: { ...bundle, fileCount: files.length },
            name: this.store.entryManagement(key).displayName ?? entry.name,
            profiles: profiles
              .filter((profile) =>
                profile.resources.some(
                  (ref) =>
                    ref.resourceHash === key.resourceHash &&
                    ref.entry === key.entry &&
                    ref.kind === key.kind,
                ),
              )
              .map(({ profileId, revision, name }) => ({ profileId, revision, name })),
          };
        }),
      );
  }

  packages() {
    const profiles = this.store.referencedProfiles();
    return this.store.listResources().map((resource) => ({
      resource,
      manifest: inspectPackageManifest(this.directory(resource.hash), resource.packagePath),
      ...this.store.packageManagement(resource.hash),
      profiles: profiles
        .filter((profile) => profile.resources.some((ref) => ref.resourceHash === resource.hash))
        .map(({ profileId, revision, name }) => ({ profileId, revision, name })),
    }));
  }

  async reviewPackage(kind: 'local' | 'package', source: string, previousHash?: string) {
    const previous = previousHash ? this.verify(previousHash) : undefined;
    const review =
      kind === 'local' ? await this.discoverLocal(source) : await this.discoverPackage(source);
    try {
      const retained = this.reviews.get(review.reviewId);
      if (!retained) throw new Error('resource review expired or already installed');
      if (previous && previous.name !== review.resource.name)
        throw new Error('package name changed');
      if (previous) retained.previousPackageHash = previous.hash;
      const oldFiles = new Map(previous?.files.map((file) => [file.path, file.hash]) ?? []);
      const newFiles = new Map(review.resource.files.map((file) => [file.path, file.hash]));
      return {
        ...review,
        manifest: inspectPackageManifest(retained.directory, review.resource.packagePath),
        ...(previous
          ? {
              previous: { hash: previous.hash, name: previous.name, version: previous.version },
              changes: {
                added: [...newFiles.keys()].filter((path) => !oldFiles.has(path)),
                removed: [...oldFiles.keys()].filter((path) => !newFiles.has(path)),
                changed: [...newFiles.keys()].filter(
                  (path) => oldFiles.has(path) && oldFiles.get(path) !== newFiles.get(path),
                ),
              },
            }
          : {}),
      };
    } catch (error) {
      this.cancelReview(review.reviewId);
      throw error;
    }
  }

  async managePackage(
    hash: string,
    expectedRevision: number,
    status: 'enabled' | 'disabled' | 'removed',
    operationId: string,
  ) {
    const result = this.store.receipt(operationId, { hash, expectedRevision, status }, () => {
      if (status === 'enabled') this.verify(hash);
      this.store.managePackage(hash, expectedRevision, status);
      const result = this.packages().find((entry) => entry.resource.hash === hash);
      if (!result) throw new Error('resource not installed');
      return result;
    });
    if (status !== 'enabled') await this.mcp?.cancelPackageProbe(hash);
    return result;
  }

  readEntry(raw: HarnessEntryKey): { content: string; hook: ManagedHook | null } {
    const key = HarnessEntryKey.parse(raw);
    const resource = this.verify(key.resourceHash);
    if (
      key.kind === 'skill'
        ? !resource.skills.some((skill) => skill.entry === key.entry)
        : !resource.extensions.includes(key.entry)
    )
      throw new Error('unknown resource entry');
    const bytes = readFileSync(join(this.directory(key.resourceHash), key.entry));
    if (bytes.length > MAX_SKILL_BYTES) throw new Error('resource editor size limit exceeded');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let hook: ManagedHook | null = null;
    const metadata = join(this.directory(key.resourceHash), 'corral-managed-hooks.json');
    if (key.kind === 'extension' && existsSync(metadata)) {
      try {
        const raw = JSON.parse(readFileSync(metadata, 'utf8'));
        const parsed = ManagedHook.safeParse(raw.version === 1 ? raw.entries?.[key.entry] : null);
        if (parsed.success && managedHookSource(parsed.data) === content) hook = parsed.data;
      } catch {
        /* Imported metadata is advisory; the source is always available. */
      }
    }
    return { content, hook };
  }

  reviewFile(resourceHash: string, rawPath: string) {
    const path = ResourcePath.parse(rawPath);
    const resource = this.verify(resourceHash);
    const file = resource.files.find((item) => item.path === path);
    if (!file) return null;
    let text: string | null = null;
    if (file.bytes <= MAX_SKILL_BYTES) {
      const source = join(this.directory(resourceHash), path);
      if (realpathSync(source) !== resolve(source)) throw new Error('resource file became a link');
      const bytes = readFileSync(source);
      if (bytes.length !== file.bytes || hash(bytes) !== file.hash) {
        this.store.trustResource(resourceHash, false);
        throw new Error('resource integrity changed');
      }
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!decoded.includes('\0')) text = decoded;
      } catch {
        /* Binary files retain their exact hash and size for review. */
      }
    }
    return { hash: file.hash, bytes: file.bytes, text };
  }

  async reviewDocument(raw: HarnessDocumentDraft) {
    const draft = HarnessDocumentDraft.parse(raw);
    if (draft.base && draft.base.kind !== draft.kind) throw new Error('resource kind conflict');
    if (draft.hook && draft.kind !== 'extension') throw new Error('resource kind conflict');
    const content = draft.hook ? managedHookSource(draft.hook) : draft.content;
    if (
      !content.trim() ||
      Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES ||
      content.includes('\0')
    )
      throw new Error('resource editor size limit exceeded');
    this.expireReviews();
    const directory = mkdtempSync(join(this.root, 'reviews', 'edit-'));
    const entry =
      draft.base?.entry ?? (draft.kind === 'skill' ? 'skills/SKILL.md' : 'extensions/hook.ts');
    try {
      if (draft.base) {
        this.readEntry(draft.base);
        scan(this.directory(draft.base.resourceHash), directory);
      }
      mkdirSync(dirname(join(directory, entry)), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, entry), content, { mode: 0o600 });
      const manifest = join(directory, 'package.json');
      const prior = existsSync(manifest)
        ? JSON.parse(readFileSync(manifest, 'utf8'))
        : {
            name: 'corral-managed-resource',
            version: '1.0.0',
            pi: draft.kind === 'skill' ? { skills: ['./skills'] } : { extensions: [entry] },
          };
      writeFileSync(manifest, JSON.stringify({ ...prior, corralDisplayName: draft.name }), {
        mode: 0o600,
      });
      if (draft.kind === 'extension') {
        const metadata = join(directory, 'corral-managed-hooks.json');
        let entries: Record<string, unknown> = {};
        if (existsSync(metadata)) {
          try {
            entries = JSON.parse(readFileSync(metadata, 'utf8')).entries ?? {};
          } catch {
            /* Source-only copy. */
          }
        }
        delete entries[entry];
        if (draft.hook) entries[entry] = draft.hook;
        writeFileSync(metadata, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      }
      const inspection = await this.inspect(directory);
      if (
        draft.kind === 'skill'
          ? !inspection.skills.some((skill) => skill.entry === entry)
          : !inspection.extensions.includes(entry)
      )
        throw new Error('document is not a valid resource entry');
      const files = scan(directory);
      const result = this.retainReview(
        directory,
        HarnessResource.parse({
          ...inspection,
          hash: treeHash(files),
          files,
          sourceKind: 'local',
          sourceLabel: draft.base ? 'Edited copy' : 'Created in Corral',
          createdAt: this.clock.nowIso(),
        }),
      );
      const retained = this.reviews.get(result.reviewId)!;
      if (draft.base) retained.previous = draft.base;
      retained.display = { entry, kind: draft.kind, name: draft.name };
      return result;
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  cancelReview(reviewId: string) {
    const review = this.reviews.get(reviewId);
    if (review) rmSync(review.directory, { recursive: true, force: true });
    this.reviews.delete(reviewId);
  }

  archiveEntry(
    raw: HarnessEntryKey,
    expectedRevision: number,
    archived: boolean,
    operationId: string,
  ) {
    const key = HarnessEntryKey.parse(raw);
    return this.store.receipt(operationId, { key, expectedRevision, archived }, () => {
      const resource = this.store.getResource(key.resourceHash);
      if (
        !resource ||
        (key.kind === 'skill'
          ? !resource.skills.some((skill) => skill.entry === key.entry)
          : !resource.extensions.includes(key.entry))
      )
        throw new Error('unknown resource entry');
      return this.store.manageEntry(key, expectedRevision, archived);
    });
  }

  archiveProfile(
    profileId: string,
    expectedRevision: number,
    archived: boolean,
    operationId: string,
  ) {
    return this.store.receipt(operationId, { profileId, expectedRevision, archived }, () =>
      this.store.manageProfile(profileId, expectedRevision, archived),
    );
  }

  publish(raw: HarnessPublish) {
    const input = HarnessPublish.parse(raw);
    return this.store.receipt(input.operationId, input, () => {
      if (input.target) {
        const current = this.store.getDefault(input.target.scope, input.target.scopeId);
        if (
          current.revision !== input.target.expectedRevision ||
          canonicalJson(current.binding) !== canonicalJson(input.target.binding)
        )
          throw new Error('default revision changed');
        if (
          input.target.scope === 'project' &&
          input.target.projectToolsRevision !== undefined &&
          (this.projectTools.latest(input.target.scopeId)?.revision ?? 0) !==
            input.target.projectToolsRevision
        )
          throw new Error('project tool revision changed');
      }
      const profile = this.saveProfile(input.profileId, input.expectedRevision, input.profile);
      const target = input.target
        ? this.setDefault(input.target.scope, input.target.scopeId, input.target.expectedRevision, {
            profileId: profile.profileId,
            revision: profile.revision,
          })
        : null;
      return { profile, target };
    });
  }

  saveMcp(
    projectId: string,
    expectedRevision: number,
    operationId: string,
    raw: McpServerDraft,
    serverId?: string,
    sourcePackageHash?: string,
  ) {
    const draft = McpServerDraft.parse(raw);
    if (!this.mcp) throw new Error('MCP runtime unavailable');
    return this.mcp.updateTools(
      projectId,
      expectedRevision,
      () => {
        if (
          sourcePackageHash &&
          this.store.packageManagement(sourcePackageHash).status !== 'enabled'
        )
          throw new Error('package is disabled or removed');
        const config = this.projectTools.latest(projectId);
        const previous = config?.mcpServers?.find((server) => server.id === serverId);
        if (serverId && !previous) throw new Error('no such registered tool');
        const server = RegisteredMcpServer.parse({
          ...draft,
          ...(sourcePackageHash || previous?.sourcePackageHash
            ? { sourcePackageHash: sourcePackageHash ?? previous?.sourcePackageHash }
            : {}),
          id: serverId ?? `mcp_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          ...(draft.transport === 'http' && draft.auth.kind !== 'none'
            ? {
                auth: {
                  ...draft.auth,
                  credentialRef:
                    previous?.transport === 'http' && previous.auth.kind !== 'none'
                      ? previous.auth.credentialRef
                      : `credential_${randomUUID()}`,
                },
              }
            : {}),
        });
        return {
          checks: config?.checks ?? [],
          lspServers: config?.lspServers ?? [],
          ...(config?.debugAdapters ? { debugAdapters: config.debugAdapters } : {}),
          ...(config?.debugConfigurations
            ? { debugConfigurations: config.debugConfigurations }
            : {}),
          ...(config?.deployments ? { deployments: config.deployments } : {}),
          mcpServers: [
            ...(config?.mcpServers ?? []).filter((item) => item.id !== server.id),
            server,
          ],
        };
      },
      {
        operationId,
        input: {
          projectId,
          expectedRevision,
          draft,
          ...(serverId ? { serverId } : {}),
          ...(sourcePackageHash ? { sourcePackageHash } : {}),
        },
      },
    );
  }

  registerPackageMcp(
    hash: string,
    contributionId: string,
    projectId: string,
    expectedRevision: number,
    operationId: string,
  ) {
    const resource = this.verify(hash);
    const root = this.directory(hash);
    const contribution = inspectPackageManifest(root, resource.packagePath)?.mcpServers.find(
      (entry) => entry.id === contributionId,
    );
    if (!contribution) throw new Error('package MCP contribution not found');
    const base = {
      name: contribution.name,
      enabled: false,
      exposure: 'direct' as const,
      timeoutMs: 30000,
    };
    const draft: McpServerDraft =
      contribution.transport === 'http'
        ? { ...base, transport: 'http', url: contribution.url, auth: { kind: 'none' } }
        : {
            ...base,
            transport: 'stdio',
            argv: contribution.argv.map((arg) => {
              const path = [resource.packagePath, arg.replace(/^\.\//, '')]
                .filter(Boolean)
                .join('/');
              return resource.files.some((file) => file.path === path) ? join(root, path) : arg;
            }),
          };
    return this.saveMcp(projectId, expectedRevision, operationId, draft, undefined, hash);
  }

  removeMcp(
    projectId: string,
    expectedRevision: number,
    operationId: string,
    serverId: string,
    restoreRevision?: number,
  ) {
    if (!this.mcp) throw new Error('MCP runtime unavailable');
    return this.mcp.updateTools(
      projectId,
      expectedRevision,
      () => {
        const config = this.projectTools.latest(projectId);
        let servers = (config?.mcpServers ?? []).filter((server) => server.id !== serverId);
        if (restoreRevision !== undefined) {
          if (config?.mcpServers?.some((server) => server.id === serverId))
            throw new Error('MCP server is already registered');
          const server = this.projectTools
            .get(projectId, restoreRevision)
            ?.mcpServers?.find((item) => item.id === serverId);
          if (!server) throw new Error('no such registered tool');
          servers = [...servers, { ...server, enabled: false }];
        }
        return {
          checks: config?.checks ?? [],
          lspServers: config?.lspServers ?? [],
          ...(config?.debugAdapters ? { debugAdapters: config.debugAdapters } : {}),
          ...(config?.debugConfigurations
            ? { debugConfigurations: config.debugConfigurations }
            : {}),
          ...(config?.deployments ? { deployments: config.deployments } : {}),
          mcpServers: servers,
        };
      },
      {
        operationId,
        input: {
          projectId,
          expectedRevision,
          serverId,
          ...(restoreRevision === undefined ? {} : { restoreRevision }),
        },
      },
    );
  }

  /**
   * Server start: install each bundled pack version the store does not have yet
   * (docs/specs/features/builtin-crew.md, "설치"). A stored hash is left alone whatever a person
   * did with it; a new one takes over their choices on the earlier version and supersedes it. A
   * pack that fails, or does not match the manifest, is skipped; the rest install.
   */
  async installBuiltins(): Promise<{ installed: string[]; failed: string[] }> {
    const installed: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      Object.entries(this.builtin.manifest).map(async ([id, manifest]) => {
        try {
          const mark = builtinMark(id, manifest.hash);
          // Earlier bundled versions of this pack, oldest first.
          const earlier = () =>
            this.store
              .receiptIds(builtinMark(id))
              .filter((operationId) => operationId !== mark)
              .map((operationId) => operationId.slice(builtinMark(id).length));
          const stored = this.store.getResource(manifest.hash);
          if (stored) {
            // Its state stays as it is. The first start that sees it, after a person imported it,
            // still supersedes the earlier versions; recording it lets a later version supersede it.
            if (this.store.receiptOutcome(mark) !== undefined) return;
            this.db.transaction(() => {
              const previous = earlier();
              this.store.receipt(mark, { id, hash: manifest.hash }, () => ({ id }));
              for (const hash of previous) this.supersedeBuiltin(hash, stored);
            })();
            return;
          }
          const review = await this.discoverBuiltin(id);
          this.db.transaction(() => {
            const previous = earlier();
            const resource = this.install(review.reviewId);
            // Read the person's choices on the latest earlier version before superseding it.
            const last = previous.at(-1);
            if (last) this.inheritBuiltin(last, resource);
            this.store.receipt(mark, { id, hash: resource.hash }, () => ({ id }));
            for (const hash of previous) this.supersedeBuiltin(hash, resource);
          })();
          installed.push(id);
        } catch {
          failed.push(id);
        }
      }),
    );
    return { installed, failed };
  }

  /**
   * A new bundled version takes over what a person did to the latest earlier one (builtin-crew.md,
   * "설치"): a disabled or removed pack stays so, a revoked one installs untrusted, and a skill they
   * archived or linked to their own copy installs archived. The startup pass alone archives or
   * links an earlier version's entries, and only when it supersedes that version, so on the
   * latest one these states are the person's.
   */
  private inheritBuiltin(hash: string, next: HarnessResourceView) {
    const previous = this.store.getResource(hash);
    if (!previous) return;
    const status = this.store.packageManagement(hash).status;
    if (status !== 'enabled')
      this.store.managePackage(
        next.hash,
        this.store.packageManagement(next.hash).managementRevision,
        status,
      );
    if (!previous.trustedAt) this.store.trustResource(next.hash, false);
    for (const skill of next.skills) {
      const before = previous.skills.find((candidate) => candidate.name === skill.name);
      if (!before) continue;
      const state = this.store.entryManagement({
        resourceHash: hash,
        entry: before.entry,
        kind: 'skill',
      });
      if (state.archivedAt === null && state.successor === null) continue;
      const key = { resourceHash: next.hash, entry: skill.entry, kind: 'skill' as const };
      this.store.manageEntry(key, this.store.entryManagement(key).managementRevision, true);
    }
  }

  /** Archive an earlier bundled version's entries, linking same-named ones to the new version. */
  private supersedeBuiltin(hash: string, next: HarnessResourceView) {
    const previous = this.store.getResource(hash);
    for (const skill of previous?.skills ?? []) {
      const key = { resourceHash: hash, entry: skill.entry, kind: 'skill' as const };
      const state = this.store.entryManagement(key);
      // An entry a person archived or linked keeps their choice.
      if (state.archivedAt !== null || state.successor !== null) continue;
      const successor = next.skills.find((candidate) => candidate.name === skill.name);
      this.store.manageEntry(
        key,
        state.managementRevision,
        true,
        successor ? { resourceHash: next.hash, entry: successor.entry, kind: 'skill' } : undefined,
      );
    }
  }

  async discoverBuiltin(id: string) {
    if (!Object.hasOwn(this.builtin.manifest, id)) throw new Error('unknown built-in pack');
    const manifest = this.builtin.manifest[id]!;
    const source = join(this.builtin.root, id);
    if (relative(this.builtin.root, source).split(sep)[0] !== id)
      throw new Error('unknown built-in pack');
    const inspections =
      builtinInspections.get(this.inspect) ?? new Map<string, PackageInspection>();
    builtinInspections.set(this.inspect, inspections);
    const known = inspections.get(manifest.hash);
    const review = await this.discoverLocal(
      source,
      known ? { hash: manifest.hash, inspection: known } : undefined,
    );
    if (
      review.resource.hash !== manifest.hash ||
      review.resource.skills.length !== manifest.skills ||
      review.resource.extensions.length
    ) {
      this.cancelReview(review.reviewId);
      throw new Error('built-in pack integrity changed');
    }
    if (!known) {
      const { name, version, license, packagePath, extensions, skills } = review.resource;
      inspections.set(manifest.hash, { name, version, license, packagePath, extensions, skills });
    }
    review.resource.sourceLabel = manifest.source;
    return review;
  }

  async discoverLocal(source: string, known?: { hash: string; inspection: PackageInspection }) {
    this.expireReviews();
    const original = this.sourceDirectory(source);
    const directory = mkdtempSync(join(this.root, 'reviews', 'copy-'));
    try {
      const files = scan(original, directory);
      const inspection =
        known && treeHash(files) === known.hash ? known.inspection : await this.inspect(directory);
      const resource = HarnessResource.parse({
        ...inspection,
        hash: treeHash(files),
        sourceKind: 'local',
        sourceLabel: 'Local copy',
        files,
        createdAt: this.clock.nowIso(),
      });
      return this.retainReview(directory, resource);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Explicit import copies resource directories only; Pi auth/settings/session files stay put. */
  async discoverPiHome(source: string) {
    this.expireReviews();
    const directory = mkdtempSync(join(this.root, 'reviews', 'pi-copy-'));
    try {
      const selected = ['extensions', 'skills'].filter((name) => existsSync(join(source, name)));
      if (!selected.length) throw new Error('package contains no supported skills or extensions');
      for (const name of selected) {
        mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
        scan(this.sourceDirectory(join(source, name)), join(directory, name));
      }
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'pi-home-copy',
          version: 'local',
          pi: Object.fromEntries(selected.map((name) => [name, [`./${name}`]])),
        }),
        { mode: 0o600 },
      );
      const files = scan(directory);
      const inspection = await this.inspect(directory);
      const resource = HarnessResource.parse({
        ...inspection,
        hash: treeHash(files),
        sourceKind: 'local',
        sourceLabel: 'Pi resource folders (copy)',
        files,
        createdAt: this.clock.nowIso(),
      });
      return this.retainReview(directory, resource);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async discoverPackage(rawSource: string) {
    const parsed = PinnedPackageSource.safeParse(rawSource);
    if (!parsed.success) throw new Error('package source requires an exact version or commit');
    this.expireReviews();
    const downloaded = mkdtempSync(join(this.root, 'reviews', 'download-'));
    const directory = mkdtempSync(join(this.root, 'reviews', 'copy-'));
    try {
      const inspection = await this.download(parsed.data, downloaded);
      const files = scan(downloaded, directory);
      const resource = HarnessResource.parse({
        ...inspection,
        files,
        hash: treeHash(files),
        sourceKind: parsed.data.startsWith('npm:') ? 'npm' : 'git',
        sourceLabel: parsed.data,
        createdAt: this.clock.nowIso(),
      });
      return this.retainReview(directory, resource);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(downloaded, { recursive: true, force: true });
    }
  }

  private retainReview(directory: string, resource: HarnessResource) {
    const manifest = inspectPackageManifest(directory, resource.packagePath);
    this.checkEntries(resource, Boolean(manifest?.mcpServers.length || manifest?.ui.length));
    const reviewId = `review_${this.newId()}`;
    this.reviews.set(reviewId, {
      reviewId,
      resource,
      directory,
      expiresAt: this.clock.monotonicMs() + 30 * 60_000,
    });
    return { reviewId, resource };
  }

  private sourceDirectory(source: string) {
    const original = realpathSync(source);
    if (
      !statSync(original).isDirectory() ||
      inside(original, this.root) ||
      inside(this.root, original)
    )
      throw new Error('choose a resource directory outside Corral data');
    return original;
  }

  async runtimeResources(
    input: Pick<AgentStartInput, 'harness' | 'inputs'> & Partial<Pick<AgentStartInput, 'runId'>>,
  ): Promise<SdkResources> {
    if (!input.harness) throw new Error('harness snapshot missing');
    const { snapshotHash, ...body } = input.harness;
    if (snapshotHash !== hash(canonicalJson(body)))
      throw new Error('harness snapshot integrity changed');
    const resources: SdkResources = {
      extensions: [],
      skills: [],
      startupCommands: [],
      bundles: [],
    };
    const bundled = new Set<string>();
    const checked = new Map<string, HarnessResourceView | Error>();
    for (const ref of input.harness.resources) {
      let resource = checked.get(ref.hash);
      if (!resource) {
        try {
          resource = this.verify(ref.hash);
        } catch (error) {
          resource = error instanceof Error ? error : new Error(String(error));
        }
        checked.set(ref.hash, resource);
      }
      // A skill nobody required or picked never blocks a worker start; it is left out instead.
      const loose = ref.kind === 'skill' && !ref.required && !ref.selectedByRole;
      if (resource instanceof Error) {
        if (loose) continue;
        throw resource;
      }
      if (
        loose &&
        (!resource.trustedAt ||
          !resource.skills.some(
            (skill) => skill.entry === ref.entry && skill.name === ref.skillName,
          ))
      )
        continue;
      if (!resource.trustedAt || !ref.entry)
        throw new Error('resource requires trust before execution');
      if (!bundled.has(ref.hash)) {
        resources.bundles.push({
          root: this.directory(ref.hash),
          hash: ref.hash,
          files: resource.files,
        });
        bundled.add(ref.hash);
      }
      if (ref.kind === 'extension') {
        if (!resource.extensions.includes(ref.entry)) throw new Error('unknown extension entry');
        resources.extensions.push({
          path: join(this.directory(ref.hash), ref.entry),
          hash: ref.hash,
          source: `extension:${resource.name}@${resource.version}`,
        });
      } else {
        const skill = resource.skills.find(
          (skill) => skill.entry === ref.entry && skill.name === ref.skillName,
        );
        if (!skill) throw new Error('skill entry changed');
        const explicit = input.inputs.some(
          (input) =>
            input.kind === 'run_input' &&
            input.name === 'brief' &&
            input.text
              .split(/\r?\n/)
              .some((line) => line.trim().split(/\s+/, 1)[0] === `/skill:${skill.name}`),
        );
        const bytes =
          ref.skillMode === 'mandatory' || explicit
            ? readFileSync(join(this.directory(ref.hash), skill.entry))
            : null;
        if (bytes && bytes.length > MAX_SKILL_BYTES) throw new Error('skill size limit exceeded');
        resources.skills.push({
          name: skill.name,
          description: skill.description,
          entry: skill.entry,
          hash: ref.hash,
          mode: ref.skillMode ?? 'auto',
          content: bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '',
        });
      }
    }
    if (input.harness.startupCommandPolicy !== 'none') {
      for (const layer of input.harness.layers ?? [
        { scope: 'role', binding: input.harness.binding },
      ]) {
        resources.startupCommands.push(...this.profile(layer.binding).startupCommands);
      }
      if (resources.startupCommands.length > 16) throw new Error('too many startup commands');
    }
    if (input.runId && this.mcp)
      Object.assign(resources, await this.mcp.resources(input.runId, input.harness));
    else if (input.harness.projectTools?.mcpServerIds?.length)
      throw new Error('MCP runtime unavailable');
    return resources;
  }

  checkMcpTool(input: AgentStartInput, name: string, args: Record<string, unknown>) {
    if (!this.mcp) throw new Error('MCP runtime unavailable');
    return this.mcp.checkTool(input, name, args);
  }

  mcpAuthorization(input: AgentStartInput, serverId: string, challenge?: McpChallenge) {
    if (!this.mcp) throw new Error('MCP runtime unavailable');
    return this.mcp.authorization(input, serverId, challenge);
  }

  readSkill(snapshot: EffectiveHarnessSnapshot, path: string): Record<string, unknown> {
    ResourcePath.parse(path);
    const [prefix, name, ...rest] = path.split('/');
    if (prefix !== 'skills' || !name || !rest.length) throw new Error('invalid skill path');
    const ref = snapshot.resources.find(
      (resource) => resource.kind === 'skill' && resource.skillName === name,
    );
    if (!ref?.entry) throw new Error('skill is not bound to this role');
    const resource = this.store.getResource(ref.hash);
    if (!resource?.trustedAt) throw new Error('skill resource is not trusted');
    const entry = ResourcePath.parse(
      join(dirname(ref.entry), ...rest)
        .split(sep)
        .join('/'),
    );
    const file = resource.files.find((file) => file.path === entry);
    if (!file || file.bytes > 1024 * 1024) throw new Error('skill file unavailable or too large');
    const source = join(this.directory(ref.hash), entry);
    if (realpathSync(source) !== resolve(source)) throw new Error('skill file became a link');
    const bytes = readFileSync(source);
    if (bytes.length !== file.bytes || hash(bytes) !== file.hash) {
      this.store.trustResource(ref.hash, false);
      throw new Error('skill resource integrity changed');
    }
    return {
      path,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      sha256: file.hash,
      resourceHash: ref.hash,
      // An explicit skill is used only when a request names it, so it is not listed.
      boundSkills: snapshot.resources
        .filter(
          (resource) =>
            resource.kind === 'skill' &&
            resource.skillName &&
            resource.entry &&
            resource.skillMode !== 'explicit',
        )
        .map((resource) => ({
          name: resource.skillName,
          path: `skills/${resource.skillName}/SKILL.md`,
        })),
    };
  }

  install(reviewId: string): HarnessResourceView {
    return this.store.receipt(`install_${reviewId}`, { reviewId }, () => {
      this.expireReviews();
      const review = this.reviews.get(reviewId);
      if (!review) throw new Error('resource review expired or already installed');
      if (treeHash(scan(review.directory)) !== review.resource.hash)
        throw new Error('reviewed resource changed');
      const destination = this.directory(review.resource.hash);
      if (existsSync(destination)) {
        if (treeHash(scan(destination)) !== review.resource.hash)
          throw new Error('installed resource integrity changed');
        rmSync(review.directory, { recursive: true, force: true });
      } else renameSync(review.directory, destination);
      // The install review is the person's check: a new hash is trusted when it is installed.
      // A hash already stored keeps its trust decision, so a revocation is never undone here.
      const known = this.store.getResource(review.resource.hash) !== null;
      let installed = this.store.putResource(review.resource);
      if (!known) installed = this.store.trustResource(installed.hash, true);
      // Installing again is how a person brings back a package they removed.
      const status = this.store.packageManagement(installed.hash);
      if (status.status === 'removed')
        this.store.managePackage(installed.hash, status.managementRevision, 'enabled');
      if (review.display) {
        const key = {
          resourceHash: installed.hash,
          entry: review.display.entry,
          kind: review.display.kind,
        };
        const current = this.store.entryManagement(key);
        this.store.manageEntry(
          key,
          current.managementRevision,
          current.archivedAt !== null,
          undefined,
          review.display.name,
        );
      }
      if (review.previous && review.previous.resourceHash !== installed.hash) {
        const saved = { ...review.previous, resourceHash: installed.hash };
        // Saving back to text saved before makes that entry the latest again
        // (skill-library.md item 7): it leaves the chain it pointed into.
        const restored = this.store.entryManagement(saved);
        if (restored.successor)
          this.store.manageEntry(
            saved,
            restored.managementRevision,
            restored.archivedAt !== null,
            null,
          );
        const current = this.store.entryManagement(review.previous);
        this.store.manageEntry(
          review.previous,
          current.managementRevision,
          current.archivedAt !== null,
          saved,
        );
      }
      if (review.previousPackageHash && review.previousPackageHash !== installed.hash) {
        const previous = this.store.getResource(review.previousPackageHash);
        const links = [
          ...(previous?.skills ?? []).flatMap((skill) => {
            const successor = installed.skills.find((next) => next.name === skill.name);
            return successor
              ? [{ entry: skill.entry, next: successor.entry, kind: 'skill' as const }]
              : [];
          }),
          ...(previous?.extensions ?? [])
            .filter((entry) => installed.extensions.includes(entry))
            .map((entry) => ({ entry, next: entry, kind: 'extension' as const })),
        ];
        for (const link of links) {
          const key = {
            resourceHash: review.previousPackageHash,
            entry: link.entry,
            kind: link.kind,
          };
          const current = this.store.entryManagement(key);
          this.store.manageEntry(key, current.managementRevision, current.archivedAt !== null, {
            resourceHash: installed.hash,
            entry: link.next,
            kind: link.kind,
          });
        }
      }
      this.reviews.delete(reviewId);
      return installed;
    });
  }

  trust(resourceHash: string, trusted: boolean) {
    if (trusted) this.verify(resourceHash);
    return this.store.trustResource(resourceHash, trusted);
  }

  /**
   * the built-in work style a session turn uses when none was chosen, so the lead in
   * a trusted folder can run commands and previews. The person's and project's defaults still
   * layer over it and may restrict it; an archived copy means the person turned it off.
   */
  sessionDefault(): HarnessBindingRef | null {
    const current = this.store
      .listProfiles()
      .find((profile) => profile.profileId === SESSION_DEFAULT_PROFILE);
    if (current && this.store.profileManagement(SESSION_DEFAULT_PROFILE).archivedAt) return null;
    const profile = current ?? this.saveProfile(SESSION_DEFAULT_PROFILE, 0, SESSION_DEFAULT);
    return { profileId: profile.profileId, revision: profile.revision };
  }

  saveProfile(profileId: string, expectedRevision: number, raw: HarnessProfile) {
    const profile = HarnessProfile.parse(raw);
    this.compose([
      {
        scope: 'role',
        profile: {
          ...profile,
          profileId,
          revision: expectedRevision + 1,
          createdAt: this.clock.nowIso(),
        },
      },
    ]);
    return this.store.saveProfile(profileId, expectedRevision, profile);
  }

  preview(
    binding: HarnessBindingRef,
    projectId: string,
    runOverride?: HarnessBindingRef,
  ): HarnessPreview;
  preview(
    role: HarnessPreviewRole,
    projectId: string,
    runOverride?: HarnessBindingRef,
  ): RoleHarnessPreview;
  preview(
    input: HarnessBindingRef | HarnessPreviewRole,
    projectId: string,
    runOverride?: HarnessBindingRef,
  ): RoleHarnessPreview {
    if ('profileId' in input) return this.resolveLayers(input, projectId, runOverride);
    try {
      const binding = roleBinding(input, runOverride);
      return binding
        ? this.resolveLayers(binding, projectId, runOverride, input)
        : { snapshot: null, problem: null };
    } catch (error) {
      if (error instanceof RoleHarnessResolutionError)
        return {
          snapshot: null,
          problem: error.problem,
          ...(error.mcpProblem ? { mcpProblem: error.mcpProblem } : {}),
        };
      throw error;
    }
  }

  private resolveLayers(
    binding: HarnessBindingRef,
    projectId: string,
    runOverride?: HarnessBindingRef,
    role?: HarnessPreviewRole,
    library = true,
  ) {
    const layers: {
      scope: 'personal' | 'project' | 'role' | 'run';
      profile: HarnessProfileRevision;
    }[] = [];
    for (const scope of ['personal', 'project'] as const) {
      const selection = this.store.getDefault(scope, scope === 'personal' ? 'default' : projectId);
      if (selection.binding) layers.push({ scope, profile: this.profile(selection.binding) });
    }
    layers.push({
      scope: 'role',
      profile: role && !role.harness ? this.minimalProfile() : this.profile(binding),
    });
    if (runOverride) layers.push({ scope: 'run', profile: this.profile(runOverride) });
    return this.compose(layers, binding, projectId, role, library);
  }

  private minimalProfile() {
    const stored = this.store.getProfile(ROLE_SKILLS_MINIMAL_BINDING);
    if (!stored)
      return this.store.saveProfile(ROLE_SKILLS_MINIMAL_BINDING.profileId, 0, MINIMAL_PROFILE_V1);
    // A pre-existing user profile may have used the same ID before the built-in existed.
    const { profileId: _id, revision: _revision, createdAt: _createdAt, ...policy } = stored;
    if (canonicalJson(policy) !== canonicalJson(MINIMAL_PROFILE_V1))
      throw new Error('invalid minimal role policy');
    return stored;
  }

  setDefault(
    scope: HarnessDefault['scope'],
    scopeId: string,
    expectedRevision: number,
    binding: HarnessBindingRef | null,
  ) {
    if (binding) {
      const layers: { scope: 'personal' | 'project'; profile: HarnessProfileRevision }[] = [];
      const personal = this.store.getDefault('personal', 'default').binding;
      if (scope === 'project' && personal)
        layers.push({ scope: 'personal', profile: this.profile(personal) });
      layers.push({ scope, profile: this.profile(binding) });
      this.compose(layers, binding, scope === 'project' ? scopeId : undefined);
    }
    return this.store.setDefault(scope, scopeId, expectedRevision, binding);
  }

  /** Only the exact server-generated, read-only fixture bypasses unrelated default resources. */
  sealEvaluationDefinition(raw: CorralDefinition) {
    const definition = CorralDefinition.parse(raw);
    const role = definition.roles[0];
    if (definition.roles.length !== 1 || !role?.harness)
      throw new Error('invalid evaluation definition');
    const profile = this.profile(role.harness);
    if (
      profile.policy !== 'strict' ||
      profile.startupCommands.length ||
      profile.allowedTools.some(
        (tool) => !['read', 'read_artifact', 'write_artifact', 'submit_result'].includes(tool),
      ) ||
      profile.resources.some((resource) => resource.kind !== 'skill') ||
      profile.resources.length > 1
    )
      throw new Error('invalid evaluation profile');
    const key = hash(canonicalJson(definition));
    this.evaluationDefinitions.set(key, role.harness);
    return () => this.evaluationDefinitions.delete(key);
  }

  /**
   * The session project's latest check configuration with exactly `checkIds` selected, for a
   * run's check Decisions (docs/specs/features/team-graph.md, "check 실행").
   */
  projectChecks(
    sessionId: string,
    checkIds: string[],
  ): NonNullable<EffectiveHarnessSnapshot['projectTools']> {
    const session = this.db
      .prepare('SELECT project_id FROM work_sessions WHERE id = ?')
      .get(sessionId) as { project_id: string } | undefined;
    if (!session) throw new Error('the work session does not exist');
    const config = this.projectTools.latest(session.project_id);
    if (!config || checkIds.some((id) => !config.checks.some((check) => check.id === id)))
      throw new Error('selected project tool is not registered');
    return {
      projectId: session.project_id,
      revision: config.revision,
      hash: config.hash,
      checkIds: [...new Set(checkIds)],
      lspServerIds: [],
    };
  }

  resolve(
    binding: HarnessBindingRef | undefined,
    definition: CorralDefinition,
    roleId: string,
    options?: { runOverride?: HarnessBindingRef; sessionId?: string; library?: false },
  ): EffectiveHarnessSnapshot | null {
    const selections = definition.roles.find((role) => role.id === roleId);
    const role = {
      id: roleId,
      harness: binding,
      skills: selections?.skills,
      mcpTools: selections?.mcpTools,
    };
    const base = roleBinding(role, options?.runOverride);
    if (!base) return null;
    const evaluation = this.evaluationDefinitions.get(hash(canonicalJson(definition)));
    // An evaluation compares fixed groups: it never receives library skills, with or without a
    // workspace session. A sealed definition also skips the person's and project's defaults.
    const sealed =
      evaluation !== undefined &&
      binding !== undefined &&
      canonicalJson(evaluation) === canonicalJson(binding);
    if (sealed && !options?.sessionId && !options?.runOverride)
      return this.compose(
        [{ scope: 'role', profile: this.profile(binding) }],
        binding,
        undefined,
        role,
      ).snapshot;
    const row = this.db.prepare('SELECT project_id FROM corrals WHERE id = ?').get(definition.id) as
      | { project_id: string }
      | undefined;
    const session = options?.sessionId
      ? (this.db
          .prepare('SELECT project_id FROM work_sessions WHERE id = ?')
          .get(options.sessionId) as { project_id: string } | undefined)
      : undefined;
    if (options?.sessionId && (!session || (row && row.project_id !== session.project_id)))
      throw new Error('harness project does not match session');
    return this.resolveLayers(
      base,
      session?.project_id ?? row?.project_id ?? 'default',
      options?.runOverride,
      role,
      !sealed && options?.library !== false,
    ).snapshot;
  }

  private profile(binding: HarnessBindingRef) {
    const profile = this.store.getProfile(binding);
    if (!profile) throw new Error('harness profile revision not found');
    return profile;
  }

  /**
   * `library` adds the other usable library skills (harness-contract, "그 밖에 쓸 수 있는 스킬"):
   * every role or binding resolution does, profile and default validation and evaluation runs do not.
   */
  private compose(
    layers: { scope: 'personal' | 'project' | 'role' | 'run'; profile: HarnessProfileRevision }[],
    binding?: HarnessBindingRef,
    projectId?: string,
    role?: HarnessPreviewRole,
    library = false,
  ) {
    const last = layers.at(-1)?.profile;
    if (!last) throw new Error('harness profile is missing');
    const policy = layers.some((layer) => layer.profile.policy === 'strict')
      ? 'strict'
      : 'trusted-native';
    let allowedTools = [...new Set(layers[0]?.profile.allowedTools ?? [])].filter((name) =>
      layers.every((layer) => layer.profile.allowedTools.includes(name)),
    );
    const selection = (key: 'checkIds' | 'lspServerIds' | 'mcpServerIds') => {
      const specified = layers.flatMap((layer) => (layer.profile[key] ? [layer.profile[key]] : []));
      return [...new Set(specified[0] ?? [])].filter((id) =>
        specified.every((ids) => ids.includes(id)),
      );
    };
    const checkIds = selection('checkIds'),
      lspServerIds = selection('lspServerIds');
    let mcpServerIds = selection('mcpServerIds');
    const config =
      projectId &&
      (checkIds.length || lspServerIds.length || mcpServerIds.length || role?.mcpTools?.length)
        ? this.projectTools.latest(projectId)
        : null;
    const enabledServer = (server: RegisteredMcpServer) =>
      server.enabled !== false &&
      (!server.sourcePackageHash ||
        this.store.packageManagement(server.sourcePackageHash).status === 'enabled');
    let mcpProblem: RoleMcpToolProblem | undefined;
    if (role?.mcpTools) {
      const tools: RoleMcpToolProblem['tools'] = [];
      const pickedNames = new Set<string>();
      const pickedServers = new Set<string>();
      for (const ref of role.mcpTools) {
        const server = config?.mcpServers?.find((s) => s.id === ref.serverId);
        let reason: RoleMcpToolProblemReason | undefined;
        if (!role.harness || policy === 'strict') reason = 'execution_policy_required';
        else if (!server) reason = 'server_missing';
        else if (!enabledServer(server)) reason = 'server_disabled';
        else if (!mcpServerIds.includes(ref.serverId)) reason = 'server_not_selected';
        else if (!allowedTools.includes(ref.name)) reason = 'tool_not_allowed';
        if (reason) tools.push({ ...ref, reason });
        else {
          pickedNames.add(ref.name);
          pickedServers.add(ref.serverId);
        }
      }
      if (tools.length) mcpProblem = { roleId: role.id, tools };
      mcpServerIds = mcpServerIds.filter((id) => pickedServers.has(id));
      allowedTools = allowedTools.filter(
        (name) => !isHarnessMcpTool(name) || pickedNames.has(name),
      );
    }
    if (policy === 'strict' && allowedTools.includes('codemode')) {
      if (mcpProblem) throw new RoleHarnessResolutionError(null, mcpProblem);
      throw new Error('codemode requires trusted-native policy');
    }
    let disabledMcp = false;
    if (mcpServerIds.length && policy === 'strict')
      throw new Error('MCP requires trusted-native policy');
    let projectTools: EffectiveHarnessSnapshot['projectTools'];
    if (projectId && (checkIds.length || lspServerIds.length || mcpServerIds.length)) {
      if (
        !config ||
        checkIds.some((id) => !config.checks.some((check) => check.id === id)) ||
        lspServerIds.some((id) => !config.lspServers.some((server) => server.id === id)) ||
        mcpServerIds.some((id) => !config.mcpServers?.some((server) => server.id === id))
      )
        throw new Error('selected project tool is not registered');
      const enabled = mcpServerIds.filter((id) => {
        const server = config.mcpServers?.find((server) => server.id === id);
        const available = server !== undefined && enabledServer(server);
        if (
          available &&
          server?.sourcePackageHash &&
          !this.verify(server.sourcePackageHash).trustedAt
        )
          throw new Error('package requires trust before MCP launch');
        return available;
      });
      disabledMcp = enabled.length !== mcpServerIds.length;
      mcpServerIds = enabled;
      projectTools = {
        projectId,
        revision: config.revision,
        hash: config.hash,
        checkIds,
        lspServerIds,
        ...(mcpServerIds.length ? { mcpServerIds } : {}),
      };
    }
    const picks = role?.skills && new Map(role.skills.map((ref) => [resourceKey(ref), ref]));
    const selected = new Map<string, HarnessProfile['resources'][number]>();
    for (const { profile } of layers)
      for (const resource of profile.resources) {
        const key = resourceKey(resource);
        const prior = selected.get(key);
        if (prior && prior.kind !== resource.kind) throw new Error('resource kind conflict');
        selected.set(key, {
          ...resource,
          required: resource.required || prior?.required === true,
          ...(resource.kind === 'skill'
            ? {
                skillMode:
                  prior?.skillMode === 'mandatory' || resource.skillMode === 'mandatory'
                    ? 'mandatory'
                    : picks?.has(key) && prior?.skillMode === 'explicit'
                      ? 'explicit'
                      : (resource.skillMode ?? 'auto'),
              }
            : {}),
        });
      }
    if (picks) {
      // A selection guarantees skills and removes none; a role without its own harness still
      // receives no optional default extension.
      if (!role?.harness)
        for (const [key, resource] of selected)
          if (resource.kind === 'extension' && !resource.required) selected.delete(key);
      for (const [key, ref] of picks) {
        if (!selected.has(key))
          selected.set(key, { ...ref, kind: 'skill', required: false, skillMode: 'auto' });
      }
    }
    // Required entries claim their names first, then picked ones; any other skill yields.
    const rank = (key: string, resource: HarnessProfile['resources'][number]) =>
      requiredResource(resource) ? 0 : picks?.has(key) ? 1 : 2;
    const ordered = [...selected].sort(([ka, a], [kb, b]) => rank(ka, a) - rank(kb, b));
    const resources: EffectiveHarnessSnapshot['resources'] = [];
    const sections: { source: 'skill'; name: string; text: string }[] = [];
    const names = new Map<string, string>();
    const problems = new Map<string, RoleSkillProblem['entries'][number]['reason']>();
    const verified = new Map<string, HarnessResourceView>();
    const diagnostics: string[] = [];
    if (disabledMcp) diagnostics.push('mcp_server_disabled');
    let needsExecutionPolicy = false;
    let mandatoryBytes = 0;
    for (const [key, selectedResource] of ordered) {
      const picked = picks?.has(key);
      // An optional skill nobody picked never blocks a start: when it cannot be used it is left out.
      const loose =
        !picked && selectedResource.kind === 'skill' && !requiredResource(selectedResource);
      if (picked && selectedResource.kind !== 'skill') {
        problems.set(key, 'missing');
        continue;
      }
      const status = this.store.packageManagement(selectedResource.resourceHash).status;
      if (status !== 'enabled') {
        if (picked) {
          problems.set(key, status === 'removed' ? 'missing' : 'disabled');
          continue;
        }
        if (requiredResource(selectedResource))
          throw new Error('required package is disabled or removed');
        diagnostics.push('package_disabled');
        continue;
      }
      let resource = verified.get(selectedResource.resourceHash);
      if (!resource) {
        try {
          resource = this.verify(selectedResource.resourceHash);
        } catch (error) {
          if (loose && error instanceof ResourceVerificationError) continue;
          if (!picked || !(error instanceof ResourceVerificationError)) throw error;
          problems.set(key, error.reason);
          continue;
        }
        verified.set(resource.hash, resource);
      }
      if (!resource.trustedAt) {
        if (loose) continue;
        if (!picked) throw new Error('resource requires trust before binding');
        problems.set(key, 'untrusted');
        continue;
      }
      if (selectedResource.kind === 'extension') {
        if (policy === 'strict') {
          if (!role || role.harness) throw new Error('strict policy refuses native extensions');
          needsExecutionPolicy = true;
          continue;
        }
        if (!resource.extensions.includes(selectedResource.entry))
          throw new Error('unknown extension entry');
      } else {
        const skill = resource.skills.find((skill) => skill.entry === selectedResource.entry);
        if (!skill) {
          if (loose) continue;
          if (!picked) throw new Error('unknown or duplicate skill name');
          problems.set(key, 'missing');
          continue;
        }
        const priorKey = names.get(skill.name);
        if (priorKey && loose) continue;
        if (priorKey) {
          const prior = selected.get(priorKey)!;
          const conflict = [priorKey, key].filter((candidate) => picks?.has(candidate));
          if (!conflict.length) throw new Error('unknown or duplicate skill name');
          // A required original stays usable: flag the other hash the role selected.
          const optional = conflict.filter(
            (candidate) => !requiredResource(selected.get(candidate)!),
          );
          for (const candidate of optional.length ? optional : conflict)
            problems.set(candidate, 'name_conflict');
          if (!requiredResource(prior) && requiredResource(selectedResource))
            names.set(skill.name, key);
        } else names.set(skill.name, key);
        if (selectedResource.skillMode === 'mandatory') {
          const body = readFileSync(join(this.directory(resource.hash), skill.entry));
          mandatoryBytes += body.length;
          if (body.length > MAX_SKILL_BYTES || mandatoryBytes > 128 * 1024)
            throw new Error('mandatory skill size limit exceeded');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
          if (!text.trim()) throw new Error('mandatory skill body is empty');
          sections.push({ source: 'skill', name: skill.name, text });
        }
      }
      resources.push({
        hash: resource.hash,
        name: resource.name,
        version: resource.version,
        kind: selectedResource.kind,
        required: selectedResource.required || selectedResource.skillMode === 'mandatory',
        ...(picked ? { selectedByRole: true as const } : {}),
        entry: selectedResource.entry,
        ...(selectedResource.kind === 'skill'
          ? {
              skillMode: selectedResource.skillMode ?? 'auto',
              skillName: resource.skills.find((skill) => skill.entry === selectedResource.entry)
                ?.name,
            }
          : {}),
      });
    }
    if (library && !problems.size && !needsExecutionPolicy) {
      const room = Math.max(0, MAX_SNAPSHOT_RESOURCES - resources.length);
      const { skills, truncated } = this.librarySkills(names, selected, verified, room);
      resources.push(...skills);
      if (truncated) diagnostics.push('library_skills_truncated');
    }
    if (role && picks && (problems.size || needsExecutionPolicy)) {
      const entries = [...picks].flatMap(([key, ref]) => {
        const reason = problems.get(key);
        return reason ? [{ ...ref, reason }] : [];
      });
      throw new RoleHarnessResolutionError(
        {
          roleId: role.id,
          reason: needsExecutionPolicy ? 'execution_policy_required' : 'unusable_skills',
          entries,
        },
        mcpProblem,
      );
    }
    if (mcpProblem) throw new RoleHarnessResolutionError(null, mcpProblem);
    if (resources.some((resource) => resource.kind === 'extension'))
      diagnostics.push('native_code_unmanaged', 'extension_prompt_determined_at_runtime');
    const tools = staticToolDescriptors(allowedTools, projectTools);
    const dynamic =
      resources.some((resource) => resource.kind === 'extension') ||
      allowedTools.some((name) => !tools.some((tool) => tool.name === name));
    const permissionPolicies = layers.flatMap((layer) =>
      layer.profile.permissionPolicy ? [layer.profile.permissionPolicy] : [],
    );
    const resolved = {
      ...(permissionPolicies.length ? { permissionPolicies } : {}),
      ...(role && !role.harness ? { startupCommandPolicy: 'none' as const } : {}),
      binding: binding ?? { profileId: last.profileId, revision: last.revision },
      piVersion: '1.3.0' as const,
      policyRevision: permissionPolicies.length ? 2 : 1,
      policy,
      resources,
      allowedTools,
      tools,
      diagnostics,
      ...(projectTools ? { projectTools } : {}),
      layers: layers.map(({ scope, profile }) => ({
        scope,
        binding: { profileId: profile.profileId, revision: profile.revision },
      })),
    };
    const snapshot = EffectiveHarnessSnapshot.parse({
      ...resolved,
      snapshotHash: hash(canonicalJson(resolved)),
    });
    return {
      snapshot,
      sections,
      dynamic,
    };
  }

  /**
   * The usable library skills whose internal name no bound skill has: one per name, preferring
   * an entry with no successor, then the most recently installed. Unusable entries are skipped.
   * Only `room` entries are kept, those of the most recently installed packages first.
   */
  private librarySkills(
    names: ReadonlyMap<string, string>,
    selected: ReadonlyMap<string, unknown>,
    verified: Map<string, HarnessResourceView>,
    room: number,
  ): { skills: EffectiveHarnessSnapshot['resources']; truncated: boolean } {
    const order = this.store.installOrder();
    const candidates = new Map<
      string,
      { resource: HarnessResourceView; skill: HarnessResource['skills'][number]; next: boolean }[]
    >();
    for (const hash of order) {
      if (this.store.packageManagement(hash).status !== 'enabled') continue;
      const resource = this.store.getResource(hash);
      if (!resource?.trustedAt) continue;
      for (const skill of resource.skills) {
        if (names.has(skill.name) || selected.has(resourceKey({ resourceHash: hash, ...skill })))
          continue;
        const state = this.store.entryManagement({
          resourceHash: hash,
          entry: skill.entry,
          kind: 'skill',
        });
        if (state.archivedAt) continue;
        const list = candidates.get(skill.name) ?? [];
        list.push({ resource, skill, next: state.successor !== null });
        candidates.set(skill.name, list);
      }
    }
    const failed = new Set<string>();
    const usable = (hash: string) => {
      if (verified.has(hash)) return true;
      if (failed.has(hash)) return false;
      try {
        verified.set(hash, this.verify(hash));
        return true;
      } catch {
        failed.add(hash);
        return false;
      }
    };
    const chosen: (EffectiveHarnessSnapshot['resources'][number] & { recency: number })[] = [];
    for (const name of [...candidates.keys()].sort()) {
      // Install order is kept within each group by the stable sort.
      const list = candidates.get(name)!.sort((a, b) => Number(a.next) - Number(b.next));
      const pick = list.find(({ resource }) => usable(resource.hash));
      if (!pick) continue;
      chosen.push({
        hash: pick.resource.hash,
        name: pick.resource.name,
        version: pick.resource.version,
        kind: 'skill',
        required: false,
        library: true,
        entry: pick.skill.entry,
        skillMode: pick.skill.disableModelInvocation ? 'explicit' : 'auto',
        skillName: pick.skill.name,
        recency: order.indexOf(pick.resource.hash),
      });
    }
    // Cut by install recency, then keep the name order `chosen` was built in.
    const fits = new Set(chosen.toSorted((a, b) => a.recency - b.recency).slice(0, room));
    const kept = chosen.filter((skill) => fits.has(skill));
    return {
      skills: kept.map(({ recency: _recency, ...skill }) => skill),
      truncated: kept.length < chosen.length,
    };
  }

  private verify(resourceHash: string): HarnessResourceView {
    const resource = this.store.getResource(resourceHash);
    if (!resource) throw new ResourceVerificationError('missing', 'resource not installed');
    try {
      if (treeHash(scan(this.directory(resourceHash))) !== resourceHash)
        throw new Error('resource changed');
      const manifest = inspectPackageManifest(this.directory(resourceHash), resource.packagePath);
      this.checkEntries(resource, Boolean(manifest?.mcpServers.length || manifest?.ui.length));
    } catch {
      this.store.trustResource(resourceHash, false);
      throw new ResourceVerificationError(
        'untrusted',
        'resource integrity changed; review and trust the new content',
      );
    }
    return resource;
  }

  private checkEntries(resource: HarnessResource, hasDeclarations = false) {
    const paths = new Set(resource.files.map((file) => file.path));
    for (const path of [...resource.extensions, ...resource.skills.map((skill) => skill.entry)]) {
      ResourcePath.parse(path);
      if (!paths.has(path)) throw new Error('resource entry is missing');
    }
    if (!resource.extensions.length && !resource.skills.length && !hasDeclarations)
      throw new Error('package contains no supported skills or extensions');
  }

  private directory(hash: string) {
    return join(this.root, 'resources', `sha256-${hash}`);
  }
  private expireReviews() {
    for (const [id, review] of this.reviews)
      if (review.expiresAt <= this.clock.monotonicMs()) {
        rmSync(review.directory, { recursive: true, force: true });
        this.reviews.delete(id);
      }
  }
  dispose() {
    for (const review of this.reviews.values())
      rmSync(review.directory, { recursive: true, force: true });
    this.reviews.clear();
  }
}
