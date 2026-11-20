import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackageInspection } from '@corral/contracts';
import { type Db, openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { SdkResources } from '../../../packages/adapter-pi/src/protocol.ts';
import { HarnessService } from '../src/harness/service.ts';

// docs/specs/harness-contract.md, "그 밖에 쓸 수 있는 스킬": the library never overflows a snapshot.
const CAP = 256;
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
    version: '1.0.0',
    license: null,
    packagePath: null,
    extensions: [],
    skills: readdirSync(join(directory, 'skills'))
      .sort()
      .map((name) => ({ name, description: `Use ${name}.`, entry: `skills/${name}/SKILL.md` })),
  };
}

async function library(packages: number, skillsEach: number) {
  const root = mkdtempSync(join(tmpdir(), 'corral-library-cap-'));
  roots.push(root);
  const db = openDatabase(':memory:');
  databases.push(db);
  const service = new HarnessService({
    root: join(root, 'data'),
    db,
    clock: new FakeClock(),
    inspect,
  });
  const hashes: string[] = [];
  for (let p = 0; p < packages; p++) {
    const source = join(root, `p${p}`);
    for (let k = 0; k < skillsEach; k++) {
      const name = `p${p}-s${String(k).padStart(2, '0')}`;
      mkdirSync(join(source, 'skills', name), { recursive: true });
      writeFileSync(join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    }
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: `pack-${p}` }));
    hashes.push(service.install((await service.discoverLocal(source)).reviewId).hash);
  }
  return { service, hashes };
}

it('fills only the room a snapshot has, newest packages first, and says it cut', async () => {
  const { service, hashes } = await library(5, 60);
  const picked = { resourceHash: hashes[0]!, entry: 'skills/p0-s00/SKILL.md' };
  const snapshot = service.preview({ id: 'writer', skills: [picked] }, 'default').snapshot!;
  expect(snapshot.resources).toHaveLength(CAP);
  expect(snapshot.resources).toContainEqual(
    expect.objectContaining({
      hash: picked.resourceHash,
      entry: picked.entry,
      selectedByRole: true,
    }),
  );
  const count = (hash: string) => snapshot.resources.filter((r) => r.hash === hash).length;
  expect(count(hashes[4]!)).toBe(60);
  expect(count(hashes[1]!)).toBe(60);
  expect(count(hashes[0]!)).toBeLessThan(60);
  expect(snapshot.diagnostics).toContain('library_skills_truncated');
  const runtime = await service.runtimeResources({ harness: snapshot, inputs: [] });
  expect(SdkResources.safeParse(runtime).success).toBe(true);
}, 60_000);

it('a library just under the cap is bound whole with no diagnostic', async () => {
  const { service, hashes } = await library(4, 60);
  const picked = { resourceHash: hashes[0]!, entry: 'skills/p0-s00/SKILL.md' };
  const snapshot = service.preview({ id: 'writer', skills: [picked] }, 'default').snapshot!;
  expect(snapshot.resources).toHaveLength(240);
  expect(snapshot.diagnostics).not.toContain('library_skills_truncated');
}, 60_000);
