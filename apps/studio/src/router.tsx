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
import { HarnessDefaultsPage } from './pages/HarnessDefaultsPage.tsx';
import { HarnessSettingsPage } from './pages/HarnessSettingsPage.tsx';
import { McpSettingsPage } from './pages/McpSettingsPage.tsx';
import { ModelSettingsPage } from './pages/ModelSettingsPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { HookSettingsPage, SkillSettingsPage } from './pages/ResourceSettingsPage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { ErrorView, NotFoundView, RootLayout } from './pages/RootLayout.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { ScheduledPage } from './pages/ScheduledPage.tsx';
import { SessionPage } from './pages/SessionPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { VaultSettingsPage } from './pages/VaultSettingsPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';
import { currentProject, projectOfRun } from './projects.ts';
import type { StudioServices } from './services.tsx';
import {
  type SettingsSearch,
  validateSettingsOverlay,
  validateSettingsSearch,
  workHref,
} from './workbench/navigation.ts';
import {
  validateEditorSearch,
  validateReviewSearch,
  validateRunSearch,
  validateSessionSearch,
} from './workbench/panels/routes.ts';

export { type SessionSearch, validateSessionSearch } from './workbench/panels/routes.ts';

// Routes from product contract §4.1.

const rootRoute = createRootRouteWithContext<{ services: StudioServices }>()({
  component: RootLayout,
  validateSearch: validateSettingsOverlay,
  notFoundComponent: NotFoundView,
  errorComponent: ErrorView,
});

// `?draft=1` opens "Draft a team from a goal".
const draftSearch = (
  search: Record<string, unknown>,
): { draft?: boolean; newSession?: boolean } => ({
  ...(search.draft === true || search.draft === 1 || search.draft === '1' ? { draft: true } : {}),
  ...(search.newSession === true || search.newSession === 'true' ? { newSession: true } : {}),
});

/** `/` is the project worked in last; old links to it keep working. */
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

const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedules',
  component: ScheduledPage,
});

/** One project's Corrals and runs: what `/` showed before projects. */
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
    // Every project's sessions: in-browser runs find their project through them.
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

/** One work session: its requests, runs, queue and the input box. */
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

/** A session's file changes, checks and writes. */
export const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId/review',
  validateSearch: validateReviewSearch,
  beforeLoad: ({ params, search }) => {
    // Git state has one home, the session's Git pane (#91).
    if (search.scope === 'git')
      throw redirect({
        to: '/sessions/$sessionId',
        params,
        search: { panel: 'git' },
        replace: true,
      });
  },
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
  // A version of an earlier run the next run starts from, from the Run page.
  // `fromSession`: opened from a session's menu, so the editor offers the way back.
  validateSearch: validateEditorSearch,
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
  // `view` and `result` keep the Results view and its chosen version in the address.
  validateSearch: validateRunSearch,
  component: RunPage,
});

/**
 * Every settings screen opens one way: the settings dialog over a work page (#88). A settings
 * address lands on the page it names in `returnTo`, else Projects, with its target project, so
 * URL, Back and closing behave the same however the screen was reached.
 */
function settingsDialog(section: string, search: SettingsSearch) {
  const url = new URL(workHref(search.returnTo) ?? '/projects', 'http://corral.local');
  url.searchParams.set('settings', section);
  if (search.projectId) url.searchParams.set('settingsProject', search.projectId);
  return redirect({ href: `${url.pathname}${url.search}${url.hash}`, replace: true });
}

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (
    search: Record<string, unknown>,
  ): SettingsSearch & { section?: 'general' | 'workspace' | 'shortcuts' | 'about' } => ({
    ...validateSettingsSearch(search),
    ...(['general', 'workspace', 'shortcuts', 'about'].includes(String(search.section))
      ? { section: search.section as 'general' | 'workspace' | 'shortcuts' | 'about' }
      : {}),
  }),
  beforeLoad: ({ search }) => {
    throw settingsDialog(search.section ?? 'general', search);
  },
  component: () => <SettingsPage section={settingsRoute.useSearch().section} />,
});

export const harnessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/harness',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ location, search }) => {
    throw settingsDialog(
      location.hash.replace(/^#/, '') === 'project-defaults' ? 'project-defaults' : 'harness',
      search,
    );
  },
  component: HarnessSettingsPage,
});

export const personalDefaultsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/defaults',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ search }) => {
    throw settingsDialog('defaults', search);
  },
  component: () => <HarnessDefaultsPage scope="personal" />,
});
export const projectDefaultsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/project-defaults',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ search }) => {
    throw settingsDialog('project-defaults', search);
  },
  component: () => <HarnessDefaultsPage scope="project" />,
});

export const skillSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/skills',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ search }) => {
    throw settingsDialog('skills', search);
  },
  component: SkillSettingsPage,
});
export const hookSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/hooks',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ search }) => {
    throw settingsDialog('hooks', search);
  },
  component: HookSettingsPage,
});
export const mcpSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/mcp',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ search }) => {
    throw settingsDialog('mcp', search);
  },
  component: McpSettingsPage,
});

export const vaultSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/vault',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ search }) => {
    throw settingsDialog('vault', search);
  },
  component: VaultSettingsPage,
});

export const modelSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/models',
  validateSearch: validateSettingsSearch,
  beforeLoad: ({ search }) => {
    throw settingsDialog('models', search);
  },
  component: ModelSettingsPage,
});

/** Two runs side by side. */
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
      schedulesRoute,
      projectsRoute,
      workspaceRoute,
      sessionRoute,
      reviewRoute,
      demoRoute,
      editorRoute,
      runRoute,
      modelSettingsRoute,
      vaultSettingsRoute,
      harnessSettingsRoute,
      personalDefaultsRoute,
      projectDefaultsRoute,
      skillSettingsRoute,
      hookSettingsRoute,
      mcpSettingsRoute,
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
