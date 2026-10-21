import { type ChildProcess, execFileSync, type SpawnOptions, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  confirmOwnedProcessCleanup,
  registerOwnedProcessReservation,
  reserveHostProcessGroup,
} from './capacity.ts';
import { prepareWindowsCommand, resolveWindowsExecutable } from './windows-command.ts';

export {
  confirmOwnedProcessCleanup,
  HostProcessCapacityError,
  type HostProcessReservation,
  hasOwnedProcessReservations,
  reserveHostProcessGroup,
  restoreHostProcessGroupReservation,
} from './capacity.ts';
export { type LinuxProcessIdentity, linuxBootId, linuxProcessIdentity } from './linux-identity.ts';

type Ownership = {
  directory: string;
  status: string;
  confirmed?: boolean;
  query?: Promise<boolean>;
};
const owned = new Map<number, Ownership>();
let ownerCreationTime: string | undefined;

/** Read while this host is alive; helper startup must never authorize a reused parent PID. */
function currentOwnerCreationTime(): string {
  if (ownerCreationTime) return ownerCreationTime;
  const value = execFileSync(
    windowsPowerShell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `([Diagnostics.Process]::GetProcessById(${process.pid})).StartTime.ToFileTimeUtc().ToString()`,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    },
  ).trim();
  if (!/^\d{1,19}$/.test(value)) throw new Error('Process owner identity is unavailable');
  ownerCreationTime = value;
  return value;
}

export function windowsPowerShell() {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/** A returned Windows child is the job owner, not the untrusted command leader. */
export function spawnOwnedProcess(
  executable: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const reservation = reserveHostProcessGroup();
  try {
    const child = spawnUnmeteredOwnedProcess(executable, args, options);
    if (child.pid) registerOwnedProcessReservation(child.pid, reservation);
    else reservation.releaseConfirmed();
    return child;
  } catch (error) {
    reservation.releaseConfirmed();
    throw error;
  }
}

function spawnUnmeteredOwnedProcess(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (process.platform !== 'win32')
    return spawn(executable, args, { ...options, shell: false, detached: true });
  const prepared = prepareOwnedWindowsProcess(executable, args, options);
  const child = spawn(prepared.command, prepared.args, {
    ...options,
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...(options.env ?? process.env),
    },
  });
  if (child.pid) prepared.register(child.pid);
  else void prepared.dispose();
  child.stdin?.on('error', () => {});
  return child;
}

/** For transports which spawn internally: register the returned helper PID immediately. */
export function prepareOwnedWindowsProcess(
  executable: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
) {
  if (process.platform !== 'win32') throw new Error('Windows ownership is unavailable');
  const resolvedExecutable = resolveWindowsExecutable(executable, options);
  const creationTime = currentOwnerCreationTime();
  const directory = mkdtempSync(join(tmpdir(), 'corral-process-'));
  const status = join(directory, 'result.json');
  let launch: ReturnType<typeof prepareWindowsCommand>;
  try {
    launch = prepareWindowsCommand(resolvedExecutable, args, directory);
  } catch (error) {
    void rm(directory, { recursive: true, force: true });
    throw error;
  }
  const configuration = Buffer.from(
    JSON.stringify({
      executable: launch.executable,
      args: launch.args,
      cwd: options.cwd
        ? resolve(typeof options.cwd === 'string' ? options.cwd : fileURLToPath(options.cwd))
        : process.cwd(),
      status,
      ownerPid: process.pid,
      ownerCreationTime: creationTime,
    }),
  ).toString('base64');
  return {
    command: windowsPowerShell(),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./windows-job.ps1', import.meta.url)),
      configuration,
    ],
    register(pid: number) {
      owned.set(pid, { directory, status });
    },
    stop() {
      writeFileSync(`${status}.stop`, '');
    },
    dispose() {
      return rm(directory, { recursive: true, force: true });
    },
  };
}

export function stopOwnedWindowsProcess(child: ChildProcess): boolean {
  if (!child.pid || !owned.has(child.pid)) return false;
  if (child.exitCode === null && child.signalCode === null) {
    const ownership = owned.get(child.pid) as Ownership;
    writeFileSync(`${ownership.status}.stop`, '');
  }
  return true;
}

export async function ownedWindowsProcessGone(pid: number): Promise<boolean> {
  const ownership = owned.get(pid);
  if (!ownership) return false;
  if (ownership.confirmed !== undefined) return ownership.confirmed;
  try {
    const result = JSON.parse(await readFile(ownership.status, 'utf8'));
    ownership.confirmed = result.cleanupConfirmed === true;
    if (ownership.confirmed) confirmOwnedProcessCleanup(pid);
    await rm(ownership.directory, { recursive: true, force: true });
    // A bounded recent confirmation cache allows repeated cleanup readback.
    if (owned.size > 1024) {
      for (const [key, value] of owned) {
        if (value.confirmed !== undefined && key !== pid) owned.delete(key);
        if (owned.size <= 1024) break;
      }
    }
    return ownership.confirmed;
  } catch {
    return false;
  }
}

export async function ownedProcessStarted(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return false;
  if (process.platform !== 'win32') return child.exitCode === null && child.signalCode === null;
  const ownership = owned.get(child.pid);
  if (!ownership) return false;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null || existsSync(ownership.status))
      return false;
    if (existsSync(`${ownership.status}.started`)) return true;
    await delay(50);
  }
  return false;
}

/** Connect first without sending HTTP/WS bytes; attest this exact established socket pair. */
export function attestOwnedWindowsConnection(
  pid: number,
  port: number,
  peerPort: number,
): Promise<boolean> {
  const ownership = owned.get(pid);
  if (
    !ownership ||
    ownership.confirmed !== undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(peerPort) ||
    peerPort < 1 ||
    peerPort > 65535
  )
    return Promise.resolve(false);
  const run = async () => {
    if (ownership.confirmed !== undefined || existsSync(ownership.status)) return false;
    const nonce = randomUUID().replaceAll('-', '');
    const temporary = `${ownership.status}.${nonce}.query`;
    try {
      await writeFile(temporary, `${nonce}|${port}|${peerPort}`, { flag: 'wx' });
      await rename(temporary, `${ownership.status}.query`);
      for (let attempt = 0; attempt < 40; attempt++) {
        if (ownership.confirmed !== undefined || existsSync(ownership.status)) return false;
        try {
          const response = JSON.parse(await readFile(`${ownership.status}.connection`, 'utf8'));
          if (response.nonce === nonce) return response.owned === true;
        } catch {}
        await delay(50);
      }
      return false;
    } catch {
      return false;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  };
  const result = (ownership.query ?? Promise.resolve(false)).then(run, run);
  ownership.query = result;
  return result;
}
