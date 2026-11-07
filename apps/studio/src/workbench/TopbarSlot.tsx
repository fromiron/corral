import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

// The top bar is the open page's one header row: its location path (crumbs), its view switch
// (views) and its own actions. A page portals into these instead of adding rows of its own.

export interface TopbarSlots {
  actions: HTMLElement | null;
  views: HTMLElement | null;
  crumbs: HTMLElement | null;
}

export const TopbarSlotContext = createContext<TopbarSlots>({
  actions: null,
  views: null,
  crumbs: null,
});

export function TopbarActions({ children }: { children: ReactNode }) {
  const { actions } = useContext(TopbarSlotContext);
  return actions ? createPortal(children, actions) : null;
}

/** A further path segment after the page title. Without a top bar there is no path to extend. */
export function TopbarCrumb({ children }: { children: ReactNode }) {
  const { crumbs } = useContext(TopbarSlotContext);
  return crumbs ? createPortal(children, crumbs) : null;
}

/** The page's view switch; rendered in place where no top bar hosts it. */
export function TopbarViews({ children }: { children: ReactNode }) {
  const { views } = useContext(TopbarSlotContext);
  return views ? createPortal(children, views) : children;
}

/** Whether a top bar hosts the page's view switch. */
export function useTopbarHostsViews() {
  return Boolean(useContext(TopbarSlotContext).views);
}
