import type { SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ownedWindowsProcessGone,
  spawnOwnedProcess,
  stopOwnedWindowsProcess,
} from '../src/processes/owned-process.ts';

const folders: string[] = [];
function fixture(extension = 'cmd') {
  const directory = mkdtempSync(join(tmpdir(), 'corral batch %PATH% !literal! & (argv) '));
  folders.push(directory);
  writeFileSync(
    join(directory, 'argv.cjs'),
    'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode=9;',
  );
  const command = join(directory, `literal tool.${extension}`);
  writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
  return { directory, command };
}
async function run(executable: string, args: string[], options: SpawnOptions = {}) {
  const child = spawnOwnedProcess(executable, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => stopOwnedWindowsProcess(child), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(await ownedWindowsProcessGone(child.pid as number)).toBe(true);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')(
  '[TC-ABS-001-H] [TC-ABS-001-N] Windows batch argv',
  () => {
    it.each(['cmd', 'bat'])(
      'owns a .%s shim with a spaced path and forwards literal arguments without expansion',
      async (extension) => {
        const { directory, command } = fixture(extension);
        const marker = join(directory, 'injected.txt');
        const args = [
          '',
          'a b',
          '한글',
          'a"b',
          'tail\\',
          'quoted\\"end',
          'a&b',
          'x^y',
          '%PATH%',
          '%CORRAL_ARG_TEST%',
          '!CORRAL_ARG_TEST!',
          '100%',
          '()[];,*?`<>|',
          `a" & echo injected > "${marker}" & rem "`,
        ];
        const result = await run(command, args, {
          env: { ...process.env, CORRAL_ARG_TEST: 'must not expand' },
        });
        expect(result.code).toBe(9);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(args);
        expect(existsSync(marker)).toBe(false);
      },
      25000,
    );

    it('uses case-insensitive PATH/PATHEXT and resolves relative paths from the requested cwd', async () => {
      const { directory } = fixture();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !['path', 'pathext'].includes(key.toLowerCase()),
        ),
      );
      Object.assign(env, { pAtH: `"${directory}"`, pAtHeXt: '.CMD;.EXE' });
      expect(JSON.parse((await run('literal tool', ['via PATH'], { env })).stdout)).toEqual([
        'via PATH',
      ]);
      expect(
        JSON.parse((await run('.\\literal tool', ['via cwd'], { cwd: directory })).stdout),
      ).toEqual(['via cwd']);
    }, 25000);

    it('rejects line breaks and NUL rather than interpreting them as batch source', () => {
      const { command } = fixture();
      for (const arg of ['a\nb', 'a\rb', 'a\0b']) {
        expect(() => spawnOwnedProcess(command, [arg])).toThrow(/batch.*argument/i);
      }
      expect(() => spawnOwnedProcess(command, ['x'.repeat(8192)])).toThrow(/8191/);
    });

    it('runs the installed npx CMD shim without an install or network operation', async () => {
      const result = await run('npx.cmd', ['--version']);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    }, 25000);

    it('keeps multiline native argv and intentional multiline CMD source distinct', async () => {
      const args = ['first\nsecond', 'a" & echo unexpected', '%PATH%'];
      const native = await run(process.execPath, [
        '-e',
        'console.log(JSON.stringify(process.argv.slice(1)))',
        ...args,
      ]);
      expect(native.code).toBe(0);
      expect(JSON.parse(native.stdout)).toEqual(args);
      const source = await run(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        ['/d', '/s', '/c', 'echo 한글\r\necho second\r\nexit /b 9'],
      );
      expect(source.code).toBe(9);
      expect(source.stderr).toBe('');
      expect(source.stdout.trim().split(/\r?\n/)).toEqual(['한글', 'second']);
    }, 25000);
  },
);
