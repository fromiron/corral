import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkDependencies } from '../deps/check.ts';

test('dependency evidence must match installed versions and compatibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-dependency-check-'));
  const write = (path: string, value: unknown) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  const manifest = {
    name: 'widget',
    version: '1.0.0',
    license: 'MIT',
    engines: { node: '^24.15.0' },
    peerDependencies: { peer: '^2.0.0' },
  };
  const record = {
    ...manifest,
    integrity: 'sha512-fixture',
    repository: 'https://example.test/widget',
    published: '2026-10-15T00:00:00Z',
  };
  const installed = {
    MIT: [{ name: 'widget', versions: ['1.0.0'], paths: [join(root, 'node_modules/widget')] }],
  };
  try {
    write('package.json', { name: 'fixture', dependencies: { widget: '1.0.0' } });
    write('docs/dependency-lock.json', { dependencies: [record] });
    write('node_modules/widget/package.json', manifest);
    write('node_modules/peer/package.json', { name: 'peer', version: '2.1.0' });
    assert.doesNotThrow(() => checkDependencies(root, installed, '24.15.0'));

    write('docs/dependency-lock.json', { dependencies: [{ ...record, version: '0.9.0' }] });
    assert.throws(
      () => checkDependencies(root, installed, '24.15.0'),
      /Unreviewed dependency.*widget@1.0.0/,
    );
    write('docs/dependency-lock.json', { dependencies: [record] });
    write('node_modules/widget/package.json', { ...manifest, version: '1.0.1' });
    assert.throws(() => checkDependencies(root, installed, '24.15.0'), /Installed version.*widget/);
    write('node_modules/widget/package.json', manifest);
    assert.throws(() => checkDependencies(root, installed, '22.0.0'), /Node.*widget/);
    assert.throws(() => checkDependencies(root, installed, '24.14.0'), /Node.*widget/);
    write('node_modules/peer/package.json', { name: 'peer', version: '3.0.0' });
    assert.throws(() => checkDependencies(root, installed, '24.15.0'), /peer.*widget/);
    rmSync(join(root, 'node_modules/peer'), { recursive: true });
    assert.throws(() => checkDependencies(root, installed, '24.15.0'), /Missing peer.*widget/);
    write('node_modules/widget/package.json', {
      ...manifest,
      peerDependenciesMeta: { peer: { optional: true } },
    });
    assert.doesNotThrow(() => checkDependencies(root, installed, '24.15.0'));
    write('node_modules/peer/package.json', { name: 'peer', version: '3.0.0' });
    assert.throws(() => checkDependencies(root, installed, '24.15.0'), /peer.*widget/);

    write('node_modules/widget/package.json', { ...manifest, license: 'ISC' });
    assert.throws(() => checkDependencies(root, installed, '24.15.0'), /review metadata differs/);
    write('node_modules/widget/package.json', manifest);
    write('node_modules/peer/package.json', { name: 'peer', version: '2.1.0' });
    write('docs/dependency-lock.json', { dependencies: [{ ...record, repository: null }] });
    assert.throws(() => checkDependencies(root, installed, '24.15.0'), /review metadata differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prerelease exceptions require matching reviewed metadata and do not authorize another version', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-prerelease-check-'));
  const packagePath = join(root, 'node_modules/preview');
  const manifest = {
    name: 'preview',
    version: '1.0.0-rc.1',
    license: 'MIT',
    engines: { node: '^24.15.0' },
  };
  const record = {
    ...manifest,
    peerDependencies: null,
    repository: 'https://example.test/preview',
    published: '2026-10-15T00:00:00Z',
    integrity: 'sha512-fixture',
    review: 'Pinned existing development dependency, source and license reviewed.',
  };
  const installed = { MIT: [{ name: 'preview', versions: ['1.0.0-rc.1'], paths: [packagePath] }] };
  const writeEvidence = (reviewedPrereleases: unknown[]) =>
    writeFileSync(
      join(root, 'docs/dependency-lock.json'),
      JSON.stringify({ dependencies: [], reviewedPrereleases }),
    );
  try {
    mkdirSync(packagePath, { recursive: true });
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    writeFileSync(join(packagePath, 'package.json'), JSON.stringify(manifest));
    writeEvidence([]);
    assert.throws(() => checkDependencies(root, installed, '24.19.0'), /Unreviewed prerelease/);
    writeEvidence([record]);
    assert.doesNotThrow(() => checkDependencies(root, installed, '24.19.0'));
    writeEvidence([{ ...record, version: '1.0.0-rc.2' }]);
    assert.throws(() => checkDependencies(root, installed, '24.19.0'), /Unreviewed prerelease/);
    writeEvidence([{ ...record, engines: { node: '>=20' } }]);
    assert.throws(() => checkDependencies(root, installed, '24.19.0'), /review metadata differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
