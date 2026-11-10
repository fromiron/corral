import type { CorralSummary, ProjectSummary } from '@corral/core';
import { Button, Page, Select, TabItem, TabPanel, Tabs, TabsList } from '@corral/react/design-kit';
import { ArrowLeft } from '@corral/react/icons';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useReducer, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectName, useCurrentProject, useProjectsVersion } from '../projects.ts';
import { useServices } from '../services.tsx';
import { workHref } from '../workbench/navigation.ts';
import { LibraryResources } from './LibraryResources.tsx';
import { LibraryTeams, LibraryTemplates } from './LibraryTeams.tsx';

// The library: teams, templates and resources (docs/specs/features/library.md).

export const LIBRARY_VIEWS = ['teams', 'templates', 'resources'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

export interface LibrarySearch {
  project?: string;
  returnTo?: string;
  /** Opens "Draft a team from a goal" in Templates; consumed once. */
  draft?: boolean;
}

export function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const returnTo = workHref(search.returnTo);
  return {
    ...(typeof search.project === 'string' && search.project && search.project.length <= 256
      ? { project: search.project }
      : {}),
    ...(returnTo ? { returnTo } : {}),
    ...(search.draft === true || search.draft === 1 || search.draft === '1' ? { draft: true } : {}),
  };
}

const VIEW_ROUTES = {
  teams: '/library/teams',
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
  const location = useRouterState({ select: (state) => state.location });
  const search = validateLibrarySearch(location.search as Record<string, unknown>);
  const remembered = useCurrentProject();
  const projectsVersion = useProjectsVersion();
  const { repository } = useServices();
  const navigate = useNavigate();
  const [reloads, reload] = useReducer((count: number) => count + 1, 0);
  const [data, setData] = useState<LibraryData>({ state: 'loading' });
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

  const content =
    data.state === 'failed' ? (
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
        onBrowseTemplates={() => void navigate({ to: VIEW_ROUTES.templates, search: kept })}
      />
    ) : view === 'templates' ? (
      <LibraryTemplates
        projectId={projectId}
        project={project}
        corrals={data.corrals}
        drafting={Boolean(search.draft)}
        onDraftClosed={() =>
          void navigate({
            to: VIEW_ROUTES.templates,
            search: kept,
            replace: true,
            resetScroll: false,
          })
        }
      />
    ) : (
      <LibraryResources key={projectId} projectId={projectId} />
    );

  return (
    <main data-library-view={view} className="flex min-h-0 flex-1 flex-col">
      <Page title={t('title')}>
        <Tabs
          value={view}
          onValueChange={(next) =>
            void navigate({ to: VIEW_ROUTES[next as LibraryView], search: kept })
          }
          className="grid gap-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList aria-label={t('views')}>
              {LIBRARY_VIEWS.map((value) => (
                <TabItem key={value} value={value} label={t(`view.${value}`)} />
              ))}
            </TabsList>
            <div className="flex flex-wrap items-center gap-2">
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
            </div>
          </div>
          <TabPanel value={view}>{content}</TabPanel>
        </Tabs>
      </Page>
    </main>
  );
}
