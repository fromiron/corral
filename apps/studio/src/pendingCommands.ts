import type { AutoRunStart } from '@corral/client';

interface PendingCommand {
  key: string;
  commandId: string;
  autoRequest?: AutoRunStart;
}

/** One host's composer request retains its exact ID across navigation and process restart. */
export function createPendingSessionCommands(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  hostId?: string,
  scope: 'composer' | 'review' = 'composer',
) {
  const cache = new Map<string, PendingCommand>();
  const storageKey = (sessionId: string) =>
    `corral:${scope}-command:v1:${encodeURIComponent(hostId ?? '')}:${encodeURIComponent(sessionId)}`;
  return {
    get(sessionId: string) {
      const existing = cache.get(sessionId);
      if (existing || !storage || !hostId) return existing;
      const raw = storage.getItem(storageKey(sessionId));
      if (!raw) return undefined;
      try {
        const saved = JSON.parse(raw);
        if (
          typeof saved.key !== 'string' ||
          saved.key.length > 1024 * 1024 ||
          typeof saved.commandId !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(saved.commandId)
        )
          throw new Error();
        if (
          saved.autoRequest !== undefined &&
          (!saved.autoRequest ||
            saved.autoRequest.commandId !== saved.commandId ||
            saved.autoRequest.sessionId !== sessionId)
        )
          throw new Error();
        const command: PendingCommand = {
          key: saved.key,
          commandId: saved.commandId,
          ...(saved.autoRequest ? { autoRequest: saved.autoRequest } : {}),
        };
        cache.set(sessionId, command);
        return command;
      } catch {
        throw new Error('Composer request recovery is invalid. No request was resent.');
      }
    },
    set(sessionId: string, value: PendingCommand) {
      if (storage && hostId) storage.setItem(storageKey(sessionId), JSON.stringify(value));
      cache.set(sessionId, value);
    },
    delete(sessionId: string) {
      if (storage && hostId) storage.removeItem(storageKey(sessionId));
      return cache.delete(sessionId);
    },
  };
}
