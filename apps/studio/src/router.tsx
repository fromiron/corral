import { addNode, connect, emptyDraft } from '@corral/react';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { DemoPage, EditorPage } from './pages/EditorPage.tsx';
import { ModelSettingsPage } from './pages/ModelSettingsPage.tsx';
import { ErrorView, NotFoundView, RootLayout } from './pages/RootLayout.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';
import type { StudioServices } from './services.tsx';

// Routes from Spec §4.1.

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

export const demoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/demo',
  loader: async ({ context }) => {
    const repository = context.services.repository;
    const agent = addNode(emptyDraft('public_demo', 'Demo Corral'), 'agent', { x: 80, y: 120 });
    const output = addNode(agent.draft, 'output', { x: 360, y: 120 });
    const connected = connect(output.draft, {
      source: agent.nodeId,
      sourcePort: 'out',
      target: output.nodeId,
      targetPort: 'in',
    });
    if (!connected.ok) throw new Error('Invalid demo fixture.');
    const draft = connected.draft;
    const result = await repository.save({
      definition: draft.definition,
      layout: { nodes: draft.layout, viewport: draft.viewport },
      expectedDefinitionRevision: null,
    });
    if (!result.ok) throw new Error(result.message);
    return result.record;
  },
  component: DemoPage,
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
  validateSearch: (search: Record<string, unknown>): { execution?: string; artifact?: string } => ({
    ...(typeof search.execution === 'string' ? { execution: search.execution } : {}),
    ...(typeof search.artifact === 'string' ? { artifact: search.artifact } : {}),
  }),
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

function createPerformanceRoute() {
  const PerformancePage = lazy(() => import('./pages/PerformancePage.tsx'));
  return createRoute({
    getParentRoute: () => rootRoute,
    path: '/performance',
    component: () => (
      <Suspense fallback={<p>Loading fixture…</p>}>
        <PerformancePage />
      </Suspense>
    ),
  });
}

export function createStudioRouter(services: StudioServices) {
  return createRouter({
    routeTree: rootRoute.addChildren([
      workspaceRoute,
      demoRoute,
      editorRoute,
      runRoute,
      modelSettingsRoute,
      ...(import.meta.env.MODE === 'performance' ? [createPerformanceRoute()] : []),
    ]),
    context: { services },
    defaultPreload: false,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createStudioRouter>;
  }
}
