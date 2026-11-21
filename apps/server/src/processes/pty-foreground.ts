import { type LinuxProcessIdentity, linuxProcessIdentity } from '@corral/adapter-pi/processes';
import type { TerminalForeground } from '@corral/contracts';
import type { PtySessionIdentity } from './pty-session.ts';

type ReadProcess = (pid: number) => LinuxProcessIdentity | null;

const readLinux: ReadProcess = (pid) =>
  process.platform === 'linux' ? linuxProcessIdentity(pid) : null;

/**
 * Whether the shell holds its PTY's foreground (api-contract.md, `foreground`): the terminal's
 * foreground process group (`tpgid`, read from the shell's own stat) against the shell's group.
 * A background job leaves the foreground with the shell, and `exec` keeps the shell's group, so
 * both read idle. Anything unreadable, a reused PID or a shell gone is unknown.
 */
export function ptyForeground(
  shell: PtySessionIdentity,
  read: ReadProcess = readLinux,
): TerminalForeground {
  let stat: LinuxProcessIdentity | null;
  try {
    stat = read(shell.pid);
  } catch {
    return 'unknown';
  }
  if (
    !stat ||
    stat.startTicks !== shell.startTicks ||
    ['Z', 'X'].includes(stat.state) ||
    !Number.isInteger(stat.group) ||
    !Number.isInteger(stat.terminalGroup) ||
    stat.group <= 0 ||
    stat.terminalGroup <= 0
  )
    return 'unknown';
  return stat.terminalGroup === stat.group ? 'idle' : 'busy';
}
