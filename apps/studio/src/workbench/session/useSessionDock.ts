// The conversation's bottom dock: its state from this device's memory on entry, written back on
// each change, and its restored terminal tabs checked once against the first terminal list that
// answers after entry (features/session-panel.md 하단 도크, 주소와 기억). The session page stays
// mounted across conversations, so everything here is keyed by the conversation.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DockEvent,
  type DockState,
  readDockMemory,
  reduceDock,
  restoredDock,
  writeDockMemory,
} from '../panel/dock.ts';
import { deviceStorage } from '../panel/memory.ts';
import type { TerminalStore } from '../terminals/store.ts';
import { WORKSPACE_CHANGED } from '../workspaceEvents.ts';

export interface SessionDock {
  readonly dock: DockState;
  /** Applies an event to this conversation's dock; a dispatch meant for one left is dropped. */
  dispatch(event: DockEvent, sessionId?: string): void;
  /** The conversation's terminal list, read now: resolves once it answered (or failed). */
  refreshTerminals(): Promise<void>;
}

export function useSessionDock(sessionId: string, terminals: TerminalStore | null): SessionDock {
  const [held, setHeld] = useState(() => ({
    sessionId,
    dock: restoredDock(readDockMemory(deviceStorage(), sessionId)),
  }));
  // Entering another conversation: its own memory, from this render on.
  const current =
    held.sessionId === sessionId
      ? held
      : { sessionId, dock: restoredDock(readDockMemory(deviceStorage(), sessionId)) };
  if (current !== held) setHeld(current);
  const here = useRef(sessionId);
  here.current = sessionId;
  const dispatch = useCallback((event: DockEvent, from?: string) => {
    const target = from ?? here.current;
    setHeld((previous) => {
      const base =
        previous.sessionId === target
          ? previous
          : target === here.current
            ? { sessionId: target, dock: restoredDock(readDockMemory(deviceStorage(), target)) }
            : null;
      if (!base) return previous;
      const dock = reduceDock(base.dock, event);
      return dock === base.dock && base === previous ? previous : { sessionId: target, dock };
    });
  }, []);
  // Each change is remembered for this conversation; a write that fails is silent.
  const written = useRef<DockState | null>(null);
  useEffect(() => {
    if (current.sessionId !== sessionId || written.current === current.dock) return;
    written.current = current.dock;
    writeDockMemory(deviceStorage(), sessionId, current.dock);
  }, [current.dock, current.sessionId, sessionId]);

  const refreshTerminals = useCallback(async () => {
    if (terminals) await terminals.refresh(here.current);
  }, [terminals]);
  // The list's first answer after entry checks the restored tabs; later answers never do.
  useEffect(() => {
    if (!terminals) {
      dispatch({ type: 'terminals', ids: null }, sessionId);
      return;
    }
    let live = true;
    void terminals.refresh(sessionId).then(() => {
      if (!live) return;
      const value = terminals.getState().sessions[sessionId];
      dispatch(
        {
          type: 'terminals',
          ids: value?.list ? value.list.terminals.map((terminal) => terminal.terminalId) : null,
        },
        sessionId,
      );
    });
    // A Paddock made or removed changes what the list says.
    const refresh = () => void terminals.refresh(sessionId);
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => {
      live = false;
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [terminals, sessionId, dispatch]);
  return { dock: current.dock, dispatch, refreshTerminals };
}
