import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { PathCrumb } from '@corral/react';
import {
  Button,
  fontWeights,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { ChevronDown, Folder } from '@corral/react/icons';
import { useNavigate } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { projectName } from '../projects.ts';
import { SessionMenu } from './Breadcrumbs.tsx';
import { useTopbarLayout } from './TopbarSlot.tsx';

// The top bar's path: where the open screen sits. A project's screens start with the project
// menu; screens that belong to no project start with their own name (workbench.md). The last
// name is the one that stays as the bar narrows; the project before it folds to its icon. Each
// item marks itself (`data-crumb`) and its truncating label so the bar can tell what the path
// would take at full length (topbarTier.ts).

type OutsidePage =
  | ['Shell', 'needsYou' | 'library' | 'automation' | 'featurePreviews' | 'allProjects']
  | ['Navigation', 'compare' | 'demo'];

/** The name a screen outside any project starts its path with, or undefined inside one. */
export function outsidePage(pathname: string): OutsidePage | undefined {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  if (pathname === '/inbox') return ['Shell', 'needsYou'];
  if (under('/library')) return ['Shell', 'library'];
  if (pathname === '/schedules') return ['Shell', 'automation'];
  if (under('/preview')) return ['Shell', 'featurePreviews'];
  if (pathname === '/projects') return ['Shell', 'allProjects'];
  if (pathname === '/compare') return ['Navigation', 'compare'];
  if (pathname === '/demo') return ['Navigation', 'demo'];
  return undefined;
}

export function TopbarPath({
  pathname,
  projects,
  projectId,
  project,
  pageTitle,
  sessions,
  runs,
  sessionId,
  onOpenSession,
  crumbs,
}: {
  pathname: string;
  projects: ProjectSummary[];
  projectId?: string | undefined;
  /** The open project once known, from the sidebar or the route's own data. */
  project?: ProjectSummary | undefined;
  pageTitle: string;
  sessions: readonly WorkSession[];
  runs: readonly RunSummary[];
  /** The open session: the path then ends in its menu. */
  sessionId?: string | undefined;
  onOpenSession: (sessionId: string) => void;
  /** Where a page portals further path segments. */
  crumbs: (node: HTMLElement | null) => void;
}) {
  const shell = useTranslations('Shell');
  const n = useTranslations('Navigation');
  const outside = outsidePage(pathname);
  const known = project ?? projects.find((item) => item.projectId === projectId);
  return (
    <nav
      aria-label={n('location')}
      data-topbar-part="path"
      className="flex min-w-0 items-center gap-1.5 text-ui"
    >
      {outside ? (
        <PathCrumb>{outside[0] === 'Shell' ? shell(outside[1]) : n(outside[1])}</PathCrumb>
      ) : (
        <ProjectSwitcher projects={projects} projectId={projectId} />
      )}
      {pageTitle && !outside ? (
        <>
          {known ? (
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
          ) : null}
          {sessionId && projectId ? (
            <SessionMenu
              sessions={sessions}
              runs={runs}
              projectId={projectId}
              sessionId={sessionId}
              title={pageTitle}
              onOpen={onOpenSession}
            />
          ) : (
            <h2
              data-crumb="current"
              data-crumb-label=""
              className="min-w-0 truncate px-2 text-foreground"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {pageTitle}
            </h2>
          )}
        </>
      ) : null}
      <span ref={crumbs} className="contents" />
    </nav>
  );
}

/** The project Studio works in; choosing one opens it, or the list of all. */
function ProjectSwitcher({
  projects,
  projectId,
}: {
  projects: ProjectSummary[];
  projectId?: string | undefined;
}) {
  const t = useTranslations('Projects');
  const n = useTranslations('Navigation');
  const navigate = useNavigate();
  const options = projects.filter((p) => !p.archivedAt || p.projectId === projectId);
  const chosen = options.find((p) => p.projectId === projectId);
  const name = chosen ? projectName(chosen, t('defaultName')) : t('allProjects');
  const icon = useTopbarLayout().project === 'icon';
  return (
    <Menu>
      {icon ? (
        // A narrow bar keeps the project as its icon; the name is the tooltip.
        <Tooltip content={name}>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={n('switchProject')}
                data-crumb="project"
                className="shrink-0"
              />
            }
          >
            <Folder />
          </MenuTrigger>
        </Tooltip>
      ) : (
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="compact"
              aria-label={n('switchProject')}
              data-crumb="project"
              // A project name is never cut mid-word to make room: the session name gives first.
              className="max-w-52 shrink-0 gap-1 px-2"
            />
          }
        >
          <span data-crumb-label="" className="truncate">
            {name}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </MenuTrigger>
      )}
      <MenuPopup align="start" className="min-w-56">
        <MenuRadioGroup
          value={chosen ? projectId : ''}
          onValueChange={(value) =>
            void navigate({ to: '/projects/$projectId', params: { projectId: String(value) } })
          }
        >
          {options.map((p) => (
            <MenuRadioItem key={p.projectId} value={p.projectId} closeOnClick>
              {projectName(p, t('defaultName'))}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: '/projects' })}>{t('allProjects')}</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
