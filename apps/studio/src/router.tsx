import { DEFAULT_PROJECT_ID } from '@corral/core';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { type DemoTemplateId, demoTemplate } from './demo/templates.ts';
import { ComparePage } from './pages/ComparePage.tsx';
import { DemoPage, EditorPage } from './pages/EditorPage.tsx';
import { ModelSettingsPage } from './pages/ModelSettingsPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { ErrorView, NotFoundView, RootLayout } from './pages/RootLayout.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { SessionPage } from './pages/SessionPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';
import { currentProject, projectOfRun } from './projects.ts';
import type { StudioServices } from './services.tsx';

// Routes from Spec §4.1.

const rootRoute = createRootRouteWithContext<{ services: StudioServices }>()({
  component: RootLayout,
  notFoundComponent: NotFoundView,
  errorComponent: ErrorView,
});

// `?draft=1` opens "Draft a team from a goal" (CR-006).
const draftSearch = (
  search: Record<string, unknown>,
): { draft?: boolean; newSession?: boolean } => ({
  ...(search.draft === true || search.draft === 1 || search.draft === '1' ? { draft: true } : {}),
  ...(search.newSession === true || search.newSession === 'true' ? { newSession: true } : {}),
});

/** `/` is the project worked in last (CR-010); old links to it keep working. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: draftSearch,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/projects/$projectId',
      params: { projectId: currentProject() },
      search,
      replace: true,
    });
  },
});

/** One project's Corrals and runs (CR-010): what `/` showed before projects. */
export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  validateSearch: draftSearch,
  loader: async ({ context, params }) => {
    const [projects, allCorrals, allRuns] = await Promise.all([
      context.services.repository.listProjects(),
      context.services.repository.list(),
      context.services.transport.listRuns(),
    ]);
    // Every project's sessions: in-browser runs find their project through them (CR-011).
    const sessionLists = await Promise.all(
      projects.map((p) => context.services.repository.listSessions(p.projectId)),
    );
    const sessionProjects = new Map(
      sessionLists.flat().map((x) => [x.sessionId, x.projectId] as const),
    );
    const project = projects.find((p) => p.projectId === params.projectId);
    if (!project) {
      // A remembered project that is gone: back to the default one.
      if (params.projectId === DEFAULT_PROJECT_ID) throw notFound();
      throw redirect({
        to: '/projects/$projectId',
        params: { projectId: DEFAULT_PROJECT_ID },
        replace: true,
      });
    }
    return {
      project,
      projects,
      corrals: allCorrals.filter((c) => c.projectId === project.projectId),
      runs: allRuns.filter(
        (r) => projectOfRun(r, allCorrals, sessionProjects) === project.projectId,
      ),
      sessions: sessionLists.flat().filter((x) => x.projectId === project.projectId),
      totals: { corrals: allCorrals.length, runs: allRuns.length },
    };
  },
  component: WorkspacePage,
});

/** One work session (CR-011): its requests, runs, queue and the input box. */
/** The session workbench's tabs and choices (02-UX-Spec §9: view state in the address). */
export interface SessionSearch {
  /** Old links only (`tab=run`); read into `panel`. */
  tab?: 'work' | 'team' | 'run' | undefined;
  /** The open side panel tab; none means the panel is closed. */
  panel?: 'files' | 'changes' | 'artifacts' | 'checks' | 'run' | undefined;
  run?: string | undefined;
  execution?: string | undefined;
  artifact?: string | undefined;
  view?: 'results' | 'run' | undefined;
  result?: string | undefined;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export function validateSessionSearch(search: Record<string, unknown>): SessionSearch {
  const out: SessionSearch = {};
  if (
    search.panel === 'files' ||
    search.panel === 'changes' ||
    search.panel === 'artifacts' ||
    search.panel === 'checks' ||
    search.panel === 'run'
  )
    out.panel = search.panel;
  // Run detail used to be a main tab; old links open it in the panel.
  if (search.tab === 'run') out.panel = 'run';
  if (search.view === 'results' || search.view === 'run') out.view = search.view;
  for (const key of ['run', 'execution', 'artifact', 'result'] as const) {
    const value = text(search[key]);
    if (value) out[key] = value;
  }
  return out;
}

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
  validateSearch: validateSessionSearch,
  loader: async ({ context, params }) => {
    const session = await context.services.repository.getSession(params.sessionId);
    if (!session) throw notFound();
    const [projects, corrals] = await Promise.all([
      context.services.repository.listProjects(),
      context.services.repository.list(),
    ]);
    return {
      session,
      project: projects.find((p) => p.projectId === session.projectId) ?? null,
      corrals: corrals.filter((c) => c.projectId === session.projectId),
    };
  },
  component: SessionPage,
});

/** A session's file changes, checks and writes (CR-012). */
export const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId/review',
  validateSearch: (
    search: Record<string, unknown>,
  ): { scope?: 'session' | 'review' | 'run' | 'git'; runId?: string; file?: string } => ({
    ...(search.scope === 'session' ||
    search.scope === 'review' ||
    search.scope === 'run' ||
    search.scope === 'git'
      ? { scope: search.scope }
      : {}),
    ...(typeof search.runId === 'string' ? { runId: search.runId } : {}),
    ...(typeof search.file === 'string' ? { file: search.file } : {}),
  }),
  loader: async ({ context, params }) => {
    const session = await context.services.repository.getSession(params.sessionId);
    if (!session) throw notFound();
    return { session };
  },
  component: ReviewPage,
});

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  loader: async ({ context }) => {
    const [projects, corrals, runs] = await Promise.all([
      context.services.repository.listProjects(),
      context.services.repository.list(),
      context.services.transport.listRuns(),
    ]);
    return { projects, corrals, runs };
  },
  component: ProjectsPage,
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
  // `view` and `result` keep the Results view and its chosen version in the address (CR-009).
  validateSearch: (
    search: Record<string, unknown>,
  ): { execution?: string; artifact?: string; view?: 'results' | 'run'; result?: string } => ({
    ...(typeof search.execution === 'string' ? { execution: search.execution } : {}),
    ...(typeof search.artifact === 'string' ? { artifact: search.artifact } : {}),
    ...(search.view === 'results' || search.view === 'run' ? { view: search.view } : {}),
    ...(typeof search.result === 'string' ? { result: search.result } : {}),
  }),
  component: RunPage,
});

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (
    search: Record<string, unknown>,
  ): { section?: 'general' | 'workspace' | 'shortcuts' | 'about' } => ({
    ...(['general', 'workspace', 'shortcuts', 'about'].includes(String(search.section))
      ? { section: search.section as 'general' | 'workspace' | 'shortcuts' | 'about' }
      : {}),
  }),
  component: SettingsPage,
});

export const modelSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/models',
  loader: async ({ context }) => {
    const api = context.services.models;
    if (!api) return { profiles: [], providers: [], catalog: [], config: null };
    const [profiles, providers, catalog, config] = await Promise.all([
      api.profiles(),
      api.auth(),
      api.catalog(),
      // Simulated-only servers have no model config to edit.
      api.config().catch(() => null),
    ]);
    return { profiles, providers, catalog, config };
  },
  component: ModelSettingsPage,
});

/** Two runs side by side (roadmap 16). */
export const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/compare',
  validateSearch: (search: Record<string, unknown>): { a?: string; b?: string } => ({
    ...(typeof search.a === 'string' ? { a: search.a } : {}),
    ...(typeof search.b === 'string' ? { b: search.b } : {}),
  }),
  component: ComparePage,
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
      indexRoute,
      projectsRoute,
      workspaceRoute,
      sessionRoute,
      reviewRoute,
      demoRoute,
      editorRoute,
      runRoute,
      modelSettingsRoute,
      settingsRoute,
      compareRoute,
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
