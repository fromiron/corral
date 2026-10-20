import type { ChildProcess } from 'node:child_process';
import type { Scheduler } from '@corral/contracts';
import {
  confirmOwnedProcessCleanup,
  ownedWindowsProcessGone,
  stopOwnedWindowsProcess,
} from '../processes/owned-process.ts';

export function killProcessGroup(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      if (!stopOwnedWindowsProcess(child)) child.kill('SIGKILL');
    } else process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* Exit confirmation is separate from submitting the signal. */
  }
}

export async function processGroupGone(pid: number, timers: Scheduler): Promise<boolean> {
  // Only our native Job owner can attest descendant termination; arbitrary PIDs cannot.
  if (process.platform === 'win32') {
    const gone = await ownedWindowsProcessGone(pid);
    if (gone) confirmOwnedProcessCleanup(pid);
    return gone;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
      if (gone) confirmOwnedProcessCleanup(pid);
      return gone;
    }
    await new Promise<void>((resolve) => timers.after(50, resolve));
  }
  return false;
}
