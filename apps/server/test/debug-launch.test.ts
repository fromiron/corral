import { chmodSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { debugLaunch, debugSourceMapLocations } from '../src/files/debug-launch.ts';
import { fileHash } from '../src/files/launch-fingerprint.ts';

it('fingerprints a large Chromium binary while preserving the ordinary launch bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-debug-large-binary-'));
  try {
    const executable = join(root, 'chromium');
    writeFileSync(executable, 'fixture');
    truncateSync(executable, 257 * 1024 * 1024);
    chmodSync(executable, 0o700);
    const adapter = { id: 'jsdebug', name: 'Debug', argv: [process.execPath], timeoutMs: 5000 };
    const configuration = {
      id: 'browser',
      name: 'Browser',
      adapterId: 'jsdebug',
      runtime: 'chromium' as const,
      request: 'launch' as const,
      cwd: '.',
      executablePath: executable,
    };
    await expect(debugLaunch(root, 1, adapter, configuration, {})).resolves.toMatchObject({
      runtimeExecutable: executable,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(fileHash(executable)).rejects.toThrow('launch file exceeds supported size');
    truncateSync(executable, 513 * 1024 * 1024);
    await expect(debugLaunch(root, 1, adapter, configuration, {})).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('allows only captured local maps at the owned preview origin for browser fallback', () => {
  const paths = ['out/browser.js.map', 'out/unrelated.js', '../escape.map', 'out/wild*.map'];
  expect(debugSourceMapLocations('/copy', paths, 'http://127.0.0.2:43123/')).toEqual([
    '/copy/**',
    'http://127.0.0.2:43123/out/browser.js.map',
  ]);
  expect(debugSourceMapLocations('/copy', paths)).toEqual(['/copy/**']);
  expect(() => debugSourceMapLocations('/copy', paths, 'https://external.example/')).toThrow();
});
