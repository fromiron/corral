import type { ChildProcess } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { attestOwnedWindowsConnection } from './owned-process.ts';

/** Attest a connected loopback TCP socket; no URL or numeric listener port confers trust. */
export async function attestProcessConnection(child: ChildProcess, port: number, peerPort: number) {
  if (
    !child.pid ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(peerPort) ||
    peerPort < 1 ||
    peerPort > 65535
  )
    return false;
  if (process.platform === 'win32') return attestOwnedWindowsConnection(child.pid, port, peerPort);
  if (process.platform !== 'linux') return false;
  const address = (number: number) =>
    `0100007F:${number.toString(16).padStart(4, '0').toUpperCase()}`;
  try {
    const rows = (await readFile('/proc/net/tcp', 'utf8'))
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/));
    const inodes = new Set(
      rows
        .filter(
          (row) => row[1] === address(port) && row[2] === address(peerPort) && row[3] === '01',
        )
        .map((row) => row[9]),
    );
    if (!inodes.size) return false;
    const identity = async (pid: string) => {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = raw
        .slice(raw.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return { group: fields[2], start: fields[19], state: fields[0] };
    };
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const before = await identity(pid);
        if (before.group !== String(child.pid) || ['Z', 'X'].includes(before.state ?? '')) continue;
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
          if (!inodes.has(/^socket:\[(\d+)\]$/.exec(link)?.[1])) continue;
          const after = await identity(pid);
          if (
            before.start === after.start &&
            before.group === after.group &&
            !['Z', 'X'].includes(after.state ?? '') &&
            child.exitCode === null &&
            child.signalCode === null
          )
            return true;
        }
      } catch {
        /* A process exiting during inspection is not an ownership confirmation. */
      }
    }
  } catch {
    /* Missing platform evidence means unconfirmed ownership. */
  }
  return false;
}
