import { createContext, useContext, useState } from 'react';
import { createStore, type StoreApi, useStore } from 'zustand';

interface TrayState {
  /** The tray is in the conversation's view: not scrolled away, not behind the composer. */
  visible: boolean;
  /** Requests waiting in the tray, over all of the session's runs. */
  waiting: number;
  /** When a request to bring the tray into view and focus it was made (`respond`); 0 for none. */
  revealAt: number;
}

/** The needed-now tray's state on one session screen. */
export type PendingTrayStore = StoreApi<TrayState>;

export const createPendingTrayStore = (): PendingTrayStore =>
  createStore<TrayState>(() => ({ visible: false, waiting: 0, revealAt: 0 }));

/** Asks the tray to come into view and take focus, once, as soon as it shows what waits. */
export function revealPendingTray(store: PendingTrayStore) {
  store.setState({ revealAt: performance.now() });
}

interface PendingTrayContextValue {
  store: PendingTrayStore;
  /**
   * Takes the person from elsewhere on the session screen (the run record, the composer's
   * notice) to the tray: the one place the session's waiting requests are answered.
   */
  respond?: () => void;
}

export const PendingTrayContext = createContext<PendingTrayContextValue | null>(null);

export function useTrayStore() {
  const context = useContext(PendingTrayContext);
  const [own] = useState(createPendingTrayStore);
  return context?.store ?? own;
}

/**
 * Whether the conversation's needed-now tray is on screen, and how many requests wait in it: what
 * the composer's notice (and the activity bar) need to tell a waiting request only while its
 * card is out of view.
 */
export function usePendingTray(): { visible: boolean; waiting: number } {
  const store = useTrayStore();
  const visible = useStore(store, (state) => state.visible);
  const waiting = useStore(store, (state) => state.waiting);
  return { visible, waiting };
}

/** The way to the conversation's tray, on a session screen whose conversation answers requests. */
export function useRespondInConversation(): (() => void) | null {
  return useContext(PendingTrayContext)?.respond ?? null;
}
