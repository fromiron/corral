import { RunCommand, RunEvent } from '@corral/contracts';
import { canonicalJson } from '@corral/core';

export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RunRecovery {
  commands(runId: string): RunCommand[];
  pending(command: RunCommand): void;
  confirmed(runId: string, commandId: string): void;
  events(runId: string): RunEvent[];
  committed(runId: string, events: RunEvent[]): void;
}

/** Storage is already bound to one host. The namespace remains explicit for browser clients. */
export function createRunRecovery(storage: RecoveryStorage, namespace: string): RunRecovery {
  if (!namespace) throw new Error('A recovery host namespace is required.');
  const key = (runId: string, kind: string) =>
    `corral:run-recovery:v1:${encodeURIComponent(namespace)}:${encodeURIComponent(runId)}:${kind}`;
  const commands = (runId: string): RunCommand[] => {
    try {
      const raw = storage.getItem(key(runId, 'commands'));
      if (!raw) return [];
      if (raw.length > 2 * 1024 * 1024) throw new Error();
      const values: unknown = JSON.parse(raw);
      if (!Array.isArray(values) || values.length > 100) throw new Error();
      const parsed = values.map((value) => RunCommand.parse(value));
      if (
        parsed.some((command) => command.runId !== runId) ||
        new Set(parsed.map((command) => command.commandId)).size !== parsed.length
      )
        throw new Error();
      return parsed;
    } catch {
      throw new Error('Command recovery storage is unavailable or invalid. No command was resent.');
    }
  };
  const saveCommands = (runId: string, values: RunCommand[]) => {
    try {
      const raw = JSON.stringify(values);
      if (values.length > 100 || raw.length > 2 * 1024 * 1024) throw new Error();
      storage.setItem(key(runId, 'commands'), raw);
    } catch {
      throw new Error(
        'Could not save command recovery state. Check the host receipt before retrying.',
      );
    }
  };
  return {
    commands,
    pending(command) {
      const saved = commands(command.runId);
      const prior = saved.find((entry) => entry.commandId === command.commandId);
      if (prior && canonicalJson(prior) !== canonicalJson(command))
        throw new Error('A recovery command ID already belongs to another request.');
      if (!prior) saveCommands(command.runId, [...saved, command]);
    },
    confirmed(runId, commandId) {
      saveCommands(
        runId,
        commands(runId).filter((command) => command.commandId !== commandId),
      );
    },
    events(runId) {
      try {
        const raw = storage.getItem(key(runId, 'events'));
        if (!raw || raw.length > 4 * 1024 * 1024) return [];
        const values: unknown = JSON.parse(raw);
        if (!Array.isArray(values)) return [];
        const parsed = values.map((value) => RunEvent.parse(value));
        if (parsed.some((event, index) => event.runId !== runId || event.runSeq !== index + 1))
          return [];
        return parsed;
      } catch {
        // A lost event cache is replayable. A cursor alone must never skip missing history.
        return [];
      }
    },
    committed(runId, events) {
      try {
        const value = JSON.stringify(events);
        if (value.length > 4 * 1024 * 1024) storage.removeItem(key(runId, 'events'));
        else storage.setItem(key(runId, 'events'), value);
      } catch {
        // Keep the previous contiguous prefix; the server supplies every missing event.
      }
    },
  };
}
