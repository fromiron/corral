import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Channel, processChannel } from './channel.ts';

/** Preserve the distribution's loader paths, including Debian's separate /usr/lib64. */
export function linuxSystemMounts(): string[] {
  return [
    '--ro-bind',
    '/usr',
    '/usr',
    ...['/bin', '/lib', '/lib64'].flatMap((path) => {
      if (!existsSync(path)) return [];
      const target = realpathSync(path);
      return target.startsWith('/usr/') ? ['--symlink', target, path] : ['--ro-bind', path, path];
    }),
  ];
}

/** Application assets only; never bind the repository root or its .git/private state. */
function applicationMounts(entry: string): string[] {
  const marker = `${process.platform === 'win32' ? '\\' : '/'}node_modules/`;
  const deployed = entry.indexOf(marker);
  if (deployed >= 0) return [join(entry.slice(0, deployed), 'node_modules')];
  let root = dirname(entry);
  while (dirname(root) !== root && !existsSync(join(root, 'pnpm-workspace.yaml')))
    root = dirname(root);
  if (!existsSync(join(root, 'pnpm-workspace.yaml')))
    throw new Error('sandbox application layout is unavailable');
  const paths = [join(root, 'package.json'), join(root, 'node_modules')];
  for (const name of readdirSync(join(root, 'packages'))) {
    for (const part of ['package.json', 'src', 'node_modules']) {
      const path = join(root, 'packages', name, part);
      if (existsSync(path)) paths.push(path);
    }
  }
  if (!paths.some((path) => entry.startsWith(`${path}/`))) paths.push(entry);
  return paths;
}

/** Linux namespaces, fixed read-only code/content, temporary home; no host egress or sockets. */
export function sandboxChannel(
  entry: string,
  options: { leaseDirectory?: string; contentRoots?: string[] } = {},
): Channel {
  if (process.platform !== 'linux')
    throw new Error('Linux worker isolation is unsupported on this OS');
  try {
    execFileSync('/usr/bin/bwrap', ['--version'], { stdio: 'ignore', timeout: 2000 });
  } catch {
    throw new Error('Linux worker isolation requires bubblewrap; no fallback was started');
  }
  const source = realpathSync(entry);
  const mounts = [
    ...new Set([
      ...applicationMounts(source),
      ...(options.contentRoots ?? []).map((path) => realpathSync(path)),
    ]),
  ];
  // Source/deployed application roots are read-only. A selected content root must be specific.
  if (mounts.some((path) => ['/', '/home', '/tmp', '/run', '/etc'].includes(resolve(path))))
    throw new Error('sandbox mount is too broad');
  const args = [
    '--unshare-all',
    '--new-session',
    '--die-with-parent',
    '--cap-drop',
    'ALL',
    '--clearenv',
    ...linuxSystemMounts(),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/home',
    '--dir',
    '/home/worker',
    '--ro-bind',
    process.execPath,
    '/node',
    ...mounts.flatMap((path) => ['--ro-bind', path, path]),
    '--setenv',
    'NODE_CHANNEL_FD',
    '3',
    '--setenv',
    'NODE_CHANNEL_SERIALIZATION_MODE',
    'json',
    '--setenv',
    'HOME',
    '/home/worker',
    '--setenv',
    'CORRAL_WORKER_DIR',
    '/home/worker',
    '--setenv',
    'CORRAL_MODEL_BRIDGE',
    '1',
    '--setenv',
    'CORRAL_PROCESS_CAPACITY_BROKER',
    '1',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--chdir',
    '/home/worker',
    '--',
    '/node',
    '--max-old-space-size=256',
  ];
  return processChannel(source, {
    leaseDirectory: options.leaseDirectory,
    launch: { execPath: '/usr/bin/bwrap', execArgv: args },
  });
}
