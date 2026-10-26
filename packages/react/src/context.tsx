import { createContext, type ReactNode, useContext } from 'react';
import type { EditorStore } from './editor/store.ts';
import type { RunSessionStore } from './run/session.ts';

interface StudioStores {
  editor: EditorStore;
  session: RunSessionStore;
  /** The Run graph: node views show run state but offer no editing. */
  readOnly?: boolean;
}

const StudioContext = createContext<StudioStores | null>(null);

export function StudioStoresProvider({
  children,
  ...stores
}: StudioStores & { children: ReactNode }) {
  return <StudioContext.Provider value={stores}>{children}</StudioContext.Provider>;
}

export function useStudioStores(): StudioStores {
  const stores = useContext(StudioContext);
  if (!stores) throw new Error('useStudioStores must be used inside StudioStoresProvider');
  return stores;
}
