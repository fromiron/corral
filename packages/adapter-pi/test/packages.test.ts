import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { downloadPiPackage, inspectPiPackage } from '../src/index.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('Pi package discovery uses its manifest and skill parser without importing extensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-package-'));
  roots.push(root);
  mkdirSync(join(root, 'extensions'), { recursive: true });
  mkdirSync(join(root, 'skills/writing'), { recursive: true });
  const marker = join(root, 'EXECUTED');
  writeFileSync(
    join(root, 'extensions/index.ts'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); export default () => {};`,
  );
  writeFileSync(
    join(root, 'skills/writing/SKILL.md'),
    '---\nname: writing\ndescription: "Writing: with sources"\n---\nKeep sources.',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      license: 'MIT',
      pi: { extensions: ['./extensions'], skills: ['./skills'] },
    }),
  );
  expect(await inspectPiPackage(root)).toMatchObject({
    name: 'fixture',
    version: '1.0.0',
    license: 'MIT',
    packagePath: null,
    extensions: ['extensions/index.ts'],
    skills: [
      { name: 'writing', description: 'Writing: with sources', entry: 'skills/writing/SKILL.md' },
    ],
  });
  expect(existsSync(marker)).toBe(false);
}, 15000);

it('downloads require an exact npm version or HTTPS Git commit and cannot embed credentials', async () => {
  for (const source of [
    'npm:package',
    'npm:package@latest',
    'npm:package@^1.0.0',
    'git:https://github.com/org/repo@main',
    `git:https://user:secret@host/org/repo@${'a'.repeat(40)}`,
    `git:https://host/../../outside@${'a'.repeat(40)}`,
  ])
    await expect(downloadPiPackage(source, '/unused')).rejects.toThrow(/pin|source/i);
});
