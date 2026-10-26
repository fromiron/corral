import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessProfile } from '@corral/contracts';
import { type Db, openDatabase, SqliteProjectToolStore } from '@corral/storage-sqlite';
import { FakeClock, linearCorral } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessService } from '../src/harness/service.ts';

const roots: string[] = [];
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(
  body = '---\nname: writing\ndescription: Write clearly.\n---\nKeep sources.',
  download?: ConstructorParameters<typeof HarnessService>[0]['download'],
) {
  const root = mkdtempSync(join(tmpdir(), 'corral-harness-store-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(join(source, 'extensions'), { recursive: true });
  mkdirSync(join(source, 'skills/writing'), { recursive: true });
  const marker = join(root, 'EXECUTED');
  writeFileSync(
    join(source, 'extensions/echo.ts'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected'); export default () => {};`,
  );
  writeFileSync(join(source, 'skills/writing/SKILL.md'), body);
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      license: 'MIT',
      pi: { extensions: ['extensions/echo.ts'], skills: ['skills'] },
    }),
  );
  const db = openDatabase(':memory:');
  databases.push(db);
  const resourceRoot = join(root, 'data');
  const service = new HarnessService({
    root: resourceRoot,
    db,
    clock: new FakeClock(),
    ...(download ? { download } : {}),
    inspect: async () => ({
      name: 'fixture',
      version: '1.0.0',
      license: 'MIT',
      packagePath: null,
      extensions: ['extensions/echo.ts'],
      skills: [
        { name: 'writing', description: 'Write clearly.', entry: 'skills/writing/SKILL.md' },
      ],
    }),
  });
  const profile = (hash: string): HarnessProfile => ({
    name: 'Writer',
    policy: 'trusted-native',
    allowedTools: ['echo'],
    startupCommands: [],
    resources: [
      { resourceHash: hash, entry: 'extensions/echo.ts', kind: 'extension', required: true },
      {
        resourceHash: hash,
        entry: 'skills/writing/SKILL.md',
        kind: 'skill',
        required: true,
        skillMode: 'mandatory',
      },
    ],
  });
  return { service, db, source, marker, resourceRoot, profile };
}

describe('resource discovery, trust and resolution (H3)', () => {
  it('rejects unsupported package manifests during every review path without executing them', async () => {
    const s = setup();
    const file = join(s.source, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(
      file,
      JSON.stringify({ ...manifest, corral: { version: 1, rendererJavaScript: 'alert(1)' } }),
    );
    await expect(s.service.discoverLocal(s.source)).rejects.toThrow();
    expect(existsSync(s.marker)).toBe(false);
    expect(s.service.store.listResources()).toHaveLength(0);
  });
  it('keeps pinned bytes usable while package disable and removal affect future bindings only', async () => {
    const s = setup();
    const review = await s.service.reviewPackage('local', s.source);
    const installed = s.service.install(review.reviewId);
    expect(installed.trustedAt).toBeNull();
    s.service.trust(installed.hash, true);
    const profile = s.service.saveProfile('package-test', 0, s.profile(installed.hash));
    const binding = { profileId: profile.profileId, revision: profile.revision };
    const pinned = s.service.preview(binding, 'default').snapshot;
    const disabled = await s.service.managePackage(
      installed.hash,
      0,
      'disabled',
      'disable_package',
    );
    expect(disabled.status).toBe('disabled');
    expect(() => s.service.preview(binding, 'default')).toThrow(
      'required package is disabled or removed',
    );
    expect(await s.service.runtimeResources({ harness: pinned, inputs: [] })).toMatchObject({
      extensions: [expect.objectContaining({ hash: installed.hash })],
    });
    expect(await s.service.managePackage(installed.hash, 0, 'disabled', 'disable_package')).toEqual(
      disabled,
    );
    await expect(
      s.service.managePackage(installed.hash, 0, 'enabled', 'stale_package'),
    ).rejects.toThrow('management revision changed');
    const removed = await s.service.managePackage(installed.hash, 1, 'removed', 'remove_package');
    expect(removed.status).toBe('removed');
    expect(s.service.entries()).toHaveLength(0);
    expect(s.service.store.getResource(installed.hash)).not.toBeNull();
    expect(await s.service.runtimeResources({ harness: pinned, inputs: [] })).toMatchObject({
      extensions: [expect.objectContaining({ hash: installed.hash })],
    });
    await s.service.managePackage(installed.hash, 2, 'enabled', 'restore_package');
    expect(s.service.preview(binding, 'default').snapshot.resources).toEqual(pinned.resources);
    expect(existsSync(s.marker)).toBe(false);
  });
  it('reviews an upgrade by immutable file diff and never carries trust into changed bytes', async () => {
    const s = setup();
    const original = s.service.install((await s.service.reviewPackage('local', s.source)).reviewId);
    s.service.trust(original.hash, true);
    writeFileSync(join(s.source, 'extensions/echo.ts'), 'export default () => {};');
    const updated = await s.service.reviewPackage('local', s.source, original.hash);
    expect(updated.previous?.hash).toBe(original.hash);
    expect(updated.changes).toEqual({ added: [], removed: [], changed: ['extensions/echo.ts'] });
    const saved = s.service.install(updated.reviewId);
    expect(saved.hash).not.toBe(original.hash);
    expect(saved.trustedAt).toBeNull();
    expect(s.service.store.getResource(original.hash)?.trustedAt).not.toBeNull();
    expect(
      s.service.store.entryManagement({
        resourceHash: original.hash,
        entry: 'extensions/echo.ts',
        kind: 'extension',
      }).successor,
    ).toEqual({ resourceHash: saved.hash, entry: 'extensions/echo.ts', kind: 'extension' });
  });
  it('cancellation belongs to a review operation, not shared content', async () => {
    const s = setup();
    const a = await s.service.discoverLocal(s.source);
    const b = await s.service.discoverLocal(s.source);
    expect(a.resource.hash).toBe(b.resource.hash);
    expect(a.reviewId).not.toBe(b.reviewId);
    s.service.cancelReview(a.reviewId);
    const saved = s.service.install(b.reviewId);
    expect(s.service.install(b.reviewId)).toEqual(saved);
    const c = await s.service.discoverLocal(s.source);
    s.service.cancelReview(a.reviewId);
    expect(s.service.install(c.reviewId).hash).toBe(saved.hash);
  });
  it('a deleted project server cannot be published into a new default', () => {
    const { service } = setup();
    const server = {
      id: 'docs',
      name: 'Docs',
      transport: 'http' as const,
      url: 'https://example.invalid/mcp',
      timeoutMs: 1000,
      exposure: 'direct' as const,
      auth: { kind: 'none' as const },
    };
    service.projectTools.save('default', 0, { checks: [], lspServers: [], mcpServers: [server] });
    service.projectTools.save('default', 1, { checks: [], lspServers: [], mcpServers: [] });
    expect(() =>
      service.publish({
        operationId: 'stale-project',
        profileId: 'new-profile',
        expectedRevision: 0,
        profile: {
          name: 'MCP',
          policy: 'trusted-native',
          allowedTools: [],
          resources: [],
          startupCommands: [],
          mcpServerIds: ['docs'],
        },
        target: { scope: 'project', scopeId: 'default', expectedRevision: 0, binding: null },
      }),
    ).toThrow('selected project tool is not registered');
    expect(service.store.listProfiles()).toHaveLength(0);
    expect(service.store.getDefault('project', 'default').revision).toBe(0);
  });
  // Several real inspection workers run sequentially; keep the product's per-worker bound.
  it('validates actual standalone documents and round-trips generated hooks without executing source', async () => {
    const s = setup();
    const service = new HarnessService({ root: s.resourceRoot, db: s.db, clock: new FakeClock() });
    const review = await service.reviewDocument({
      kind: 'skill',
      name: '문서 검토',
      content:
        '---\nname: audit-check\ndescription: Check the result.\ncustom: keep-me\n---\nRead the receipt.',
    });
    const skill = service.install(review.reviewId);
    expect(service.entries().find((entry) => entry.resourceHash === skill.hash)?.name).toBe(
      '문서 검토',
    );
    expect(
      service.readEntry({ resourceHash: skill.hash, kind: 'skill', entry: 'skills/SKILL.md' })
        .content,
    ).toContain('custom: keep-me');
    await expect(
      service.reviewDocument({ kind: 'skill', name: 'Bad', content: 'no frontmatter' }),
    ).rejects.toThrow();
    await expect(
      service.reviewDocument({ kind: 'skill', name: 'Big', content: '가'.repeat(30000) }),
    ).rejects.toThrow('size limit');
    const hook = {
      template: 'confirm' as const,
      title: "'); throw new Error('not code",
      message: 'Continue?',
    };
    const hookReview = await service.reviewDocument({
      kind: 'extension',
      name: '시작 확인',
      content: 'generated',
      hook,
    });
    const installed = service.install(hookReview.reviewId);
    const key = {
      resourceHash: installed.hash,
      kind: 'extension' as const,
      entry: 'extensions/hook.ts',
    };
    expect(service.readEntry(key).hook).toEqual(hook);
    expect(() => service.readEntry({ ...key, entry: '../package.json' })).toThrow();
    expect(() => service.readEntry({ ...key, entry: 'package.json' })).toThrow(
      'unknown resource entry',
    );
    expect(existsSync(s.marker)).toBe(false);
  }, 30_000);
  it('edits a copied entry without changing old snapshots, trust or sibling files', async () => {
    const s = setup();
    const review = await s.service.discoverLocal(s.source);
    const first = s.service.install(review.reviewId);
    s.service.trust(first.hash, true);
    s.service.saveProfile('writer', 0, s.profile(first.hash));
    const before = s.service.preview({ profileId: 'writer', revision: 1 }, 'default');
    const key = {
      resourceHash: first.hash,
      entry: 'skills/writing/SKILL.md',
      kind: 'skill' as const,
    };
    const changed = await s.service.reviewDocument({
      kind: 'skill',
      name: 'Edited writing',
      base: key,
      content: '---\nname: writing\ndescription: Write clearly.\n---\nKeep revised sources.',
    });
    const second = s.service.install(changed.reviewId);
    expect(s.service.install(changed.reviewId).hash).toBe(second.hash);
    expect(second.hash).not.toBe(first.hash);
    expect(second.trustedAt).toBeNull();
    expect(s.service.readEntry(key).content).toContain('Keep sources.');
    expect(s.service.preview({ profileId: 'writer', revision: 1 }, 'default')).toEqual(before);
    expect(second.files.find((file) => file.path === 'extensions/echo.ts')).toEqual(
      first.files.find((file) => file.path === 'extensions/echo.ts'),
    );
    const revision = s.service.store.entryManagement(key).managementRevision;
    const archived = s.service.archiveEntry(key, revision, true, 'archive-writing');
    expect(archived.archivedAt).toBeTruthy();
    expect(s.service.archiveEntry(key, revision, true, 'archive-writing')).toEqual(archived);
    expect(s.service.preview({ profileId: 'writer', revision: 1 }, 'default')).toEqual(before);
    expect(() => s.service.archiveEntry(key, 0, false, 'stale')).toThrow(
      'management revision changed',
    );
    expect(existsSync(s.marker)).toBe(false);
  });
  it('publishes one revision/default atomically and refuses stale or reused operations', async () => {
    const { service } = setup();
    const profile: HarnessProfile = {
      name: 'Empty',
      policy: 'strict',
      allowedTools: [],
      resources: [],
      startupCommands: [],
    };
    const input = {
      operationId: 'publish-once',
      profileId: 'empty',
      expectedRevision: 0,
      profile,
      target: {
        scope: 'personal' as const,
        scopeId: 'default',
        expectedRevision: 0,
        binding: null,
      },
    };
    const saved = service.publish(input);
    expect(service.publish(input)).toEqual(saved);
    expect(service.store.getDefault('personal', 'default').binding).toEqual({
      profileId: 'empty',
      revision: 1,
    });
    expect(() => service.publish({ ...input, profile: { ...profile, name: 'Different' } })).toThrow(
      'operation payload changed',
    );
    expect(() =>
      service.publish({ ...input, operationId: 'stale-default', expectedRevision: 1 }),
    ).toThrow('default revision changed');
    expect(service.store.listProfiles()[0]?.revision).toBe(1);
  });
  it('previews static broker descriptors without executing native resources', async () => {
    const s = setup();
    const review = await s.service.discoverLocal(s.source);
    s.service.install(review.reviewId);
    s.service.trust(review.resource.hash, true);
    s.service.saveProfile('preview', 0, {
      ...s.profile(review.resource.hash),
      allowedTools: ['read', 'edit', 'write', 'write_artifact', 'ask', 'echo'],
    });
    const preview = s.service.preview({ profileId: 'preview', revision: 1 }, 'default');
    expect(preview.snapshot.tools.map((tool) => tool.name)).toEqual([
      'read',
      'edit',
      'write',
      'write_artifact',
    ]);
    expect(preview.snapshot.tools).toContainEqual(
      expect.objectContaining({
        name: 'read',
        source: 'corral',
        sideEffect: 'none',
        schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(preview.snapshot.tools).toContainEqual(
      expect.objectContaining({ name: 'edit', sideEffect: 'workspace' }),
    );
    expect(preview.dynamic).toBe(true);
    expect(existsSync(s.marker)).toBe(false);
  });
  it('pins and intersects selected MCP servers with no ambient selections', () => {
    const { service } = setup();
    const mcp = {
      id: 'docs',
      name: 'Docs',
      transport: 'http' as const,
      url: 'https://example.invalid/mcp',
      exposure: 'direct' as const,
      timeoutMs: 10000,
      auth: { kind: 'none' as const },
    };
    service.projectTools.save('default', 0, { checks: [], lspServers: [], mcpServers: [mcp] });
    const profile = {
      name: 'MCP',
      policy: 'trusted-native' as const,
      allowedTools: ['mcp__docs__read'],
      resources: [],
      startupCommands: [],
      mcpServerIds: ['docs'],
    };
    service.saveProfile('mcp', 0, profile);
    expect(
      service.preview({ profileId: 'mcp', revision: 1 }, 'default').snapshot.projectTools
        ?.mcpServerIds,
    ).toEqual(['docs']);
    service.saveProfile('without_mcp', 0, { ...profile, mcpServerIds: [] });
    expect(
      service.preview({ profileId: 'mcp', revision: 1 }, 'default', {
        profileId: 'without_mcp',
        revision: 1,
      }).snapshot.projectTools?.mcpServerIds ?? [],
    ).toEqual([]);
  });
  it('disabling a server affects future composition without rewriting pinned settings', () => {
    const { service } = setup();
    const server = {
      id: 'docs',
      name: 'Docs',
      transport: 'http' as const,
      url: 'https://example.invalid/mcp',
      timeoutMs: 1000,
      exposure: 'direct' as const,
      auth: { kind: 'none' as const },
    };
    const original = service.projectTools.save('default', 0, {
      checks: [],
      lspServers: [],
      mcpServers: [server],
    });
    service.saveProfile('mcp', 0, {
      name: 'MCP',
      policy: 'trusted-native',
      allowedTools: ['mcp__docs__read'],
      resources: [],
      startupCommands: [],
      mcpServerIds: ['docs'],
    });
    const before = service.preview({ profileId: 'mcp', revision: 1 }, 'default');
    service.projectTools.save('default', 1, {
      checks: [],
      lspServers: [],
      mcpServers: [{ ...server, enabled: false }],
    });
    const after = service.preview({ profileId: 'mcp', revision: 1 }, 'default');
    expect(after.snapshot.projectTools?.mcpServerIds ?? []).toEqual([]);
    expect(after.snapshot.diagnostics).toContain('mcp_server_disabled');
    expect(before.snapshot.projectTools?.mcpServerIds).toEqual(['docs']);
    expect(service.projectTools.get('default', 1)).toEqual(original);
  });
  it('an explicit skill command must be a complete command token in the brief', async () => {
    const s = setup();
    const review = await s.service.discoverLocal(s.source);
    const resource = s.service.install(review.reviewId);
    s.service.trust(resource.hash, true);
    s.service.saveProfile('explicit', 0, {
      name: 'Explicit',
      policy: 'strict',
      allowedTools: ['read'],
      startupCommands: [],
      resources: [
        {
          resourceHash: resource.hash,
          entry: 'skills/writing/SKILL.md',
          kind: 'skill',
          required: true,
          skillMode: 'explicit',
        },
      ],
    });
    const snapshot = s.service.preview({ profileId: 'explicit', revision: 1 }, 'default').snapshot;
    for (const [text, expected] of [
      ['/skill:writing extra', true],
      ['Start\n/skill:writing', true],
      ['Explain /skill:writing-old', false],
      ['https://example.test/skill:writing', false],
      ['quoted /skill:writing command', false],
    ] as const) {
      const resources = await s.service.runtimeResources({
        harness: snapshot,
        inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text }],
      });
      expect(Boolean(resources.skills[0]?.content), text).toBe(expected);
    }
  });
  it('run resolution uses the same narrowing layer as preview', () => {
    const { service } = setup();
    const base = {
      name: 'Base',
      policy: 'strict' as const,
      allowedTools: ['read', 'write'],
      resources: [],
      startupCommands: [],
    };
    service.saveProfile('base', 0, base);
    service.saveProfile('limited', 0, {
      ...base,
      allowedTools: ['read'],
      permissionPolicy: { default: 'deny', rules: [] },
    });
    const binding = { profileId: 'base', revision: 1 },
      runOverride = { profileId: 'limited', revision: 1 };
    expect(service.resolve(binding, linearCorral(['writer']), 'writer', { runOverride })).toEqual(
      service.preview(binding, 'default', runOverride).snapshot,
    );
    const pinned = service.preview(binding, 'default', runOverride).snapshot;
    expect(pinned.permissionPolicies).toEqual([{ default: 'deny', rules: [] }]);
    service.saveProfile('limited', 1, {
      ...base,
      allowedTools: ['read'],
      permissionPolicy: { default: 'ask', rules: [] },
    });
    expect(service.preview(binding, 'default', runOverride).snapshot).toEqual(pinned);
    expect(
      service.preview(binding, 'default', { profileId: 'limited', revision: 2 }).snapshot
        .permissionPolicies,
    ).toEqual([{ default: 'ask', rules: [] }]);
  });
  it('pins selected project tools in the effective snapshot and inheritance can only narrow selection', () => {
    const { service, db } = setup();
    const tools = new SqliteProjectToolStore(db, new FakeClock());
    const check = (id: string) => ({ id, name: id, argv: ['node', 'check.mjs'], timeoutMs: 1000 });
    const config = tools.save('default', 0, {
      checks: [check('one'), check('two')],
      lspServers: [],
    });
    const base = {
      name: 'Checks',
      policy: 'strict' as const,
      allowedTools: ['run_check'],
      resources: [],
      startupCommands: [],
      checkIds: ['one', 'two'],
    };
    service.saveProfile('checks', 0, base);
    const binding = { profileId: 'checks', revision: 1 };
    const before = service.preview(binding, 'default').snapshot;
    expect(before.projectTools).toMatchObject({
      projectId: 'default',
      revision: 1,
      hash: config.hash,
      checkIds: ['one', 'two'],
      lspServerIds: [],
    });
    service.saveProfile('narrow', 0, { ...base, checkIds: ['one'] });
    service.setDefault('project', 'default', 0, { profileId: 'narrow', revision: 1 });
    expect(service.preview(binding, 'default').snapshot.projectTools?.checkIds).toEqual(['one']);
    tools.save('default', 1, { checks: [check('one')], lspServers: [] });
    const after = service.preview(binding, 'default').snapshot;
    expect(before.projectTools?.revision).toBe(1);
    expect(after.projectTools?.revision).toBe(2);
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
    service.setDefault('project', 'default', 1, null);
    expect(() => service.preview(binding, 'default')).toThrow(/registered/);
  });
  it('explicit Pi home import copies only skill and extension folders, leaving credentials and settings untouched', async () => {
    const s = setup();
    const secret = '{"access":"do-not-copy"}';
    writeFileSync(join(s.source, 'auth.json'), secret);
    writeFileSync(join(s.source, 'settings.json'), '{"packages":["npm:unselected@1.0.0"]}');
    const review = await s.service.discoverPiHome(s.source);
    expect(review.resource.files.map((file) => file.path)).toContain('skills/writing/SKILL.md');
    expect(review.resource.files.map((file) => file.path)).toContain('extensions/echo.ts');
    expect(review.resource.files.map((file) => file.path)).not.toContain('auth.json');
    expect(review.resource.files.map((file) => file.path)).not.toContain('settings.json');
    expect(JSON.stringify(review)).not.toContain('do-not-copy');
    expect(readFileSync(join(s.source, 'auth.json'), 'utf8')).toBe(secret);
    expect(existsSync(s.marker)).toBe(false);
    expect(s.service.install(review.reviewId).trustedAt).toBeNull();
    const db = openDatabase(':memory:');
    databases.push(db);
    const actual = new HarnessService({ root: `${s.resourceRoot}-pi`, db, clock: new FakeClock() });
    try {
      const inspected = await actual.discoverPiHome(s.source);
      expect(inspected.resource.extensions).toEqual(['extensions/echo.ts']);
      expect(inspected.resource.skills[0]?.name).toBe('writing');
      expect(existsSync(s.marker)).toBe(false);
    } finally {
      actual.dispose();
    }
  });
  it('downloaded package links become verified regular files in the reviewed copy', async () => {
    const s = setup(undefined, async (_source, directory) => {
      writeFileSync(join(directory, 'extension.ts'), 'export default () => {};');
      symlinkSync('extension.ts', join(directory, 'alias.ts'));
      return {
        name: 'fixture',
        version: '1.0.0',
        license: 'MIT',
        packagePath: null,
        extensions: ['alias.ts'],
        skills: [],
      };
    });
    const review = await s.service.discoverPackage('npm:fixture@1.0.0');
    const resource = s.service.install(review.reviewId);
    expect(resource.sourceKind).toBe('npm');
    expect(
      lstatSync(
        join(s.resourceRoot, 'resources', `sha256-${resource.hash}`, 'alias.ts'),
      ).isSymbolicLink(),
    ).toBe(false);
  });
  it('discovery does not execute or install; binding requires hash-specific trust and preview matches Run resolution', async () => {
    const s = setup();
    const review = await s.service.discoverLocal(s.source);
    expect(s.service.store.listResources()).toEqual([]);
    expect(existsSync(s.marker)).toBe(false);
    const resource = s.service.install(review.reviewId);
    expect(resource.trustedAt).toBeNull();
    expect(() => s.service.saveProfile('writer', 0, s.profile(resource.hash))).toThrow(/trust/i);
    s.service.trust(resource.hash, true);
    const profile = s.service.saveProfile('writer', 0, s.profile(resource.hash));
    const binding = { profileId: profile.profileId, revision: profile.revision };
    const preview = s.service.preview(binding, 'default');
    const definition = linearCorral(['writer']);
    definition.roles[0]!.harness = binding;
    expect(s.service.resolve(binding, definition, definition.roles[0]!.id)).toEqual(
      preview.snapshot,
    );
    expect(preview.sections).toMatchObject([
      { source: 'skill', name: 'writing', text: expect.stringContaining('Keep sources.') },
    ]);
    expect(JSON.stringify(preview.snapshot)).not.toContain(s.source);
    expect(JSON.stringify(preview.snapshot)).not.toContain('Keep sources.');
    expect(existsSync(s.marker)).toBe(false);
    const runtime = await s.service.runtimeResources({ harness: preview.snapshot, inputs: [] });
    expect(runtime.skills[0]?.content).toContain('Keep sources.');
    expect(runtime.bundles[0]?.hash).toBe(resource.hash);
    expect(runtime.extensions[0]?.source).toBe('extension:fixture@1.0.0');
    expect(s.service.readSkill(preview.snapshot, 'skills/writing/SKILL.md')).toMatchObject({
      text: expect.stringContaining('Keep sources.'),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      resourceHash: resource.hash,
    });
    for (const path of [
      'skills/other/SKILL.md',
      'skills/writing/../extensions/echo.ts',
      '/etc/passwd',
    ])
      expect(() => s.service.readSkill(preview.snapshot, path)).toThrow();
    s.service.saveProfile('later', 0, {
      name: 'Later default',
      policy: 'strict',
      allowedTools: [],
      resources: [],
      startupCommands: [],
    });
    s.service.store.setDefault('personal', 'default', 0, { profileId: 'later', revision: 1 });
    expect(await s.service.runtimeResources({ harness: preview.snapshot, inputs: [] })).toEqual(
      runtime,
    );
  });

  it('changed installed content revokes trust and cannot enter a Run', async () => {
    const s = setup();
    const resource = s.service.install((await s.service.discoverLocal(s.source)).reviewId);
    s.service.trust(resource.hash, true);
    s.service.saveProfile('writer', 0, s.profile(resource.hash));
    writeFileSync(
      join(s.resourceRoot, 'resources', `sha256-${resource.hash}`, 'extensions/echo.ts'),
      'changed',
    );
    expect(() => s.service.preview({ profileId: 'writer', revision: 1 }, 'default')).toThrow(
      /changed|integrity/i,
    );
    expect(s.service.store.getResource(resource.hash)?.trustedAt).toBeNull();
  });

  it('discovery refuses links outside the resource and installation uses the exact reviewed copy', async () => {
    const s = setup();
    symlinkSync('/etc/passwd', join(s.source, 'outside'));
    await expect(s.service.discoverLocal(s.source)).rejects.toThrow(/link|outside/i);
    rmSync(join(s.source, 'outside'));
    const review = await s.service.discoverLocal(s.source);
    writeFileSync(join(s.source, 'skills/writing/SKILL.md'), 'different source after review');
    const installed = s.service.install(review.reviewId);
    expect(installed.hash).toBe(review.resource.hash);
    expect(s.service.install(review.reviewId)).toEqual(installed);
  });

  it('personal and project restrictions cannot be weakened by a role', async () => {
    const s = setup();
    const resource = s.service.install((await s.service.discoverLocal(s.source)).reviewId);
    s.service.trust(resource.hash, true);
    s.service.saveProfile('writer', 0, s.profile(resource.hash));
    s.service.saveProfile('personal', 0, {
      name: 'Personal',
      policy: 'strict',
      allowedTools: [],
      resources: [],
      startupCommands: [],
    });
    s.service.store.setDefault('personal', 'default', 0, { profileId: 'personal', revision: 1 });
    expect(() => s.service.preview({ profileId: 'writer', revision: 1 }, 'default')).toThrow(
      /strict|native/i,
    );
  });

  it('mandatory skill size is checked before saving a binding', async () => {
    const s = setup('---\nname: writing\ndescription: Write.\n---\n' + 'x'.repeat(65536));
    const resource = s.service.install((await s.service.discoverLocal(s.source)).reviewId);
    s.service.trust(resource.hash, true);
    expect(() => s.service.saveProfile('writer', 0, s.profile(resource.hash))).toThrow(
      /skill.*(large|size|limit)/i,
    );
  });
});

it('bundled content is reviewed and pinned, only selected entries are exposed, and sibling paths stay scoped', async () => {
  const s = setup();
  const service = new HarnessService({ root: s.resourceRoot, db: s.db, clock: new FakeClock() });
  for (const [id, count] of [
    ['core', 5],
    ['browser', 1],
    ['coding', 3],
    ['design', 10],
  ] as const) {
    const review = await service.discoverBuiltin(id);
    expect(review.resource.skills).toHaveLength(count);
    expect(review.resource.extensions).toEqual([]);
    expect(review.resource.license).toBe('MIT');
    const resource = service.install(review.reviewId);
    expect(resource.trustedAt).toBeNull();
    service.trust(resource.hash, true);
    if (id !== 'design') continue;
    const skills = resource.skills.filter((skill) =>
      ['design-workflow', 'review-components'].includes(skill.name),
    );
    service.saveProfile('design', 0, {
      name: 'Design review',
      policy: 'strict',
      allowedTools: ['read'],
      startupCommands: [],
      resources: skills.map((skill) => ({
        resourceHash: resource.hash,
        kind: 'skill',
        entry: skill.entry,
        required: true,
        skillMode: 'auto',
      })),
    });
    const snapshot = service.preview({ profileId: 'design', revision: 1 }, 'default').snapshot;
    const read = service.readSkill(snapshot, 'skills/design-workflow/SKILL.md');
    expect(read.boundSkills).toEqual(
      expect.arrayContaining([
        { name: 'review-components', path: 'skills/review-components/SKILL.md' },
      ]),
    );
    expect(JSON.stringify(read.boundSkills)).not.toContain('audit-design');
    expect(() => service.readSkill(snapshot, 'skills/audit-design/SKILL.md')).toThrow();
    expect(() =>
      service.readSkill(snapshot, 'skills/design-workflow/../review-components/SKILL.md'),
    ).toThrow();
    const bound = snapshot.resources[0]!;
    writeFileSync(
      join(s.resourceRoot, 'resources', `sha256-${resource.hash}`, bound.entry!),
      'changed',
    );
    expect(() => service.readSkill(snapshot, `skills/${bound.skillName}/SKILL.md`)).toThrow(
      /integrity/,
    );
  }
  await expect(service.discoverBuiltin('../private')).rejects.toThrow();
}, 30_000);

describe('session default work style', () => {
  it('seeds one built-in trusted work style that offers command and preview tools', () => {
    const { service } = setup();
    const binding = service.sessionDefault();
    if (!binding) throw new Error('the session default must be seeded');
    expect(binding).toEqual({ profileId: 'session-default', revision: 1 });
    // Asking again reuses the same revision instead of saving another.
    expect(service.sessionDefault()).toEqual(binding);
    const snapshot = service.preview(binding, 'default').snapshot;
    expect(snapshot.policy).toBe('trusted-native');
    expect(snapshot.allowedTools).toEqual(
      expect.arrayContaining(['run_command', 'preview_app', 'read_file', 'write_file']),
    );
  });

  it('a strict project default restricts the session default, and an archived one is not used', () => {
    const { service } = setup();
    const binding = service.sessionDefault();
    if (!binding) throw new Error('the session default must be seeded');
    const strict = service.saveProfile('read-only', 0, {
      name: 'Read only',
      policy: 'strict',
      allowedTools: ['read_file', 'ask_user'],
      resources: [],
      startupCommands: [],
    });
    service.setDefault('project', 'default', 0, {
      profileId: strict.profileId,
      revision: strict.revision,
    });
    const snapshot = service.preview(binding, 'default').snapshot;
    expect(snapshot.policy).toBe('strict');
    expect(snapshot.allowedTools).toEqual(['read_file', 'ask_user']);
    service.archiveProfile('session-default', 0, true, 'archive_session_default');
    expect(service.sessionDefault()).toBeNull();
  });
});
