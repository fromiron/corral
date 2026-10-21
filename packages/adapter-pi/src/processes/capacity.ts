import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const maxHostProcesses = 12;
const controlType = 'corral:process-capacity';
let activeProcesses = 0;
const reservations = new Map<number, HostProcessReservation>();

export function hasOwnedProcessReservations(): boolean {
  return activeProcesses > 0;
}

export type HostProcessReservation = { releaseConfirmed(): void };
export class HostProcessCapacityError extends Error {
  readonly code = 'host_process_capacity';
  readonly limit = maxHostProcesses;

  constructor() {
    super(`Host process capacity reached (${maxHostProcesses} active process groups)`);
    this.name = 'HostProcessCapacityError';
  }
}

/** The single host counter counts owned groups, not individual descendant PIDs. */
export function reserveHostProcessGroup(): HostProcessReservation {
  if (process.env.CORRAL_PROCESS_CAPACITY_BROKER === '1')
    throw new Error('Worker process groups require host admission');
  if (activeProcesses >= maxHostProcesses) throw new HostProcessCapacityError();
  return restoreHostProcessGroupReservation();
}

/** Existing owners count even above the admission limit; recovery never launches a process. */
export function restoreHostProcessGroupReservation(): HostProcessReservation {
  activeProcesses += 1;
  let held = true;
  return {
    releaseConfirmed() {
      if (!held) return;
      held = false;
      activeProcesses -= 1;
    },
  };
}

export function registerOwnedProcessReservation(pid: number, reservation: HostProcessReservation) {
  // PID reuse must not free an older owner whose termination was uncertain.
  reservations.set(pid, reservation);
}

/** Call only after the OS-owned process group has been confirmed gone. */
export function confirmOwnedProcessCleanup(pid: number) {
  const reservation = reservations.get(pid);
  if (!reservation) return;
  reservations.delete(pid);
  reservation.releaseConfirmed();
}

export function isProcessCapacityFrame(frame: unknown): frame is Record<string, unknown> {
  return (
    typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === controlType
  );
}

/** Tokens belong to one exact child instance; another child cannot release them. */
export function installHostProcessCapacityBroker(child: ChildProcess) {
  const permits = new Map<string, HostProcessReservation>();
  const requests = new Map<string, string>();
  let stopped = false;
  const send = (frame: Record<string, unknown>) => {
    if (child.connected) child.send({ type: controlType, ...frame }, () => {});
  };
  child.on('message', (frame: unknown) => {
    if (!isProcessCapacityFrame(frame) || stopped) return;
    if (
      frame.action === 'acquire' &&
      typeof frame.requestId === 'string' &&
      frame.requestId.length <= 100
    ) {
      const existing = requests.get(frame.requestId);
      if (existing) {
        send(
          permits.has(existing)
            ? { action: 'granted', requestId: frame.requestId, token: existing }
            : { action: 'denied', requestId: frame.requestId },
        );
        return;
      }
      try {
        if (requests.size >= 4096) throw new HostProcessCapacityError();
        const permit = reserveHostProcessGroup();
        const token = randomUUID();
        permits.set(token, permit);
        requests.set(frame.requestId, token);
        send({ action: 'granted', requestId: frame.requestId, token });
      } catch {
        send({ action: 'denied', requestId: frame.requestId });
      }
    } else if (frame.action === 'release' && typeof frame.token === 'string') {
      permits.get(frame.token)?.releaseConfirmed();
      permits.delete(frame.token);
    }
  });
  return {
    stop() {
      // Worker exit/IPC disconnect does not attest its separately owned child groups.
      // Any permit not explicitly returned after confirmed cleanup remains uncertain.
      stopped = true;
    },
  };
}

type Pending = {
  resolve: (permit: HostProcessReservation) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Pending>();
const activeWorkerTokens = new Set<string>();
let listening = false;
function sendToHost(frame: Record<string, unknown>) {
  if (!process.connected || !process.send) throw new Error('Host process admission unavailable');
  process.send({ type: controlType, ...frame });
}
function listenToHost() {
  if (listening) return;
  listening = true;
  process.on('message', (frame: unknown) => {
    if (!isProcessCapacityFrame(frame) || typeof frame.requestId !== 'string') return;
    const request = pending.get(frame.requestId);
    if (frame.action === 'granted' && typeof frame.token === 'string') {
      const token = frame.token;
      if (activeWorkerTokens.has(token)) return;
      let held = true;
      const permit: HostProcessReservation = {
        releaseConfirmed() {
          if (!held) return;
          held = false;
          activeWorkerTokens.delete(token);
          // Disconnect is not cleanup evidence. The host retains tokens until its own recovery.
          if (process.connected) sendToHost({ action: 'release', token });
        },
      };
      if (!request) {
        permit.releaseConfirmed(); // Timed out before a process could be launched.
        return;
      }
      pending.delete(frame.requestId);
      clearTimeout(request.timer);
      activeWorkerTokens.add(token);
      request.resolve(permit);
    } else if (frame.action === 'denied' && request) {
      pending.delete(frame.requestId);
      clearTimeout(request.timer);
      request.reject(new HostProcessCapacityError());
    }
  });
  process.once('disconnect', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Host process admission unavailable'));
    }
    pending.clear();
  });
}

/** MCP transports in SDK children use IPC; they never create a worker-local counter. */
export function acquireHostProcessGroup(): Promise<HostProcessReservation> {
  if (process.env.CORRAL_PROCESS_CAPACITY_BROKER !== '1')
    return Promise.resolve().then(reserveHostProcessGroup);
  listenToHost();
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Host process admission timed out'));
    }, 10000);
    pending.set(requestId, { resolve, reject, timer });
    try {
      sendToHost({ action: 'acquire', requestId });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}
