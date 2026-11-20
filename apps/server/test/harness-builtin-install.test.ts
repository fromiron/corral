import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackageInspection } from '@corral/contracts';
import { type Db, openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { HarnessService } from '../src/harness/service.ts';

// Fixture packs stand in for apps/server/resources/builtin so these tests do not depend on the
// shipped packs' contents (docs/specs/features/builtin-crew.md, "설치").
const roots: string[] = [];
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function inspect(directory: string): Promise<PackageInspection> {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  return {
    name: manifest.name,
    version: manifest.version,
    license: 'MIT',
    packagePath: null,
    extensions: [],
    skills: readdirSync(join(directory, 'skills'))
      .sort()
      .map((name) => ({ name, description: `Use ${name}.`, entry: `skills/${name}/SKILL.md` })),
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-builtin-'));
  roots.push(root);
  const db = openDatabase(':memory:');
  databases.push(db);
  const packs = join(root, 'packs');
  const manifest: Record<string, { hash: string; files: number; skills: number; source: string }> =
    {};
  const service = (clock = new FakeClock()) =>
    new HarnessService({
      root: join(root, 'data'),
      db,
      clock,
      inspect,
      builtin: { root: packs, manifest },
    });
  // A throwaway service measures the hash the same way installation does.
  const measure = new HarnessService({
    root: join(root, 'measure'),
    db: openDatabase(':memory:'),
    clock: new FakeClock(),
    inspect,
  });
  async function pack(id: string, version: string, skills: Record<string, string>) {
    const directory = join(packs, id);
    rmSync(directory, { recursive: true, force: true });
    for (const [name, body] of Object.entries(skills)) {
      mkdirSync(join(directory, 'skills', name), { recursive: true });
      writeFileSync(
        join(directory, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Use ${name}.\n---\n${body}`,
      );
    }
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: `@corral/builtin-${id}`, version, pi: { skills: ['./skills'] } }),
    );
    const review = await measure.discoverLocal(directory);
    measure.cancelReview(review.reviewId);
    manifest[id] = {
      hash: review.resource.hash,
      files: review.resource.files.length,
      skills: Object.keys(skills).length,
      source: `Fixture ${id} ${version}`,
    };
    return review.resource.hash;
  }
  const entry = (resourceHash: string, name: string) => ({
    resourceHash,
    entry: `skills/${name}/SKILL.md`,
    kind: 'skill' as const,
  });
  return { root, packs, manifest, service, pack, entry };
}

it('installs every bundled pack trusted into a fresh store, and a second start changes nothing', async () => {
  const s = setup();
  const alpha = await s.pack('alpha', '1.0.0', { one: 'A', two: 'B' });
  const beta = await s.pack('beta', '1.0.0', { three: 'C' });
  const first = s.service();
  await first.installBuiltins();
  for (const hash of [alpha, beta]) {
    expect(first.store.getResource(hash)?.trustedAt).not.toBeNull();
    expect(first.store.packageManagement(hash).status).toBe('enabled');
  }
  expect(first.store.getResource(alpha)?.sourceLabel).toBe('Fixture alpha 1.0.0');
  const state = () =>
    JSON.stringify([
      first.store.listResources(),
      first.entries(),
      first.packages().map((item) => item.status),
    ]);
  const before = state();
  await first.installBuiltins();
  await s.service().installBuiltins();
  expect(state()).toBe(before);
});

it('never reinstalls, re-enables or re-trusts a bundled pack a person removed, disabled or revoked', async () => {
  const s = setup();
  const alpha = await s.pack('alpha', '1.0.0', { one: 'A' });
  const beta = await s.pack('beta', '1.0.0', { two: 'B' });
  const gamma = await s.pack('gamma', '1.0.0', { three: 'C' });
  const service = s.service();
  await service.installBuiltins();
  await service.managePackage(alpha, 0, 'removed', 'remove-alpha');
  await service.managePackage(beta, 0, 'disabled', 'disable-beta');
  service.trust(gamma, false);
  const restarted = s.service();
  await restarted.installBuiltins();
  expect(restarted.store.packageManagement(alpha).status).toBe('removed');
  expect(restarted.store.packageManagement(beta).status).toBe('disabled');
  expect(restarted.store.getResource(gamma)?.trustedAt).toBeNull();
  expect(restarted.entries().some((entry) => entry.resourceHash === alpha)).toBe(false);
});

it('a person re-importing a removed bundled pack makes it usable again', async () => {
  const s = setup();
  const alpha = await s.pack('alpha', '1.0.0', { one: 'A' });
  const service = s.service();
  await service.installBuiltins();
  await service.managePackage(alpha, 0, 'removed', 'remove-alpha');
  service.install((await service.discoverBuiltin('alpha')).reviewId);
  expect(service.store.packageManagement(alpha).status).toBe('enabled');
  expect(service.entries().some((entry) => entry.resourceHash === alpha)).toBe(true);
});

it('skips a pack whose content does not match the manifest and installs the others', async () => {
  const s = setup();
  const alpha = await s.pack('alpha', '1.0.0', { one: 'A' });
  const beta = await s.pack('beta', '1.0.0', { two: 'B' });
  writeFileSync(join(s.packs, 'beta', 'skills/two/SKILL.md'), 'changed after the manifest');
  const service = s.service();
  await expect(service.installBuiltins()).resolves.not.toThrow();
  expect(service.store.getResource(alpha)).not.toBeNull();
  expect(service.store.getResource(beta)).toBeNull();
  expect(service.store.listResources().map((resource) => resource.hash)).toEqual([alpha]);
});

it('a new bundled version links and archives earlier bundled entries a person has not handled', async () => {
  const s = setup();
  const v1 = await s.pack('alpha', '1.0.0', {
    kept: 'old',
    retired: 'old',
    personal: 'old',
    linked: 'old',
  });
  const first = s.service();
  await first.installBuiltins();
  // A person's own changes: archive one entry, link another, and save an edited copy that keeps
  // the bundled package name.
  first.archiveEntry(s.entry(v1, 'personal'), 0, true, 'archive-personal');
  const copy = first.install(
    (
      await first.reviewDocument({
        kind: 'skill',
        name: 'My kept',
        base: s.entry(v1, 'kept'),
        content: '---\nname: kept\ndescription: Use kept.\n---\nmine',
      })
    ).reviewId,
  );
  first.store.manageEntry(s.entry(v1, 'linked'), 0, false, s.entry(copy.hash, 'kept'));
  // Saving the edited copy linked the bundled entry to it.
  expect(first.store.entryManagement(s.entry(v1, 'kept')).successor).toEqual(
    s.entry(copy.hash, 'kept'),
  );
  const before = (name: string, hash = v1) => first.store.entryManagement(s.entry(hash, name));
  const handled = {
    kept: before('kept'),
    personal: before('personal'),
    linked: before('linked'),
    copy: before('kept', copy.hash),
  };

  const v2 = await s.pack('alpha', '2.0.0', {
    kept: 'new',
    personal: 'new',
    linked: 'new',
    added: 'new',
  });
  const second = s.service();
  await second.installBuiltins();
  expect(second.store.getResource(v2)?.trustedAt).not.toBeNull();
  // Unhandled earlier entries are archived; a same-named one points to the new version.
  expect(second.store.entryManagement(s.entry(v1, 'retired'))).toMatchObject({
    archivedAt: expect.any(String),
    successor: null,
  });
  // A person-handled entry is untouched: archived, linked, or an edited copy of their own.
  expect(second.store.entryManagement(s.entry(v1, 'kept'))).toEqual(handled.kept);
  expect(second.store.entryManagement(s.entry(v1, 'personal'))).toEqual(handled.personal);
  expect(second.store.entryManagement(s.entry(v1, 'linked'))).toEqual(handled.linked);
  expect(second.store.entryManagement(s.entry(copy.hash, 'kept'))).toEqual(handled.copy);
  await second.installBuiltins();
  expect(second.store.entryManagement(s.entry(v1, 'retired')).managementRevision).toBe(1);
  // A team pinned to the earlier version still resolves it.
  const pinned = { resourceHash: v1, entry: 'skills/retired/SKILL.md' };
  const snapshot = second.preview({ id: 'writer', skills: [pinned] }, 'default').snapshot!;
  expect(snapshot.resources).toContainEqual(
    expect.objectContaining({ hash: v1, skillName: 'retired', selectedByRole: true }),
  );
  // Library skills now come from the new version only.
  const library = second.preview({ id: 'writer', skills: [] }, 'default').snapshot!;
  expect(library.resources.find((r) => r.skillName === 'added')?.hash).toBe(v2);
  expect(library.resources.some((r) => r.hash === v1)).toBe(false);
});

it('links a same-named earlier bundled entry to its new version', async () => {
  const s = setup();
  const v1 = await s.pack('alpha', '1.0.0', { kept: 'old' });
  await s.service().installBuiltins();
  const v2 = await s.pack('alpha', '2.0.0', { kept: 'new' });
  const service = s.service();
  await service.installBuiltins();
  expect(service.store.entryManagement(s.entry(v1, 'kept'))).toMatchObject({
    archivedAt: expect.any(String),
    successor: s.entry(v2, 'kept'),
  });
});

it('inspects each bundled version once per process, and never content that differs', async () => {
  const s = setup();
  const alpha = await s.pack('alpha', '1.0.0', { one: 'A' });
  let calls = 0;
  const counted = async (directory: string) => {
    calls++;
    return inspect(directory);
  };
  for (const _ of [1, 2]) {
    const db = openDatabase(':memory:');
    databases.push(db);
    const service = new HarnessService({
      root: mkdtempSync(join(s.root, 'fresh-')),
      db,
      clock: new FakeClock(),
      inspect: counted,
      builtin: { root: s.packs, manifest: s.manifest },
    });
    await service.installBuiltins();
    expect(service.store.getResource(alpha)?.trustedAt).not.toBeNull();
  }
  expect(calls).toBe(1);
  writeFileSync(join(s.packs, 'alpha', 'skills/one/SKILL.md'), 'changed');
  const db = openDatabase(':memory:');
  databases.push(db);
  const changed = new HarnessService({
    root: mkdtempSync(join(s.root, 'fresh-')),
    db,
    clock: new FakeClock(),
    inspect: counted,
    builtin: { root: s.packs, manifest: s.manifest },
  });
  await changed.installBuiltins();
  expect(changed.store.getResource(alpha)).toBeNull();
  expect(calls).toBe(2);
});
