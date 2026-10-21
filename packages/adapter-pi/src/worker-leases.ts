import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { linuxBootId as bootId, linuxProcessIdentity } from './processes/linux-identity.ts';

const Lease = z.strictObject({
  version: z.literal(1),
  pid: z.int().positive(),
  bootId: z.string().max(80).nullable(),
  startTicks: z.string().regex(/^\d+$/).nullable(),
  owner: z.string().min(1).max(100).optional(),
});
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' ||
  (error as NodeJS.ErrnoException).code === 'ESRCH';
function processIdentity(pid: number) {
  try {
    return linuxProcessIdentity(pid);
  } catch {
    throw new Error('worker identity unavailable');
  }
}
function directoryAt(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error('worker registry is not a directory');
}
/** Written before the host sends start; an unrecorded process cannot start codemode work. */
export function recordWorkerLease(
  directory: string,
  pid: number,
  owner?: string,
): (() => void) & { reap(): Promise<void> } {
  directoryAt(directory);
  const identity = process.platform === 'linux' ? processIdentity(pid) : null;
  if (identity && identity.group !== pid) throw new Error('worker process group is not owned');
  const lease = Lease.parse({
    version: 1,
    pid,
    bootId: bootId(),
    startTicks: identity?.startTicks ?? null,
    ...(owner ? { owner } : {}),
  });
  const path = join(directory, `${randomUUID()}.json`),
    temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  const release = () => {
    if (process.platform === 'linux' && liveGroup(pid)) return;
    rmSync(path, { force: true });
  };
  let reaping: Promise<void> | undefined;
  return Object.assign(release, {
    reap: () => (reaping ??= reapLease(lease).then(() => rmSync(path, { force: true }))),
  });
}

/** Call only after acquiring the workspace owner lock, before admitting any new workers. */
export async function recoverSdkWorkers(directory: string): Promise<void> {
  directoryAt(directory);
  const boot = bootId();
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile()) throw new Error('worker recovery record is invalid');
    const path = join(directory, entry.name);
    let lease: z.infer<typeof Lease>;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (fstatSync(fd).size > 1024) throw new Error('oversized');
      lease = Lease.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } catch {
      throw new Error('worker recovery record is invalid');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    await reapLease(lease, boot);
    rmSync(path, { force: true });
  }
  // Kill SDK owners first; only then can their child registries stop changing.
  for (const entry of readdirSync(directory, { withFileTypes: true }).filter((entry) =>
    entry.name.startsWith('children-'),
  )) {
    if (!entry.isDirectory()) throw new Error('worker child registry is invalid');
    const childDirectory = join(directory, entry.name);
    await recoverSdkWorkers(childDirectory);
    rmSync(childDirectory, { recursive: true, force: true });
  }
}

// A dead group leader does not prove its children stopped. Zombies cannot execute work.
function liveGroup(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (missing(error)) return false;
    throw new Error('worker cleanup is unconfirmed');
  }
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const identity = processIdentity(Number(entry));
    if (identity?.group === pid && identity.state !== 'Z' && identity.state !== 'X') return true;
  }
  return false;
}

function ownedGroup(pid: number, owner: string | undefined): boolean {
  if (!owner) return false;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const identity = processIdentity(Number(entry));
    if (identity?.group !== pid || identity.state === 'Z' || identity.state === 'X') continue;
    try {
      if (
        readFileSync(`/proc/${entry}/environ`, 'utf8')
          .split('\0')
          .includes(`CORRAL_PROCESS_OWNER=${owner}`)
      )
        return true;
    } catch (error) {
      if (!missing(error)) throw new Error('worker cleanup is unconfirmed');
    }
  }
  return false;
}
async function reapLease(lease: z.infer<typeof Lease>, boot = bootId()) {
  if (process.platform === 'linux') {
    if (lease.bootId !== boot) return;
    const identity = processIdentity(lease.pid);
    if (identity && identity.startTicks !== lease.startTicks) return;
    if (identity && identity.group !== lease.pid) throw new Error('worker cleanup is unconfirmed');
    if (!liveGroup(lease.pid)) return;
    if (!identity && !ownedGroup(lease.pid, lease.owner))
      throw new Error('worker cleanup is unconfirmed');
    try {
      process.kill(-lease.pid, 'SIGKILL');
    } catch (error) {
      if (!missing(error)) throw new Error('worker cleanup is unconfirmed');
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!liveGroup(lease.pid)) return;
      await delay(20);
    }
    throw new Error('worker cleanup is unconfirmed');
  }
  try {
    process.kill(lease.pid, 0);
    throw new Error('worker cleanup is unconfirmed');
  } catch (error) {
    if (!missing(error)) throw new Error('worker cleanup is unconfirmed');
  }
}
