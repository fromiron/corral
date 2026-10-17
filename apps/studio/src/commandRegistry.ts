import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { Command } from './commands.ts';
import type { ShortcutId } from './shortcuts.ts';

// The commands Studio can run now (Workbench polish P2/P4). Each screen registers what it can
// do; the ⌘K palette, the composer's `/` menu, the native menu and the global keys all read
// this one list, so a command works the same way from everywhere it shows up.

export interface AppCommand extends Command {
  /** The global shortcut that runs it. */
  shortcutId?: ShortcutId;
  /** Shown in the composer's `/` menu under this name, e.g. `pause`. */
  slash?: string;
  /** Present but not possible now (the reason is in `hint`); still listed so it is findable. */
  disabled?: boolean;
  hint?: string;
  /** For `session.jump`: the digit pressed. */
  jump?: (digit: number) => void;
}

const sources = new Map<string, AppCommand[]>();
const listeners = new Set<() => void>();
let snapshot: AppCommand[] = [];
let signature = '';

const sign = (list: AppCommand[]) =>
  list
    .map((c) => `${c.id}\u0000${c.title}\u0000${c.disabled ? 1 : 0}\u0000${c.hint ?? ''}`)
    .join('\u0001');

function publish() {
  const next = [...sources.values()].flat();
  const nextSignature = sign(next);
  // Closures change on every render; when nothing people can see changed, the same list is
  // kept (readers compare it by identity) and only its functions are brought up to date.
  if (nextSignature === signature) {
    next.forEach((command, index) => {
      Object.assign(snapshot[index] as AppCommand, command);
    });
    return;
  }
  signature = nextSignature;
  snapshot = next.map((command) => ({ ...command }));
  for (const listener of listeners) listener();
}

export function setCommands(source: string, commands: AppCommand[] | null) {
  if (commands) sources.set(source, commands);
  else sources.delete(source);
  publish();
}

/** Registers `commands` while the calling component is mounted; latest closures always win. */
export function useRegisterCommands(source: string, commands: AppCommand[]) {
  useLayoutEffect(() => {
    setCommands(source, commands);
  });
  useLayoutEffect(() => () => setCommands(source, null), [source]);
}

export function registeredCommands(): AppCommand[] {
  return snapshot;
}

export function useRegisteredCommands(): AppCommand[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Runs the registered command for a shortcut; false when none is registered or it is off. */
export function runShortcut(id: ShortcutId, digit?: number): boolean {
  const command = snapshot.find((c) => c.shortcutId === id && !c.disabled);
  if (!command) return false;
  if (id === 'session.jump' && digit !== undefined) {
    command.jump?.(digit);
    return true;
  }
  void command.run();
  return true;
}
