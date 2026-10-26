import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPackageManifest } from '../src/harness/package-manifest.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(corral?: unknown, packagePath: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'corral-package-manifest-'));
  roots.push(root);
  const directory = packagePath ? join(root, packagePath) : root;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'test-package', version: '1.0.0', license: 'MIT', corral }),
  );
  return root;
}

describe('package declaration review', () => {
  it('reads immutable metadata for nested installs without executing contributions', () => {
    const manifest = {
      version: 1,
      requestedCapabilities: ['workspace.read', 'mcp'],
      mcpServers: [
        { id: 'local_server', name: 'Local', transport: 'stdio', argv: ['node', 'server.js'] },
        { id: 'remote_server', name: 'Remote', transport: 'http', url: 'https://example.com/mcp' },
      ],
      ui: [{ id: 'help', slot: 'package-details', title: 'Usage', body: 'Read before enabling.' }],
    };
    const path = 'node_modules/test-package';
    const root = fixture(manifest, path);
    writeFileSync(
      join(root, path, 'server.js'),
      "require('node:fs').writeFileSync('EXECUTED', 'unsafe');",
    );
    expect(inspectPackageManifest(root, path)).toEqual(manifest);
    expect(existsSync(join(root, 'EXECUTED'))).toBe(false);
  });

  it('preserves ordinary Pi packages and defaults empty declarations', () => {
    expect(inspectPackageManifest(fixture())).toBeNull();
    expect(inspectPackageManifest(fixture({ version: 1 }))).toEqual({
      version: 1,
      requestedCapabilities: [],
      mcpServers: [],
      ui: [],
    });
  });

  it.each([
    { version: 2 },
    {
      version: 1,
      ui: [{ id: 'bad', slot: 'package-details', title: 'Bad', body: '', script: 'x' }],
    },
    { version: 1, renderer: 'ui.js' },
    { version: 1, auth: { token: 'do-not-import' } },
    {
      version: 1,
      mcpServers: [{ id: 'bad', name: 'Bad', transport: 'http', url: 'https://user:pass@x.test' }],
    },
    {
      version: 1,
      mcpServers: [
        { id: 'bad', name: 'Bad', transport: 'http', url: 'https://x.test/mcp?api_key=secret' },
      ],
    },
    {
      version: 1,
      mcpServers: [{ id: 'bad', name: 'Bad', transport: 'stdio', argv: ['node', '../outside.js'] }],
    },
    {
      version: 1,
      mcpServers: [
        { id: 'bad', name: 'Bad', transport: 'stdio', argv: ['C:\\private\\server.exe'] },
      ],
    },
    {
      version: 1,
      mcpServers: [
        { id: 'bad', name: 'Bad', transport: 'stdio', argv: ['server', '--token=secret'] },
      ],
    },
    {
      version: 1,
      mcpServers: [
        { id: 'bad', name: 'Bad', transport: 'stdio', argv: ['server'], env: { KEY: 'secret' } },
      ],
    },
    {
      version: 1,
      mcpServers: [
        { id: 'same', name: 'A', transport: 'stdio', argv: ['a'] },
        { id: 'same', name: 'B', transport: 'stdio', argv: ['b'] },
      ],
    },
  ])('rejects unsupported or unsafe declarations without echoing content (%#)', (raw) => {
    expect(() => inspectPackageManifest(fixture(raw))).toThrow('invalid Corral package manifest');
  });

  it('bounds files and rejects paths outside the copied package', () => {
    const root = fixture({ version: 1 });
    expect(() => inspectPackageManifest(root, '../outside')).toThrow('invalid package location');
    writeFileSync(join(root, 'package.json'), ' '.repeat(256 * 1024 + 1));
    expect(() => inspectPackageManifest(root)).toThrow('package manifest size limit exceeded');
    writeFileSync(join(root, 'package.json'), '{"malformed":"do-not-echo"');
    expect(() => inspectPackageManifest(root)).toThrow('invalid package manifest JSON');
  });
});
