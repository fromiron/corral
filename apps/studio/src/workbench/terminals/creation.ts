// Whether this conversation can have a new terminal now, and if not why, in one place: the "+"
// lists, the bottom dock opening empty and the terminal screen read the same answer
// (features/session-panel.md 하단 도크, workbench.md 사용자 터미널).
import type { TerminalView } from '@corral/contracts';
import type { TerminalStore } from './store.ts';

type SessionTerminals = ReturnType<TerminalStore['getState']>['sessions'][string];

/** Why no terminal can be made now, in the order the checks hold it back. */
export type CreationBlock =
  /** The list has not answered yet. */
  | 'loading'
  /** The list could not be read. */
  | 'listFailed'
  /** The conversation has no Paddock. */
  | 'noCopy'
  /** A creation is still unconfirmed. */
  | 'createPending'
  /** A live terminal already holds the Paddock. */
  | 'createHeld'
  /** A run of this conversation is going on a host without sharing. */
  | 'runActive'
  /** The host offers no terminal here (no trusted Paddock, no shell, not qualified). */
  | 'unavailable';

export type Creation =
  | { readonly ok: true; readonly shells: readonly { id: string; label: string }[] }
  | { readonly ok: false; readonly reason: CreationBlock };

/** A terminal that has not ended (starting, running, stopping, termination unconfirmed). */
export const isLive = (terminal: Pick<TerminalView, 'state'>) =>
  terminal.state !== 'exited' && terminal.state !== 'failed';

/** The conversation's live terminal: one per Paddock. */
export function liveTerminal(value: SessionTerminals | undefined): TerminalView | null {
  return value?.list?.terminals.find(isLive) ?? null;
}

export function terminalCreation(
  value: SessionTerminals | undefined,
  runActive: boolean,
  sharedDevelopment: boolean,
): Creation {
  const list = value?.list;
  if (!list) return { ok: false, reason: value?.error ? 'listFailed' : 'loading' };
  if (!list.target) return { ok: false, reason: 'noCopy' };
  if (value.pendingCreate) return { ok: false, reason: 'createPending' };
  if (list.terminals.some(isLive)) return { ok: false, reason: 'createHeld' };
  if (runActive && !sharedDevelopment) return { ok: false, reason: 'runActive' };
  if (value.loading) return { ok: false, reason: 'loading' };
  if (!list.available || list.shells.length === 0) return { ok: false, reason: 'unavailable' };
  return { ok: true, shells: list.shells };
}
