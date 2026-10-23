import { readFileSync } from 'node:fs';

export interface LinuxProcessIdentity {
  startTicks: string;
  group: number;
  session: number;
  state: string;
}

/** The command name may contain spaces and parentheses; stat fields follow its final ')'. */
export function linuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    const state = fields[0];
    if (!startTicks || !/^\d+$/.test(startTicks) || !state)
      throw new Error('Process identity unavailable');
    return {
      startTicks,
      group: Number(fields[2]),
      session: Number(fields[3]),
      state,
    };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw new Error('Process identity unavailable');
  }
}

export const linuxBootId = () =>
  process.platform === 'linux'
    ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    : null;
