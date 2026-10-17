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
import { type Db, openDatabase } from '@corral/storage-sqlite';
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
  return { service, source, marker, resourceRoot, profile };
}

describe('resource discovery, trust and resolution (H3)', () => {
  it('[TC-HAR-004-H] explicit Pi home import copies only skill and extension folders, leaving credentials and settings untouched', async () => {
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
  it('[TC-HAR-004-H] downloaded package links become verified regular files in the reviewed copy', async () => {
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
  it('[TC-HAR-004-H] [TC-HAR-005-H] discovery does not execute or install; binding requires hash-specific trust and preview matches Run resolution', async () => {
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

  it('[TC-HAR-004-N] changed installed content revokes trust and cannot enter a Run', async () => {
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

  it('[TC-HAR-004-N] discovery refuses links outside the resource and installation uses the exact reviewed copy', async () => {
    const s = setup();
    symlinkSync('/etc/passwd', join(s.source, 'outside'));
    await expect(s.service.discoverLocal(s.source)).rejects.toThrow(/link|outside/i);
    rmSync(join(s.source, 'outside'));
    const review = await s.service.discoverLocal(s.source);
    writeFileSync(join(s.source, 'skills/writing/SKILL.md'), 'different source after review');
    const installed = s.service.install(review.reviewId);
    expect(installed.hash).toBe(review.resource.hash);
    expect(() => s.service.install(review.reviewId)).toThrow(/review/i);
  });

  it('[TC-HAR-008-N] personal and project restrictions cannot be weakened by a role', async () => {
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

  it('[TC-HAR-005-N] mandatory skill size is checked before saving a binding', async () => {
    const s = setup('---\nname: writing\ndescription: Write.\n---\n' + 'x'.repeat(65536));
    const resource = s.service.install((await s.service.discoverLocal(s.source)).reviewId);
    s.service.trust(resource.hash, true);
    expect(() => s.service.saveProfile('writer', 0, s.profile(resource.hash))).toThrow(
      /skill.*(large|size|limit)/i,
    );
  });
});
