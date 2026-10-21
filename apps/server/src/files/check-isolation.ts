import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Scheduler } from '@corral/contracts';

export function isolatedChecksAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  const probe = spawnSync(
    '/usr/bin/bwrap',
    [
      '--unshare-all',
      '--as-pid-1',
      '--new-session',
      '--die-with-parent',
      '--cap-drop',
      'ALL',
      '--clearenv',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib',
      '/lib64',
      '--',
      '/usr/bin/true',
    ],
    { stdio: 'ignore', timeout: 2000 },
  );
  return !probe.error && probe.status === 0;
}

/** Same namespace boundary as the Pi sandbox; only the captured check copy is writable. */
export async function isolatedCheckLaunch(directory: string, executable: string, argv: string[]) {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))
    throw new Error('Linux check isolation requires bubblewrap; no fallback was started');
  const source = await realpath(executable);
  const path = relative(await realpath(directory), source);
  const inCopy = path !== '..' && !path.startsWith('../') && !isAbsolute(path);
  if (!inCopy && !source.startsWith('/usr/') && source !== (await realpath(process.execPath)))
    throw new Error(
      'isolated check executable must be in the captured tree or the system toolchain',
    );
  const command = inCopy ? `/workspace/${path}` : '/check-executable';
  return {
    executable: '/usr/bin/bwrap',
    args: [
      '--unshare-all',
      '--new-session',
      '--die-with-parent',
      '--cap-drop',
      'ALL',
      '--clearenv',
      '--as-pid-1',
      '--json-status-fd',
      '3',
      '--ro-bind',
      '/usr',
      '/usr',
      '--tmpfs',
      '/usr/local',
      ...(existsSync('/usr/lib/node_modules') ? ['--tmpfs', '/usr/lib/node_modules'] : []),
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/home',
      '--dir',
      '/home/check',
      '--bind',
      resolve(directory),
      '/workspace',
      '--ro-bind',
      '/dev/null',
      '/workspace/.git',
      ...(!inCopy ? ['--ro-bind', source, command] : []),
      '--ro-bind',
      process.execPath,
      '/usr/bin/node',
      '--setenv',
      'HOME',
      '/home/check',
      '--setenv',
      'XDG_CONFIG_HOME',
      '/home/check',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--setenv',
      'CI',
      '1',
      '--setenv',
      'GIT_CONFIG_NOSYSTEM',
      '1',
      '--setenv',
      'GIT_TERMINAL_PROMPT',
      '0',
      '--setenv',
      'NPM_CONFIG_USERCONFIG',
      '/home/check/npmrc',
      '--setenv',
      'NPM_CONFIG_GLOBALCONFIG',
      '/home/check/global-npmrc',
      '--chdir',
      '/workspace',
      '--',
      command,
      ...argv,
    ],
  };
}

/** An exited namespace init kills every descendant, including processes that detached. */
export async function checkNamespaceGone(
  pid: number,
  namespace: number,
  timers: Scheduler,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      if ((await readlink(`/proc/${pid}/ns/pid`)) !== `pid:[${namespace}]`) return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    await new Promise<void>((resolve) => timers.after(50, resolve));
  }
  return false;
}
