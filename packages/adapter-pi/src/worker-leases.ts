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

const Lease = z.strictObject({
  version: z.literal(1),
  pid: z.int().positive(),
  bootId: z.string().max(80).nullable(),
  startTicks: z.string().regex(/^\d+$/).nullable(),
});
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' ||
  (error as NodeJS.ErrnoException).code === 'ESRCH';
function processIdentity(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('worker identity unavailable');
    return { startTicks: fields[19]!, group: Number(fields[2]) };
  } catch (error) {
    if (missing(error)) return null;
    throw new Error('worker identity unavailable');
  }
}
function directoryAt(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error('worker registry is not a directory');
}
const bootId = () =>
  process.platform === 'linux'
    ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    : null;

/** Written before the host sends start; an unrecorded process cannot start codemode work. */
export function recordWorkerLease(directory: string, pid: number): () => void {
  directoryAt(directory);
  const identity = process.platform === 'linux' ? processIdentity(pid) : null;
  if (process.platform === 'linux' && !identity) return () => {};
  if (identity && identity.group !== pid) throw new Error('worker process group is not owned');
  const lease = Lease.parse({
    version: 1,
    pid,
    bootId: bootId(),
    startTicks: identity?.startTicks ?? null,
  });
  const path = join(directory, `${randomUUID()}.json`),
    temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return () => rmSync(path, { force: true });
}

/** Call only after acquiring the workspace owner lock, before admitting any new workers. */
export async function recoverSdkWorkers(directory: string): Promise<void> {
  directoryAt(directory);
  const boot = bootId();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
    if (process.platform === 'linux') {
      if (lease.bootId !== boot) {
        rmSync(path, { force: true });
        continue;
      }
      const identity = processIdentity(lease.pid);
      if (!identity || identity.startTicks !== lease.startTicks) {
        rmSync(path, { force: true });
        continue;
      }
      if (identity.group !== lease.pid) throw new Error('worker cleanup is unconfirmed');
      try {
        process.kill(-lease.pid, 'SIGKILL');
      } catch (error) {
        if (!missing(error)) throw new Error('worker cleanup is unconfirmed');
      }
      let ended = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = processIdentity(lease.pid);
        if (!current || current.startTicks !== lease.startTicks) {
          ended = true;
          break;
        }
        await delay(20);
      }
      if (!ended) throw new Error('worker cleanup is unconfirmed');
    } else {
      try {
        process.kill(lease.pid, 0);
        throw new Error('worker cleanup is unconfirmed');
      } catch (error) {
        if (!missing(error)) throw new Error('worker cleanup is unconfirmed');
      }
    }
    rmSync(path, { force: true });
  }
}
