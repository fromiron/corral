import { createContext, useContext, useState } from 'react';
import { createStore, type StoreApi, useStore } from 'zustand';

/**
 * Where the tray stands in the conversation's view: not measured yet (or not there at all), in
 * view, or out of view (scrolled away, or under the composer).
 */
export type TrayPlacement = 'unknown' | 'in-view' | 'out-of-view';

interface TrayState {
  placement: TrayPlacement;
  /** Requests waiting in the tray, over all of the session's runs. */
  waiting: number;
  /** The tray that last wrote `placement` and `waiting`: only it clears them when it leaves. */
  owner: object | null;
  /** A request to bring a session's tray into view and focus it, once (`respond`). */
  reveal: { sessionId: string; at: number } | null;
}

/** The needed-now tray's state on one session screen. */
export type PendingTrayStore = StoreApi<TrayState>;

export const createPendingTrayStore = (): PendingTrayStore =>
  createStore<TrayState>(() => ({ placement: 'unknown', waiting: 0, owner: null, reveal: null }));

/**
 * Asks the session's tray to come into view and take focus, once, as soon as it shows what waits.
 * Another conversation's tray never takes it.
 */
export function revealPendingTray(store: PendingTrayStore, sessionId: string) {
  store.setState({ reveal: { sessionId, at: performance.now() } });
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
 * the activity bar needs to tell a waiting request only while its card is out of view. `visible`
 * is false until the tray has been measured in view.
 */
export function usePendingTray(): { visible: boolean; waiting: number; placement: TrayPlacement } {
  const store = useTrayStore();
  const placement = useStore(store, (state) => state.placement);
  const waiting = useStore(store, (state) => state.waiting);
  return { visible: placement === 'in-view', waiting, placement };
}

/**
 * Whether a notice about a waiting request may show beside the conversation: on a session screen
 * only once its tray has been measured out of view, so it never flashes while the tray mounts or
 * is first measured. A screen without a session conversation keeps its notice.
 */
export function useWaitingNoticeAllowed(): boolean {
  const context = useContext(PendingTrayContext);
  const { placement } = usePendingTray();
  return !context || placement === 'out-of-view';
}

/** The way to the conversation's tray, on a session screen whose conversation answers requests. */
export function useRespondInConversation(): (() => void) | null {
  return useContext(PendingTrayContext)?.respond ?? null;
}
