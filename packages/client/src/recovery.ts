import type { RunCommand } from '@corral/contracts';
import { canonicalJson } from '@corral/core';

export interface CommandRecovery {
  commands(runId: string): RunCommand[];
  pending(command: RunCommand): void;
  confirmed(runId: string, commandId: string): void;
}
export interface StartRecovery {
  /** Explicit retries may receive a fresh UI ID; match only the entire immutable request. */
  prepare<T extends { commandId: string }>(path: string, request: T): T;
  pending(path: string, request: { commandId: string }): void;
  confirmed(commandId: string): void;
}

/** Request IDs survive a renderer reload; bodies remain bound to that exact ID and host. */
export function createStartRecovery(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  hostId: string,
): StartRecovery {
  const key = `corral:start-recovery:v1:${encodeURIComponent(hostId)}`;
  const read = (): Record<string, { path: string; request: { commandId: string } }> => {
    const raw = storage.getItem(key);
    if (!raw) return {};
    try {
      if (raw.length > 2 * 1024 * 1024) throw new Error();
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      for (const [id, entry] of Object.entries(value)) {
        const item = entry as { path?: unknown; request?: { commandId?: unknown } };
        if (
          !['/runs', '/runs/auto', '/runs/explain'].includes(String(item.path)) ||
          item.request?.commandId !== id
        )
          throw new Error();
      }
      return value;
    } catch {
      throw new Error('Start recovery state is invalid. No start request was sent.');
    }
  };
  const save = (value: ReturnType<typeof read>) => {
    try {
      const raw = JSON.stringify(value);
      if (Object.keys(value).length > 100 || raw.length > 2 * 1024 * 1024) throw new Error();
      storage.setItem(key, raw);
    } catch {
      throw new Error('Could not persist start recovery state.');
    }
  };
  return {
    prepare(path, request) {
      const identity = canonicalJson({ ...request, commandId: '' });
      const prior = Object.values(read()).find(
        (entry) =>
          entry.path === path && canonicalJson({ ...entry.request, commandId: '' }) === identity,
      );
      return prior ? { ...request, commandId: prior.request.commandId } : request;
    },
    pending(path, request) {
      const saved = read();
      const entry = { path, request };
      if (
        saved[request.commandId] &&
        canonicalJson(saved[request.commandId]) !== canonicalJson(entry)
      )
        throw new Error('This start command ID belongs to a different request.');
      if (!saved[request.commandId]) save({ ...saved, [request.commandId]: entry });
    },
    confirmed(commandId) {
      const saved = read();
      delete saved[commandId];
      save(saved);
    },
  };
}
