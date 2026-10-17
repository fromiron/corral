import { createHash } from 'node:crypto';
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
import { downloadPiPackage, inspectPiPackage, type SdkResources } from '@corral/adapter-pi';
import {
  type AgentStartInput,
  type Clock,
  type CorralDefinition,
  canonicalJson,
  EffectiveHarnessSnapshot,
  type HarnessBindingRef,
  type HarnessDefault,
  HarnessProfile,
  type HarnessProfileRevision,
  HarnessResource,
  type HarnessResourceView,
  type PackageInspection,
  PinnedPackageSource,
  ResourcePath,
} from '@corral/contracts';
import { type Db, SqliteHarnessStore } from '@corral/storage-sqlite';

interface ResourceReview {
  reviewId: string;
  resource: HarnessResource;
  directory: string;
  expiresAt: number;
}
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SKILL_BYTES = 64 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const treeHash = (files: HarnessResource['files']) => hash(canonicalJson(files));

/** Resource discovery and preview read bytes only. Execution imports happen in the Pi worker. */
export class HarnessService {
  readonly store: SqliteHarnessStore;
  private readonly root: string;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly inspect: (directory: string) => Promise<PackageInspection>;
  private readonly download: (source: string, directory: string) => Promise<PackageInspection>;
  private readonly reviews = new Map<string, ResourceReview>();

  constructor(options: {
    root: string;
    db: Db;
    clock: Clock;
    inspect?: (directory: string) => Promise<PackageInspection>;
    download?: (source: string, directory: string) => Promise<PackageInspection>;
  }) {
    this.root = resolve(options.root);
    this.db = options.db;
    this.clock = options.clock;
    this.inspect = options.inspect ?? inspectPiPackage;
    this.download = options.download ?? downloadPiPackage;
    this.store = new SqliteHarnessStore(options.db, options.clock);
    mkdirSync(join(this.root, 'reviews'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, 'resources'), { recursive: true, mode: 0o700 });
  }

  async discoverLocal(source: string) {
    this.expireReviews();
    const original = realpathSync(source);
    if (
      !statSync(original).isDirectory() ||
      inside(original, this.root) ||
      inside(this.root, original)
    )
      throw new Error('choose a resource directory outside Corral data');
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
      this.checkEntries(resource);
      const reviewId = `review_${resource.hash}`;
      const existing = this.reviews.get(reviewId);
      if (existing) {
        rmSync(directory, { recursive: true, force: true });
        return { reviewId, resource: existing.resource };
      }
      this.reviews.set(reviewId, {
        reviewId,
        resource,
        directory,
        expiresAt: this.clock.monotonicMs() + 30 * 60_000,
      });
      return { reviewId, resource };
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
      this.checkEntries(resource);
      const reviewId = `review_${resource.hash}`;
      const existing = this.reviews.get(reviewId);
      if (existing) {
        rmSync(directory, { recursive: true, force: true });
        return { reviewId, resource: existing.resource };
      }
      this.reviews.set(reviewId, {
        reviewId,
        resource,
        directory,
        expiresAt: this.clock.monotonicMs() + 30 * 60_000,
      });
      return { reviewId, resource };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(downloaded, { recursive: true, force: true });
    }
  }

  async runtimeResources(
    input: Pick<AgentStartInput, 'harness' | 'inputs'>,
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
        const explicit = input.inputs.some((input) => input.text.includes(`/skill:${skill.name}`));
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
    return resources;
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
    };
  }

  install(reviewId: string): HarnessResourceView {
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
    this.reviews.delete(reviewId);
    return installed;
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
    return this.compose(layers, binding);
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
      this.compose(layers, binding);
    }
    return this.store.setDefault(scope, scopeId, expectedRevision, binding);
  }

  resolve(
    binding: HarnessBindingRef,
    definition: CorralDefinition,
    _roleId: string,
  ): EffectiveHarnessSnapshot {
    const row = this.db.prepare('SELECT project_id FROM corrals WHERE id = ?').get(definition.id) as
      | { project_id: string }
      | undefined;
    return this.preview(binding, row?.project_id ?? 'default').snapshot;
  }

  private profile(binding: HarnessBindingRef) {
    const profile = this.store.getProfile(binding);
    if (!profile) throw new Error('harness profile revision not found');
    return profile;
  }

  private compose(
    layers: { scope: 'personal' | 'project' | 'role' | 'run'; profile: HarnessProfileRevision }[],
    binding?: HarnessBindingRef,
  ) {
    const last = layers.at(-1)?.profile;
    if (!last) throw new Error('harness profile is missing');
    const policy = layers.some((layer) => layer.profile.policy === 'strict')
      ? 'strict'
      : 'trusted-native';
    const allowedTools = [...new Set(layers[0]?.profile.allowedTools ?? [])].filter((name) =>
      layers.every((layer) => layer.profile.allowedTools.includes(name)),
    );
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
    const resolved = {
      binding: binding ?? { profileId: last.profileId, revision: last.revision },
      piVersion: '1.3.0' as const,
      policyRevision: 1,
      policy,
      resources,
      allowedTools,
      tools: [],
      diagnostics,
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
      dynamic: resources.some((resource) => resource.kind === 'extension'),
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
