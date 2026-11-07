import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';

/** Story-only routing context; use Studio's installed router rather than another dependency. */
export function OverviewStoryRouter({ children }: { children: ReactNode }) {
  const router = useMemo(
    () =>
      createRouter({
        routeTree: createRootRoute(),
        history: createMemoryHistory({ initialEntries: ['/'] }),
      }),
    [],
  );
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>;
}
