import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareOwnedWindowsProcess } from '../src/processes/owned-process.ts';

it.skipIf(process.platform !== 'win32')(
  'a matching parent PID with a different creation identity cannot start a target',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corral-owner-identity-'));
    const marker = join(directory, 'must-not-exist.txt');
    const launch = prepareOwnedWindowsProcess(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`],
      { cwd: directory },
    );
    const configuration = JSON.parse(
      Buffer.from(launch.args.at(-1) as string, 'base64').toString('utf8'),
    );
    expect(configuration.ownerPid).toBe(process.pid);
    expect(configuration.ownerCreationTime).toMatch(/^\d+$/);
    configuration.ownerCreationTime = '1';
    const child = spawn(
      launch.command,
      [...launch.args.slice(0, -1), Buffer.from(JSON.stringify(configuration)).toString('base64')],
      { cwd: directory, stdio: 'ignore', windowsHide: true },
    );
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      expect(code).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await launch.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
