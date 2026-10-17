import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectPiPackage } from '../src/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('[TC-HAR-004-H] Pi package discovery uses its manifest and skill parser without importing extensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-package-'));
  roots.push(root);
  mkdirSync(join(root, 'extensions'), { recursive: true });
  mkdirSync(join(root, 'skills/writing'), { recursive: true });
  const marker = join(root, 'EXECUTED');
  writeFileSync(join(root, 'extensions/index.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); export default () => {};`);
  writeFileSync(join(root, 'skills/writing/SKILL.md'), '---\nname: writing\ndescription: "Writing: with sources"\n---\nKeep sources.');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT', pi: { extensions: ['./extensions'], skills: ['./skills'] } }));
  expect(await inspectPiPackage(root)).toMatchObject({
    name: 'fixture', version: '1.0.0', license: 'MIT', packagePath: null,
    extensions: ['extensions/index.ts'], skills: [{ name: 'writing', description: 'Writing: with sources', entry: 'skills/writing/SKILL.md' }],
  });
  expect(existsSync(marker)).toBe(false);
}, 15000);
