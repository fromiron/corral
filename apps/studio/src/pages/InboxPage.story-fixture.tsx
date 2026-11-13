import type { InboxItemView } from '@corral/client';
import type { ProjectSummary, RunSummary } from '@corral/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';
import { ServicesProvider, type StudioServices } from '../services.tsx';

// Story-only: Needs you over fixed items, with Studio's installed router and no server.

const project: ProjectSummary = {
  projectId: 'story_project',
  name: 'Story project',
  description: '',
  revision: 1,
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
  archivedAt: null,
};

export function InboxStoryFrame({
  items,
  runs = [],
  children,
}: {
  items: InboxItemView[];
  runs?: RunSummary[];
  children: ReactNode;
}) {
  const router = useMemo(
    () =>
      createRouter({
        routeTree: createRootRoute(),
        history: createMemoryHistory({ initialEntries: ['/inbox'] }),
      }),
    [],
  );
  const services = useMemo(
    () =>
      ({
        repository: { listProjects: async () => [project] },
        transport: { listRuns: async () => runs },
        workspaces: { inbox: async () => items, executionOpened: async () => {} },
      }) as unknown as StudioServices,
    [items, runs],
  );
  return (
    <RouterContextProvider router={router}>
      <ServicesProvider services={services}>{children}</ServicesProvider>
    </RouterContextProvider>
  );
}
