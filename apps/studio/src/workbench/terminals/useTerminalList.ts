// The conversation's terminal list as the session screen reads it (features/session-panel.md
// 주소와 기억, 여는 길): asked once on entering the conversation and again when a Paddock is made
// or removed; until that first ask answers, nothing that waits for the list is decided.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TerminalListAnswer } from '../panel/terminalPlace.ts';
import { WORKSPACE_CHANGED } from '../workspaceEvents.ts';
import { liveTerminal } from './creation.ts';
import type { TerminalStore } from './store.ts';

type SessionTerminals = ReturnType<TerminalStore['getState']>['sessions'][string];

const noSubscription = () => () => {};

export interface TerminalList {
  /** The store's state for the conversation (its list, loading, pending creation). */
  readonly value: SessionTerminals | undefined;
  /** What the list has said since this entry. */
  readonly answer: TerminalListAnswer;
}

export function useTerminalList(sessionId: string, store: TerminalStore | null): TerminalList {
  const read = () => (store ? store.getState().sessions[sessionId] : undefined);
  const value = useSyncExternalStore(store?.subscribe ?? noSubscription, read, read);
  // The conversation whose first ask after entry has come back (answered or failed).
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    if (!store) return;
    let live = true;
    void store.refresh(sessionId).then(() => {
      if (live) setAsked(sessionId);
    });
    // A Paddock made or removed changes what the list says.
    const refresh = () => void store.refresh(sessionId);
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => {
      live = false;
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [store, sessionId]);
  const answer: TerminalListAnswer =
    !store || asked !== sessionId
      ? store
        ? { kind: 'waiting' }
        : { kind: 'failed' }
      : value?.list
        ? {
            kind: 'answered',
            ids: value.list.terminals.map((terminal) => terminal.terminalId),
            live: liveTerminal(value)?.terminalId ?? null,
          }
        : { kind: 'failed' };
  return { value, answer };
}
