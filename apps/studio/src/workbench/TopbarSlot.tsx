import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

// The top bar owns one place for the open page's own actions (Workbench polish P1): a session
// puts its panel and menu buttons there instead of a second header row.

export const TopbarSlotContext = createContext<HTMLElement | null>(null);

export function TopbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(TopbarSlotContext);
  return slot ? createPortal(children, slot) : null;
}
