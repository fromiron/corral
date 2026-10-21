import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson, type RegisteredCheck } from '@corral/contracts';
import { isolatedCheckLaunch } from './check-isolation.ts';

const LOCKFILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'uv.lock',
  'poetry.lock',
];
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const missing = (error: unknown) =>
  ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );

async function fileHash(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256 * 1024 * 1024)
      throw new Error('launch file exceeds supported size');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat();
    if (
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs ||
      after.size !== info.size
    )
      throw new Error('launch file changed during inspection');
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

async function executablePath(command: string, root: string) {
  const candidates =
    command.includes('/') || command.includes('\\') || isAbsolute(command)
      ? [resolve(root, command)]
      : (process.env.PATH ?? '/usr/bin:/bin')
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) => {
            const base = join(directory, command);
            return process.platform === 'win32' && !/\.[A-Za-z]+$/.test(command)
              ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
                  .split(';')
                  .map((ext) => base + ext.toLowerCase())
              : [base];
          });
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) {
      if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
    }
  }
  throw new Error('registered executable is unavailable');
}

/** Private launch identity: public records receive only the resulting hash. */
export async function launchFingerprint(
  directory: string,
  revision: number,
  command: RegisteredCheck,
  externalExecutables: string[] = [],
) {
  const root = await realpath(directory);
  const executable = await executablePath(command.argv[0] as string, root);
  const external = await Promise.all(
    externalExecutables.map(async (path) => {
      const resolved = await executablePath(path, root);
      return { path: resolved, hash: await fileHash(resolved) };
    }),
  );
  const files: Record<string, string | null> = {};
  for (const name of new Set([
    ...LOCKFILES,
    ...command.argv.slice(1).filter((arg) => !arg.startsWith('-')),
  ])) {
    const path = resolve(root, name);
    try {
      const resolved = await realpath(path);
      const scope = relative(root, resolved);
      if (scope.startsWith('..') || isAbsolute(scope))
        throw new Error('launch input is outside the worktree scope');
      if ((await stat(resolved)).isFile()) files[name] = await fileHash(resolved);
    } catch (error) {
      if (!missing(error)) throw error;
      if (LOCKFILES.includes(name)) files[name] = null;
    }
  }
  return {
    executable,
    fingerprint: hash({
      revision,
      command,
      executable: await fileHash(executable),
      files,
      ...(external.length ? { external } : {}),
      nodeVersion: process.version,
    }),
  };
}

export async function checkLaunchFingerprint(
  directory: string,
  revision: number,
  command: RegisteredCheck,
  isolation?: 'linux-bwrap',
) {
  const launch = await launchFingerprint(
    directory,
    revision,
    command,
    isolation ? ['/usr/bin/bwrap', process.execPath] : [],
  );
  if (!isolation) return launch;
  const sandbox = await isolatedCheckLaunch(directory, launch.executable, command.argv.slice(1));
  return {
    ...launch,
    fingerprint: hash({
      launch: launch.fingerprint,
      isolation,
      policy: 1,
      executable: sandbox.executable,
      args: sandbox.args.map((arg) => (arg === resolve(directory) ? '<captured-tree>' : arg)),
    }),
  };
}
