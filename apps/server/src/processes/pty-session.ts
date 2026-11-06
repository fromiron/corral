import { readdirSync, readFileSync } from 'node:fs';
import {
  type LinuxProcessIdentity,
  linuxBootId,
  linuxProcessIdentity,
} from '@corral/adapter-pi/processes';
import type { Scheduler } from '@corral/contracts';

/** Saved before input is admitted; a legacy observation may have no process evidence. */
export interface PtyLaunchEvidence {
  bootId: string;
  owner: string;
  pid?: number;
  startTicks?: string;
}

export interface PtySessionIdentity extends PtyLaunchEvidence {
  pid: number;
  startTicks: string;
  sessionId: number;
}

const timers: Scheduler = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const alive = (identity: LinuxProcessIdentity) => !['Z', 'X'].includes(identity.state);
const missing = (error: unknown) =>
  ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

export class PtyIdentityError extends Error {
  readonly code:
    | 'session_not_ready'
    | 'identity_unavailable'
    | 'identity_changed'
    | 'process_exited';
  constructor(
    code: 'session_not_ready' | 'identity_unavailable' | 'identity_changed' | 'process_exited',
  ) {
    super('PTY process identity could not be established');
    this.code = code;
  }
}

/** The PID comes directly from forkpty; capture its birth even before login_tty sets its SID. */
export function observePtyLaunch(pid: number, owner: string, bootId: string): PtyLaunchEvidence {
  const evidence: PtyLaunchEvidence = { pid, owner, bootId };
  try {
    const process = linuxProcessIdentity(pid);
    if (process) evidence.startTicks = process.startTicks;
  } catch {
    // Keep the known spawn/boot evidence so explicit recovery can retry a denied read.
  }
  return evidence;
}

const markedOwner = (pid: number, owner: string) =>
  readFileSync(`/proc/${pid}/environ`, 'utf8')
    .split('\0')
    .includes(`CORRAL_PROCESS_OWNER=${owner}`);

/** forkpty returns in the parent before its child necessarily becomes a session leader. */
export async function waitForPtySession(
  launch: PtyLaunchEvidence,
  scheduler: Scheduler = timers,
): Promise<PtySessionIdentity> {
  if (!launch.pid || !launch.owner || !launch.bootId)
    throw new PtyIdentityError('identity_unavailable');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (linuxBootId() !== launch.bootId) throw new PtyIdentityError('identity_changed');
      const process = linuxProcessIdentity(launch.pid);
      if (!process || !alive(process)) throw new PtyIdentityError('process_exited');
      if (launch.startTicks && launch.startTicks !== process.startTicks)
        throw new PtyIdentityError('identity_changed');
      if (process.session === launch.pid && markedOwner(launch.pid, launch.owner))
        return {
          pid: launch.pid,
          bootId: launch.bootId,
          startTicks: process.startTicks,
          sessionId: process.session,
          owner: launch.owner,
        };
    } catch (error) {
      if (error instanceof PtyIdentityError) throw error;
      throw new PtyIdentityError('identity_unavailable');
    }
    await new Promise<void>((resolve) => scheduler.after(10, resolve));
  }
  throw new PtyIdentityError('session_not_ready');
}

/** Capture before admitting input; a numeric PID alone never establishes PTY ownership. */
export function capturePtySession(pid: number, owner: string): PtySessionIdentity {
  const bootId = linuxBootId();
  const identity = bootId && linuxProcessIdentity(pid);
  if (
    !identity ||
    identity.session !== pid ||
    !alive(identity) ||
    !owner ||
    !markedOwner(pid, owner)
  )
    throw new Error('PTY session ownership is unavailable');
  return { pid, bootId, startTicks: identity.startTicks, sessionId: identity.session, owner };
}

/** Ordinary interactive job groups stay in this session; deliberate setsid escapes are not a sandbox. */
export async function cleanupPtySession(
  owned: PtySessionIdentity,
  scheduler: Scheduler = timers,
): Promise<boolean> {
  if (owned.pid !== owned.sessionId) return false;
  return cleanupPtyLaunch(owned, scheduler);
}

/** A launch can be reconciled without signalling an unproven PID or clearing a live session. */
export async function cleanupPtyLaunch(
  owned: PtyLaunchEvidence,
  scheduler: Scheduler = timers,
): Promise<boolean> {
  if (process.platform !== 'linux' || !owned.bootId || !owned.owner) return false;
  const seen = new Map<number, string>();
  let startTicks = owned.startTicks;
  const established = 'sessionId' in owned;
  let verifiedBirth = established;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const bootId = linuxBootId();
      if (!bootId) return false;
      if (bootId !== owned.bootId) return true;
      // A legacy observation has no PID or birth proof: only a changed OS boot can settle it.
      if (!owned.pid || !Number.isSafeInteger(owned.pid) || owned.pid <= 0) return false;
      const leader = linuxProcessIdentity(owned.pid);
      if (leader) {
        if (startTicks && leader.startTicks !== startTicks) return false;
        if (alive(leader)) {
          if (!verifiedBirth) {
            if (!markedOwner(owned.pid, owned.owner)) {
              // Before exec, forkpty may still expose its parent's environment and SID.
              // An observed birth alone never authorizes signalling a numeric PID.
              if (!startTicks) return false;
              await new Promise<void>((resolve) => scheduler.after(25, resolve));
              continue;
            }
            startTicks ??= leader.startTicks;
            verifiedBirth = true;
          }
          if (leader.session !== owned.pid) return false;
        }
      }
      const members: { pid: number; identity: LinuxProcessIdentity }[] = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        const identity = linuxProcessIdentity(pid);
        if (identity?.session === owned.pid && alive(identity)) members.push({ pid, identity });
      }
      if (!members.length) return true;
      const currentLeader = linuxProcessIdentity(owned.pid);
      if (currentLeader && startTicks && currentLeader.startTicks !== startTicks) return false;
      let proven = Boolean(
        verifiedBirth &&
          currentLeader &&
          startTicks &&
          currentLeader.startTicks === startTicks &&
          currentLeader.session === owned.pid,
      );
      for (const { pid, identity } of members) {
        if (proven) break;
        let marked = seen.get(pid) === identity.startTicks;
        if (!marked) {
          try {
            marked = markedOwner(pid, owned.owner);
          } catch (error) {
            if (!missing(error)) return false;
          }
        }
        const current = linuxProcessIdentity(pid);
        proven = Boolean(
          marked && current?.startTicks === identity.startTicks && current.session === owned.pid,
        );
      }
      if (!proven) return false;
      for (const { pid, identity } of members) {
        const current = linuxProcessIdentity(pid);
        if (
          !current ||
          !alive(current) ||
          current.startTicks !== identity.startTicks ||
          current.session !== owned.pid
        )
          continue;
        seen.set(pid, identity.startTicks);
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (!missing(error)) return false;
        }
      }
      await new Promise<void>((resolve) => scheduler.after(25, resolve));
    }
  } catch {
    // A denied or unreadable /proc record cannot attest cleanup or authorize capacity release.
  }
  return false;
}
