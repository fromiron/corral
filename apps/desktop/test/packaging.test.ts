import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRelocatableRuntime,
  assertRuntimeIdentity,
  copyCorrespondingSource,
  nodeLicensePath,
  packageManagerCommand,
  runtimeTarget,
} from '../scripts/packaging.ts';

it('keeps the PTY native dependency on the server Node side', () => {
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  expect(require('node-pty/package.json').version).toBe('1.1.0');
  expect(typeof require('node-pty').spawn).toBe('function');
});

it('rejects a junction into staging even when its initial target is inside staging', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-runtime-links-'));
  try {
    mkdirSync(join(root, 'packages/core'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(
      join(root, 'packages/core'),
      join(root, 'node_modules/core'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => assertRelocatableRuntime(root)).toThrow('link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('physical dependencies still resolve after relocation with the build directory unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-runtime-move-'));
  try {
    const source = join(root, 'staging');
    mkdirSync(join(source, 'server/node_modules/example'), { recursive: true });
    writeFileSync(join(source, 'server/package.json'), '{"name":"runtime","private":true}');
    writeFileSync(
      join(source, 'server/node_modules/example/index.js'),
      'module.exports = "relocated";',
    );
    expect(assertRelocatableRuntime(source).links).toEqual([]);
    const relocated = join(root, 'relocated');
    cpSync(source, relocated, { recursive: true });
    renameSync(source, join(root, 'unavailable'));
    const require = createRequire(join(relocated, 'server/package.json'));
    expect(require.resolve('example')).toBe(
      join(relocated, 'server/node_modules/example/index.js'),
    );
    expect(require('example')).toBe('relocated');
    expect(assertRelocatableRuntime(relocated).links).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('launches Windows native and JS pnpm without a command shell', () => {
  expect(packageManagerCommand('C:/pnpm path/pnpm.exe', 'node.exe')).toEqual({
    executable: 'C:/pnpm path/pnpm.exe',
    args: [],
  });
  expect(packageManagerCommand('C:/pnpm path/pnpm.cjs', 'node.exe')).toEqual({
    executable: 'node.exe',
    args: ['C:/pnpm path/pnpm.cjs'],
  });
  expect(() => packageManagerCommand('pnpm.cmd', 'node.exe')).toThrow('shell wrapper');
});

it('bundles the native runtime for the build host only', () => {
  const nodeVersion = readFileSync(
    new URL('../../../.node-version', import.meta.url),
    'utf8',
  ).trim();
  expect(runtimeTarget('win32', 'x64')).toEqual({
    platform: 'win32',
    arch: 'x64',
    node: 'node.exe',
  });
  expect(runtimeTarget('darwin', 'arm64').node).toBe('node');
  expect(runtimeTarget('linux', 'x64').node).toBe('node');
  expect(() => runtimeTarget('freebsd', 'x64')).toThrow('Unsupported');
  expect(() => runtimeTarget('win32', 'ia32')).toThrow('Unsupported');
  expect(() =>
    assertRuntimeIdentity({ platform: 'linux', arch: 'x64', version: nodeVersion }, 'win32', 'x64'),
  ).toThrow('prepare:runtime');
  expect(() =>
    assertRuntimeIdentity(
      { platform: 'win32', arch: 'arm64', version: nodeVersion },
      'win32',
      'x64',
    ),
  ).toThrow('prepare:runtime');
  expect(() =>
    assertRuntimeIdentity({ platform: 'win32', arch: 'x64', version: '24.19.0' }, 'win32', 'x64'),
  ).toThrow('prepare:runtime');
  expect(() =>
    assertRuntimeIdentity({ platform: 'win32', arch: 'x64', version: nodeVersion }, 'win32', 'x64'),
  ).not.toThrow();
});

it('discovers the license in Windows and Unix Node distributions', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-node-license-'));
  try {
    mkdirSync(join(root, 'bin'));
    expect(() => nodeLicensePath(join(root, 'node.exe'))).toThrow('license');
    writeFileSync(join(root, 'LICENSE'), 'Node distribution license');
    expect(nodeLicensePath(join(root, 'node.exe'))).toBe(join(root, 'LICENSE'));
    expect(nodeLicensePath(join(root, 'bin/node'))).toBe(join(root, 'LICENSE'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('corresponding source copy', () => {
  const fixture = (run: (root: string, destination: string) => void) => {
    const base = mkdtempSync(join(tmpdir(), 'corral-corresponding-source-'));
    try {
      const root = join(base, 'repo');
      mkdirSync(join(root, 'skills/review'), { recursive: true });
      writeFileSync(join(root, 'skills/review/SKILL.md'), 'review');
      writeFileSync(join(root, 'README.md'), 'readme');
      run(root, join(base, 'staging/corresponding-source/corral'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

  it('records in-repo links instead of copying them and copies files with their hashes', () =>
    fixture((root, destination) => {
      mkdirSync(join(root, '.claude/skills'), { recursive: true });
      symlinkSync('../../skills/review', join(root, '.claude/skills/review'));
      symlinkSync('README.md', join(root, 'readme-link.md'));
      const paths = [
        '.claude/skills/review',
        'README.md',
        'gone.md',
        'readme-link.md',
        'skills/review/SKILL.md',
      ];
      expect(copyCorrespondingSource(root, paths, destination)).toEqual({
        files: { 'README.md': sha256('readme'), 'skills/review/SKILL.md': sha256('review') },
        links: { '.claude/skills/review': '../../skills/review', 'readme-link.md': 'README.md' },
      });
      expect(readFileSync(join(destination, 'skills/review/SKILL.md'), 'utf8')).toBe('review');
      for (const path of ['.claude/skills/review', 'readme-link.md', 'gone.md'])
        expect(existsSync(join(destination, path)) || isLink(join(destination, path))).toBe(false);
      expect(assertRelocatableRuntime(join(destination, '../..')).links).toEqual([]);
    }));

  it('refuses a link with an absolute target and names it', () =>
    fixture((root, destination) => {
      symlinkSync(join(root, 'README.md'), join(root, 'absolute.md'));
      expect(() => copyCorrespondingSource(root, ['absolute.md'], destination)).toThrow(
        'absolute.md',
      );
    }));

  it('refuses a link that leaves the repository and names it', () =>
    fixture((root, destination) => {
      writeFileSync(join(root, '../outside.md'), 'outside');
      symlinkSync('../outside.md', join(root, 'escape.md'));
      expect(() => copyCorrespondingSource(root, ['escape.md'], destination)).toThrow('escape.md');
    }));
});

function isLink(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}
