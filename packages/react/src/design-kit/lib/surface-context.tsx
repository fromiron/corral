'use client';

import { createContext, type ReactNode, useContext } from 'react';

// The surface level children sit on (1–8, 1 is the page). Raised components
// pick their level relative to it, so e.g. a menu opened inside a dialog still
// lands a step above the dialog instead of melting into it.

// No provider means the page itself.
const SurfaceContext = createContext<number>(1);

export function useSurface(): number {
  return useContext(SurfaceContext);
}

export function SurfaceProvider({ value, children }: { value: number; children: ReactNode }) {
  return (
    <SurfaceContext.Provider value={Math.max(1, Math.min(8, value))}>
      {children}
    </SurfaceContext.Provider>
  );
}
