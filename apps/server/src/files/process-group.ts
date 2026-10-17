import type { ChildProcess } from 'node:child_process';
import type { Scheduler } from '@corral/contracts';

export function killProcessGroup(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* Exit confirmation is separate from submitting the signal. */
  }
}

export async function processGroupGone(pid: number, timers: Scheduler): Promise<boolean> {
  // Windows has no POSIX process group: do not claim descendant cleanup there.
  if (process.platform === 'win32') return false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    await new Promise<void>((resolve) => timers.after(50, resolve));
  }
  return false;
}
