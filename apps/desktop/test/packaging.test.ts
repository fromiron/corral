import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  assertRelocatableRuntime,
  assertRuntimeIdentity,
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
    assertRuntimeIdentity({ platform: 'linux', arch: 'x64', version: '24.19.0' }, 'win32', 'x64'),
  ).toThrow('prepare:runtime');
  expect(() =>
    assertRuntimeIdentity({ platform: 'win32', arch: 'arm64', version: '24.19.0' }, 'win32', 'x64'),
  ).toThrow('prepare:runtime');
  expect(() =>
    assertRuntimeIdentity({ platform: 'win32', arch: 'x64', version: '22.0.0' }, 'win32', 'x64'),
  ).toThrow('prepare:runtime');
  expect(() =>
    assertRuntimeIdentity({ platform: 'win32', arch: 'x64', version: '24.19.0' }, 'win32', 'x64'),
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
