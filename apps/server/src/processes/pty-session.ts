import { readdirSync, readFileSync } from 'node:fs';
import {
  type LinuxProcessIdentity,
  linuxBootId,
  linuxProcessIdentity,
} from '@corral/adapter-pi/processes';
import type { Scheduler } from '@corral/contracts';

export interface PtySessionIdentity {
  pid: number;
  bootId: string;
  startTicks: string;
  sessionId: number;
  owner: string;
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

/** Capture before admitting input; a numeric PID alone never establishes PTY ownership. */
export function capturePtySession(pid: number, owner: string): PtySessionIdentity {
  const bootId = linuxBootId();
  const identity = bootId && linuxProcessIdentity(pid);
  if (!identity || identity.session !== pid || !alive(identity) || !owner)
    throw new Error('PTY session ownership is unavailable');
  return { pid, bootId, startTicks: identity.startTicks, sessionId: identity.session, owner };
}

/** Ordinary interactive job groups stay in this session; deliberate setsid escapes are not a sandbox. */
export async function cleanupPtySession(
  owned: PtySessionIdentity,
  scheduler: Scheduler = timers,
): Promise<boolean> {
  if (process.platform !== 'linux' || owned.pid !== owned.sessionId) return false;
  const seen = new Map<number, string>();
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const bootId = linuxBootId();
      if (!bootId) return false;
      if (bootId !== owned.bootId) return true;
      const leader = linuxProcessIdentity(owned.pid);
      if (leader && (leader.startTicks !== owned.startTicks || leader.session !== owned.sessionId))
        return false;
      const members: { pid: number; identity: LinuxProcessIdentity }[] = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        const identity = linuxProcessIdentity(pid);
        if (identity?.session === owned.sessionId && alive(identity))
          members.push({ pid, identity });
      }
      if (!members.length) return true;
      const currentLeader = linuxProcessIdentity(owned.pid);
      if (currentLeader && currentLeader.startTicks !== owned.startTicks) return false;
      let proven = Boolean(currentLeader && currentLeader.session === owned.sessionId);
      for (const { pid, identity } of members) {
        if (proven) break;
        let marked = seen.get(pid) === identity.startTicks;
        if (!marked) {
          try {
            marked = readFileSync(`/proc/${pid}/environ`, 'utf8')
              .split('\0')
              .includes(`CORRAL_PROCESS_OWNER=${owned.owner}`);
          } catch (error) {
            if (!missing(error)) return false;
          }
        }
        const current = linuxProcessIdentity(pid);
        proven = Boolean(
          marked &&
            current?.startTicks === identity.startTicks &&
            current.session === owned.sessionId,
        );
      }
      if (!proven) return false;
      for (const { pid, identity } of members) {
        const current = linuxProcessIdentity(pid);
        if (
          !current ||
          !alive(current) ||
          current.startTicks !== identity.startTicks ||
          current.session !== owned.sessionId
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
