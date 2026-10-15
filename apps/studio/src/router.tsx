import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
} from '@tanstack/react-router';
import { EditorPage } from './pages/EditorPage.tsx';
import { ModelSettingsPage } from './pages/ModelSettingsPage.tsx';
import { ErrorView, NotFoundView, RootLayout } from './pages/RootLayout.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';
import type { StudioServices } from './services.tsx';

// Routes from Spec §4.1. /demo arrives with C-046 (P9).

const rootRoute = createRootRouteWithContext<{ services: StudioServices }>()({
  component: RootLayout,
  notFoundComponent: NotFoundView,
  errorComponent: ErrorView,
});

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) => {
    const [corrals, runs] = await Promise.all([
      context.services.repository.list(),
      context.services.transport.listRuns(),
    ]);
    return { corrals, runs };
  },
  component: WorkspacePage,
});

export const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/corrals/$corralId/edit',
  loader: async ({ context, params }) => {
    const record = await context.services.repository.get(params.corralId);
    if (!record) throw notFound();
    return record;
  },
  component: EditorPage,
});

export const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  validateSearch: (search: Record<string, unknown>): { execution?: string } =>
    typeof search.execution === 'string' ? { execution: search.execution } : {},
  component: RunPage,
});

export const modelSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/models',
  loader: async ({ context }) => {
    const api = context.services.models;
    if (!api) return { profiles: [], providers: [] };
    const [profiles, providers] = await Promise.all([api.profiles(), api.auth()]);
    return { profiles, providers };
  },
  component: ModelSettingsPage,
});

export function createStudioRouter(services: StudioServices) {
  return createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute, editorRoute, runRoute, modelSettingsRoute]),
    context: { services },
    defaultPreload: false,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createStudioRouter>;
  }
}
