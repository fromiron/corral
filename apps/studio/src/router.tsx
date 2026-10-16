import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { type DemoTemplateId, demoTemplate } from './demo/templates.ts';
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
  // `?draft=1` opens "Draft a team from a goal" (CR-006).
  validateSearch: (search: Record<string, unknown>): { draft?: boolean } =>
    search.draft === true || search.draft === 1 || search.draft === '1' ? { draft: true } : {},
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
  validateSearch: (search: Record<string, unknown>): { template?: DemoTemplateId } =>
    search.template === 'starter' ? { template: 'starter' } : {},
  loaderDeps: ({ search }) => ({ template: search.template }),
  loader: async ({ context, deps }) => {
    const template = demoTemplate(deps.template);
    // Switching back to a template opened earlier in this tab keeps what was saved there.
    const existing = await context.services.repository.get(template.definition.id);
    if (existing) return { record: existing, template: template.id };
    const result = await context.services.repository.save({
      definition: template.definition,
      layout: template.layout,
      expectedDefinitionRevision: null,
    });
    if (!result.ok) throw new Error(result.message);
    return { record: result.record, template: template.id };
  },
  component: DemoPage,
});

export const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/corrals/$corralId/edit',
  // A version of an earlier run the next run starts from (CR-007), from the Run page.
  validateSearch: (search: Record<string, unknown>): { fromRun?: string; fromVersion?: string } =>
    typeof search.fromRun === 'string' && typeof search.fromVersion === 'string'
      ? { fromRun: search.fromRun, fromVersion: search.fromVersion }
      : {},
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
