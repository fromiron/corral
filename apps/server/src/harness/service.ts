import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  type CorralDefinition,
  canonicalJson,
  EffectiveHarnessSnapshot,
  type HarnessBindingRef,
  type HarnessDefault,
  HarnessDocumentDraft,
  HarnessEntryKey,
  type HarnessEntryView,
  HarnessProfile,
  type HarnessProfileRevision,
  HarnessPublish,
  HarnessResource,
  type HarnessResourceView,
  ManagedHook,
  McpServerDraft,
  type PackageInspection,
  PinnedPackageSource,
  RegisteredMcpServer,
  ResourcePath,
} from '@corral/contracts';
import { type Db, SqliteHarnessStore, SqliteProjectToolStore } from '@corral/storage-sqlite';
import builtinManifest from '../../resources/builtin/manifest.json' with { type: 'json' };
import { managedHookSource } from './managed-hook.ts';
import type { McpService } from './mcp-service.ts';

interface ResourceReview {
  reviewId: string;
  resource: HarnessResource;
  directory: string;
  expiresAt: number;
  previous?: HarnessEntryKey;
  display?: { entry: string; kind: HarnessEntryKey['kind']; name: string };
}
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SKILL_BYTES = 64 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const treeHash = (files: HarnessResource['files']) => hash(canonicalJson(files));

/** Resource discovery and preview read bytes only. Execution imports happen in the Pi worker. */
export class HarnessService {
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

  constructor(options: {
    root: string;
    newId?: () => string;
    mcp?: McpService;
    db: Db;
    clock: Clock;
    inspect?: (directory: string) => Promise<PackageInspection>;
    download?: (source: string, directory: string) => Promise<PackageInspection>;
  }) {
    this.root = resolve(options.root);
    this.newId = options.newId ?? randomUUID;
    this.mcp = options.mcp;
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
    return this.store.listResources().flatMap((resource) =>
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
  ) {
    const draft = McpServerDraft.parse(raw);
    if (!this.mcp) throw new Error('MCP runtime unavailable');
    return this.mcp.updateTools(
      projectId,
      expectedRevision,
      () => {
        const config = this.projectTools.latest(projectId);
        const previous = config?.mcpServers?.find((server) => server.id === serverId);
        if (serverId && !previous) throw new Error('no such registered tool');
        const server = RegisteredMcpServer.parse({
          ...draft,
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
          mcpServers: [
            ...(config?.mcpServers ?? []).filter((item) => item.id !== server.id),
            server,
          ],
        };
      },
      {
        operationId,
        input: { projectId, expectedRevision, draft, ...(serverId ? { serverId } : {}) },
      },
    );
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

  async discoverBuiltin(id: string) {
    if (!Object.hasOwn(builtinManifest, id)) throw new Error('unknown built-in pack');
    const manifest = builtinManifest[id as keyof typeof builtinManifest];
    const source = fileURLToPath(new URL(`../../resources/builtin/${id}/`, import.meta.url));
    const review = await this.discoverLocal(source);
    if (
      review.resource.hash !== manifest.hash ||
      review.resource.skills.length !== manifest.skills ||
      review.resource.extensions.length
    ) {
      this.cancelReview(review.reviewId);
      throw new Error('built-in pack integrity changed');
    }
    review.resource.sourceLabel = manifest.source;
    return review;
  }

  async discoverLocal(source: string) {
    this.expireReviews();
    const original = this.sourceDirectory(source);
    const directory = mkdtempSync(join(this.root, 'reviews', 'copy-'));
    try {
      const files = scan(original, directory);
      const inspection = await this.inspect(directory);
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
    this.checkEntries(resource);
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
    for (const ref of input.harness.resources) {
      const resource = this.verify(ref.hash);
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
    for (const layer of input.harness.layers ?? [
      { scope: 'role', binding: input.harness.binding },
    ]) {
      resources.startupCommands.push(...this.profile(layer.binding).startupCommands);
    }
    if (resources.startupCommands.length > 16) throw new Error('too many startup commands');
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
      boundSkills: snapshot.resources
        .filter((resource) => resource.kind === 'skill' && resource.skillName && resource.entry)
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
      const installed = this.store.putResource(review.resource);
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
        const current = this.store.entryManagement(review.previous);
        this.store.manageEntry(
          review.previous,
          current.managementRevision,
          current.archivedAt !== null,
          { ...review.previous, resourceHash: installed.hash },
        );
      }
      this.reviews.delete(reviewId);
      return installed;
    });
  }

  trust(resourceHash: string, trusted: boolean) {
    if (trusted) this.verify(resourceHash);
    return this.store.trustResource(resourceHash, trusted);
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

  preview(binding: HarnessBindingRef, projectId: string, runOverride?: HarnessBindingRef) {
    const layers: {
      scope: 'personal' | 'project' | 'role' | 'run';
      profile: HarnessProfileRevision;
    }[] = [];
    for (const scope of ['personal', 'project'] as const) {
      const selection = this.store.getDefault(scope, scope === 'personal' ? 'default' : projectId);
      if (selection.binding) layers.push({ scope, profile: this.profile(selection.binding) });
    }
    layers.push({ scope: 'role', profile: this.profile(binding) });
    if (runOverride) layers.push({ scope: 'run', profile: this.profile(runOverride) });
    return this.compose(layers, binding, projectId);
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

  resolve(
    binding: HarnessBindingRef,
    definition: CorralDefinition,
    _roleId: string,
    options?: { runOverride?: HarnessBindingRef; sessionId?: string },
  ): EffectiveHarnessSnapshot {
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
    return this.preview(
      binding,
      session?.project_id ?? row?.project_id ?? 'default',
      options?.runOverride,
    ).snapshot;
  }

  private profile(binding: HarnessBindingRef) {
    const profile = this.store.getProfile(binding);
    if (!profile) throw new Error('harness profile revision not found');
    return profile;
  }

  private compose(
    layers: { scope: 'personal' | 'project' | 'role' | 'run'; profile: HarnessProfileRevision }[],
    binding?: HarnessBindingRef,
    projectId?: string,
  ) {
    const last = layers.at(-1)?.profile;
    if (!last) throw new Error('harness profile is missing');
    const policy = layers.some((layer) => layer.profile.policy === 'strict')
      ? 'strict'
      : 'trusted-native';
    const allowedTools = [...new Set(layers[0]?.profile.allowedTools ?? [])].filter((name) =>
      layers.every((layer) => layer.profile.allowedTools.includes(name)),
    );
    if (policy === 'strict' && allowedTools.includes('codemode'))
      throw new Error('codemode requires trusted-native policy');
    const selection = (key: 'checkIds' | 'lspServerIds' | 'mcpServerIds') => {
      const specified = layers.flatMap((layer) => (layer.profile[key] ? [layer.profile[key]] : []));
      return [...new Set(specified[0] ?? [])].filter((id) =>
        specified.every((ids) => ids.includes(id)),
      );
    };
    const checkIds = selection('checkIds'),
      lspServerIds = selection('lspServerIds');
    let mcpServerIds = selection('mcpServerIds');
    let disabledMcp = false;
    if (mcpServerIds.length && policy === 'strict')
      throw new Error('MCP requires trusted-native policy');
    let projectTools: EffectiveHarnessSnapshot['projectTools'];
    if (projectId && (checkIds.length || lspServerIds.length || mcpServerIds.length)) {
      const config = this.projectTools.latest(projectId);
      if (
        !config ||
        checkIds.some((id) => !config.checks.some((check) => check.id === id)) ||
        lspServerIds.some((id) => !config.lspServers.some((server) => server.id === id)) ||
        mcpServerIds.some((id) => !config.mcpServers?.some((server) => server.id === id))
      )
        throw new Error('selected project tool is not registered');
      const enabled = mcpServerIds.filter(
        (id) => config.mcpServers?.find((server) => server.id === id)?.enabled !== false,
      );
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
    const selected = new Map<string, HarnessProfile['resources'][number]>();
    for (const { profile } of layers)
      for (const resource of profile.resources) {
        const key = `${resource.resourceHash}:${resource.entry}`;
        const prior = selected.get(key);
        if (prior && prior.kind !== resource.kind) throw new Error('resource kind conflict');
        selected.set(key, {
          ...resource,
          required: resource.required || prior?.required === true,
          ...(resource.kind === 'skill'
            ? {
                skillMode:
                  prior?.skillMode === 'mandatory' ? 'mandatory' : (resource.skillMode ?? 'auto'),
              }
            : {}),
        });
      }
    const resources: EffectiveHarnessSnapshot['resources'] = [];
    const sections: { source: 'skill'; name: string; text: string }[] = [];
    const names = new Set<string>();
    const diagnostics: string[] = [];
    if (disabledMcp) diagnostics.push('mcp_server_disabled');
    let mandatoryBytes = 0;
    for (const selectedResource of selected.values()) {
      const resource = this.verify(selectedResource.resourceHash);
      if (!resource.trustedAt) throw new Error('resource requires trust before binding');
      if (selectedResource.kind === 'extension') {
        if (policy === 'strict') throw new Error('strict policy refuses native extensions');
        if (!resource.extensions.includes(selectedResource.entry))
          throw new Error('unknown extension entry');
      } else {
        const skill = resource.skills.find((skill) => skill.entry === selectedResource.entry);
        if (!skill || names.has(skill.name)) throw new Error('unknown or duplicate skill name');
        names.add(skill.name);
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

  private verify(resourceHash: string): HarnessResourceView {
    const resource = this.store.getResource(resourceHash);
    if (!resource) throw new Error('resource not installed');
    try {
      if (treeHash(scan(this.directory(resourceHash))) !== resourceHash)
        throw new Error('resource changed');
      this.checkEntries(resource);
    } catch {
      this.store.trustResource(resourceHash, false);
      throw new Error('resource integrity changed; review and trust the new content');
    }
    return resource;
  }

  private checkEntries(resource: HarnessResource) {
    const paths = new Set(resource.files.map((file) => file.path));
    for (const path of [...resource.extensions, ...resource.skills.map((skill) => skill.entry)]) {
      ResourcePath.parse(path);
      if (!paths.has(path)) throw new Error('resource entry is missing');
    }
    if (!resource.extensions.length && !resource.skills.length)
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

function inside(root: string, target: string) {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

/** Dereference only internal links, and hash exactly the bytes copied for review. */
function scan(root: string, copyTo?: string): HarnessResource['files'] {
  const base = realpathSync(root);
  const files: HarnessResource['files'] = [];
  let bytes = 0;
  const walk = (folder: string, prefix: string, ancestors: Set<string>) => {
    const actual = realpathSync(folder);
    if (!inside(base, actual)) throw new Error('resource link points outside its root');
    if (ancestors.has(actual)) throw new Error('resource link cycle');
    const next = new Set([...ancestors, actual]);
    for (const name of readdirSync(folder).sort()) {
      if (name === '.git') continue;
      if (
        name === '.corral' ||
        name === '.npmrc' ||
        /^\.env(?:\.|$)/.test(name) ||
        ['auth.json', 'credentials.json'].includes(name)
      )
        throw new Error('resource contains private configuration');
      const path = prefix ? `${prefix}/${name}` : name;
      ResourcePath.parse(path);
      const source = join(folder, name);
      if (!inside(base, realpathSync(source)))
        throw new Error('resource link points outside its root');
      const info = statSync(source);
      if (info.isDirectory()) {
        walk(source, path, next);
        continue;
      }
      if (!info.isFile()) throw new Error('resource contains a non-file entry');
      if (files.length >= 10_000 || bytes + info.size > MAX_RESOURCE_BYTES)
        throw new Error('resource size limit exceeded');
      const body = readFileSync(source);
      bytes += body.length;
      if (bytes > MAX_RESOURCE_BYTES) throw new Error('resource size limit exceeded');
      if (copyTo) {
        const destination = join(copyTo, path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, body, { mode: info.mode & 0o100 ? 0o700 : 0o600 });
      }
      files.push({ path, hash: hash(body), bytes: body.length });
    }
  };
  walk(base, '', new Set());
  return files;
}
