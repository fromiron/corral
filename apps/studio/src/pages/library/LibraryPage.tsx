import { Identifier } from '@corral/contracts';
import type { CorralSummary, ProjectSummary } from '@corral/core';
import { TermTooltip } from '@corral/react';
import { Button, Page, Select, TabItem, TabPanel, Tabs, TabsList } from '@corral/react/design-kit';
import { ArrowLeft } from '@corral/react/icons';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectName, useCurrentProject, useProjectsVersion } from '../../projects.ts';
import { useServices } from '../../services.tsx';
import { workHref } from '../../workbench/navigation.ts';
import { LibraryAgents } from './LibraryAgents.tsx';
import { LibraryResources } from './LibraryResources.tsx';
import { LibrarySkills } from './LibrarySkills.tsx';
import { LibraryTeams, LibraryTemplates } from './LibraryTeams.tsx';

export const LIBRARY_VIEWS = ['teams', 'agents', 'skills', 'templates', 'resources'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

export interface LibrarySearch {
  project?: string;
  agent?: string;
  returnTo?: string;
  /** Legacy creation links redirected by the router. */
  draft?: boolean;
  blank?: boolean;
}

export function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const returnTo = workHref(search.returnTo);
  const agent = Identifier.safeParse(search.agent);
  return {
    ...(agent.success ? { agent: agent.data } : {}),
    ...(typeof search.project === 'string' && search.project && search.project.length <= 256
      ? { project: search.project }
      : {}),
    ...(returnTo ? { returnTo } : {}),
    ...(search.blank === true || search.blank === 1 || search.blank === '1' ? { blank: true } : {}),
    ...(search.draft === true || search.draft === 1 || search.draft === '1' ? { draft: true } : {}),
  };
}

const VIEW_ROUTES = {
  teams: '/library/teams',
  agents: '/library/agents',
  skills: '/library/skills',
  templates: '/library/templates',
  resources: '/library/resources',
} as const satisfies Record<LibraryView, string>;

type LibraryData =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; projects: ProjectSummary[]; corrals: CorralSummary[] };

export function LibraryPage({ view = 'teams' }: { view?: LibraryView | undefined }) {
  const t = useTranslations('Library');
  const tp = useTranslations('Projects');
  const tw = useTranslations('Workspace');
  const location = useRouterState({ select: (state) => state.location });
  const search = validateLibrarySearch(location.search as Record<string, unknown>);
  const remembered = useCurrentProject();
  const projectsVersion = useProjectsVersion();
  const { repository } = useServices();
  const navigate = useNavigate();
  const [reloads, reload] = useReducer((count: number) => count + 1, 0);
  const [data, setData] = useState<LibraryData>({ state: 'loading' });
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const tabsViewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = tabsViewport.current;
    const tab = viewport?.querySelector<HTMLElement>(`[data-view="${view}"]`);
    if (!tab || !viewport) return;
    const bounds = viewport.getBoundingClientRect(),
      item = tab.getBoundingClientRect();
    if (item.left < bounds.left) viewport.scrollLeft += item.left - bounds.left;
    else if (item.right > bounds.right) viewport.scrollLeft += item.right - bounds.right;
  }, [view]);
  useEffect(() => {
    let live = true;
    void projectsVersion;
    void reloads;
    void Promise.all([repository.listProjects(), repository.list()]).then(
      ([projects, corrals]) => {
        if (live) setData({ state: 'ready', projects, corrals });
      },
      () => {
        if (live) setData({ state: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [repository, projectsVersion, reloads]);

  const projects = data.state === 'ready' ? data.projects : [];
  // Without a filter, the project opened last; a filter naming no project falls back to it.
  const requested = search.project ?? remembered;
  const project =
    projects.find((item) => item.projectId === requested) ??
    projects.find((item) => item.projectId === remembered) ??
    projects[0];
  const projectId = project?.projectId ?? requested;
  const kept = {
    ...(search.project ? { project: search.project } : {}),
    ...(search.returnTo ? { returnTo: search.returnTo } : {}),
  };
  const returnTo = search.returnTo;
  // The Teams tab carries the project's team count; the list under it has no label of its own.
  const teamCount =
    data.state === 'ready'
      ? data.corrals.filter((corral) => corral.projectId === projectId).length
      : 0;
  const viewLabel = (value: LibraryView) =>
    value === 'teams' && teamCount ? `${t('view.teams')} ${teamCount}` : t(`view.${value}`);

  const content =
    view === 'skills' ? (
      <LibrarySkills key={projectId} projectId={projectId} toolbar={toolbar} />
    ) : view === 'agents' ? (
      <LibraryAgents
        key={`${projectId}:${search.agent ?? ''}`}
        projectId={projectId}
        initialAgent={search.agent}
        toolbar={toolbar}
        archivedProject={Boolean(project?.archivedAt)}
      />
    ) : data.state === 'failed' ? (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-body text-destructive">
        <span>{t('loadFailed')}</span>
        <Button variant="tertiary" size="compact" onClick={reload}>
          {t('retry')}
        </Button>
      </div>
    ) : data.state === 'loading' ? null : view === 'teams' ? (
      <LibraryTeams
        key={projectId}
        projectId={projectId}
        project={project}
        projects={data.projects}
        corrals={data.corrals}
        onChanged={reload}
        toolbar={toolbar}
      />
    ) : view === 'templates' ? (
      <LibraryTemplates projectId={projectId} project={project} />
    ) : (
      <LibraryResources key={projectId} projectId={projectId} returnTo={returnTo} />
    );

  return (
    <main data-library-view={view} className="flex min-h-0 flex-1 flex-col">
      <Page title={t('title')}>
        <Tabs
          value={view}
          onValueChange={(next) =>
            void navigate({ to: VIEW_ROUTES[next as LibraryView], search: kept })
          }
          className="grid min-w-0 gap-6"
        >
          <div
            className={`flex min-w-0 items-center justify-between gap-3 ${view === 'agents' ? '' : 'flex-wrap'}`}
          >
            <div ref={tabsViewport} className="min-w-0 max-w-full overflow-x-auto">
              <TabsList aria-label={t('views')}>
                {/* The Corral tab explains the term in its tooltip (glossary.md), under the tab and from
                  its left edge, so it covers neither the page title above nor the sidebar; the list's index reaches the tab through it. */}
                {LIBRARY_VIEWS.map((value) =>
                  value === 'teams' ? (
                    <TermTooltip
                      key={value}
                      term="corral"
                      value={value}
                      side="bottom"
                      align="start"
                    >
                      <TabItem value={value} label={viewLabel(value)} data-view={value} />
                    </TermTooltip>
                  ) : (
                    <TabItem key={value} value={value} label={viewLabel(value)} data-view={value} />
                  ),
                )}
              </TabsList>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* An archived project gets no new teams. */}
              {view === 'templates' && data.state === 'ready' && !project?.archivedAt ? (
                <Button
                  variant="tertiary"
                  size="compact"
                  render={
                    <Link to="/corrals/new/edit" search={{ project: projectId, assistant: 1 }} />
                  }
                >
                  {tw('draftFromGoal')}
                </Button>
              ) : null}
              {returnTo ? (
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => void navigate({ href: returnTo })}
                >
                  <ArrowLeft aria-hidden />
                  {t('back')}
                </Button>
              ) : null}
              {projects.length > 1 ? (
                <Select
                  label={t('project')}
                  variant="chip"
                  value={projectId}
                  onValueChange={(value) =>
                    void navigate({
                      to: location.pathname,
                      search: { ...location.search, project: value },
                      replace: true,
                      resetScroll: false,
                    })
                  }
                  options={projects.map((item) => ({
                    value: item.projectId,
                    label: item.archivedAt
                      ? `${projectName(item, tp('defaultName'))} · ${tp('archived')}`
                      : projectName(item, tp('defaultName')),
                  }))}
                />
              ) : null}
              {/* Each list view puts its own actions here, at the end of the one toolbar row. */}
              {view === 'skills' || view === 'agents' || view === 'teams' ? (
                <div className="flex flex-wrap items-center gap-2 empty:hidden" ref={setToolbar} />
              ) : null}
            </div>
          </div>
          <TabPanel value={view}>{content}</TabPanel>
        </Tabs>
      </Page>
    </main>
  );
}
