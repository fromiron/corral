import type { ProjectSummary } from '@corral/core';
import { ChevronDown, PanelLeft, Search } from '@corral/react/icons';
import {
  Button,
  Dialog,
  DialogPopup,
  DialogTitle,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
  TooltipProvider,
} from '@corral/react/ui';
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useBlocker,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CommandLayer } from '../CommandPalette.tsx';
import { desktop, onTopbarDoubleClick } from '../desktop.tsx';
import { projectName } from '../projects.ts';
import { useServices } from '../services.tsx';
import { useShortcutBindings } from '../shortcutBindings.ts';
import { shortcutLabel } from '../shortcuts.ts';
import { hasUnsavedEditorCopy } from '../workbench/editorDraft.ts';
import {
  SettingsNavigationContext,
  standaloneSettingsLink,
  validateSettingsOverlay,
  validateSettingsSearch,
  withoutSettings,
  workHref,
} from '../workbench/navigation.ts';
import { applyTheme, changePreferences, usePreferences } from '../workbench/preferences.ts';
import { SessionTabs } from '../workbench/SessionTabs.tsx';
import { SettingsDialog } from '../workbench/SettingsDialog.tsx';
import {
  SettingsLeavePrompt,
  SettingsLifecycle,
  SettingsOperationStatus,
} from '../workbench/SettingsLifecycle.tsx';
import { SettingsNavigation, settingsSection } from '../workbench/SettingsNavigation.tsx';
import { Sidebar, useCorralSidebar } from '../workbench/Sidebar.tsx';
import { TopbarSlotContext } from '../workbench/TopbarSlot.tsx';

export function RootLayout() {
  return (
    <SettingsLifecycle>
      <RootFrame />
    </SettingsLifecycle>
  );
}

function RootFrame() {
  useShortcutBindings();
  const navigate = useNavigate();
  const router = useRouter();
  const settingsOwner = useRef(crypto.randomUUID()).current;
  const { repository } = useServices();
  useBlocker({
    shouldBlockFn: () => false,
    enableBeforeUnload: () => hasUnsavedEditorCopy(repository),
  });
  const t = useTranslations('Studio');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('CommandPalette');
  const tn = useTranslations('Navigation');
  const td = useTranslations('Desktop');
  const th = useTranslations('Harness');
  const tr = useTranslations('Resources');
  const projectsText = useTranslations('Projects');
  const prefs = usePreferences();
  const location = useRouterState({ select: (s) => s.location });
  // Run/Inbox/desktop notifications live for the frame, including settings and narrow dialogs.
  const sidebar = useCorralSidebar();
  const data = useRouterState({ select: (s) => s.matches.at(-1)?.loaderData }) as
    | {
        project?: ProjectSummary;
        projectId?: string;
        session?: { title: string; projectId: string };
        definition?: { name: string };
      }
    | undefined;
  const settings = location.pathname.startsWith('/settings');
  const overlaySearch = validateSettingsOverlay(location.search);
  const overlay = !settings && Boolean(overlaySearch.settings) && Boolean(workHref(location.href));
  const selectedRun = sidebar.runs.find(
    (run) => location.pathname === `/runs/${encodeURIComponent(run.runId)}`,
  );
  const projectId =
    settings || location.pathname === '/projects'
      ? undefined
      : (data?.project?.projectId ??
        data?.session?.projectId ??
        data?.projectId ??
        (selectedRun
          ? (selectedRun.projectId ??
            sidebar.sessions.find((session) => session.sessionId === selectedRun.sessionId)
              ?.projectId ??
            sidebar.corrals.find((team) => team.corralId === selectedRun.corralId)?.projectId)
          : undefined));
  const project = sidebar.projects.find((item) => item.projectId === projectId) ?? data?.project;
  const [lastWork, setLastWork] = useState<{ href: string; projectId?: string } | null>(null);
  const search = validateSettingsSearch(location.search);
  const settingsProjectId = sidebar.projects.find(
    (item) =>
      item.projectId === (search.projectId ?? (search.returnTo ? undefined : lastWork?.projectId)),
  )?.projectId;
  const returnTo =
    search.returnTo ??
    lastWork?.href ??
    (settingsProjectId ? `/projects/${encodeURIComponent(settingsProjectId)}` : '/projects');
  const entryProjectId = overlay
    ? sidebar.projects.find((item) => item.projectId === overlaySearch.settingsProject)?.projectId
    : settings
      ? settingsProjectId
      : projectId;
  const workLocation = workHref(location.href) ?? '/projects';
  const entryReturnTo = settings ? returnTo : workLocation;
  const closeSettings = () => {
    const state = location.state as typeof location.state & {
      settingsOwner?: string;
      settingsOrigin?: number;
      settingsOneShot?: boolean;
    };
    if (
      !state.settingsOneShot &&
      state.settingsOwner === settingsOwner &&
      typeof state.settingsOrigin === 'number' &&
      state.__TSR_index === state.settingsOrigin + 1
    ) {
      router.history.back();
    } else {
      void navigate({
        to: location.pathname,
        search: { ...withoutSettings(location.search), newSession: undefined, draft: undefined },
        hash: location.hash,
        replace: true,
        resetScroll: false,
        state: (previous) => {
          const {
            settingsOwner: _owner,
            settingsOrigin: _origin,
            settingsOneShot: _oneShot,
            ...rest
          } = previous as typeof previous & {
            settingsOwner?: string;
            settingsOrigin?: number;
            settingsOneShot?: boolean;
          };
          return rest;
        },
      });
    }
  };
  const settingsNavigation = {
    projects: sidebar.projects,
    projectId: entryProjectId,
    returnTo: overlay ? workLocation : returnTo,
    search: { ...(entryProjectId ? { projectId: entryProjectId } : {}), returnTo: entryReturnTo },
    overlay,
    section: overlay ? overlaySearch.settings : undefined,
    close: overlay ? closeSettings : undefined,
    link: (section: string, targetProject = entryProjectId) => {
      if (settings || !workHref(location.href))
        return standaloneSettingsLink(section, {
          ...(targetProject ? { projectId: targetProject } : {}),
          returnTo: entryReturnTo,
        });
      return {
        to: location.pathname,
        search: { ...location.search, settings: section, settingsProject: targetProject },
        hash: location.hash,
        replace: overlay,
        resetScroll: false as const,
        state: (previous: typeof location.state) =>
          overlay ? previous : {
            ...previous, settingsOwner, settingsOrigin: previous.__TSR_index,
            settingsOneShot: Boolean(location.search.newSession || location.search.draft),
          },
      };
    },
    selectProject: overlay
      ? (target: string) => {
          void navigate({
            to: location.pathname,
            search: { ...location.search, settingsProject: target || undefined },
            hash: location.hash,
            replace: true,
            resetScroll: false,
            state: true,
          });
        }
      : undefined,
  };
  useEffect(() => {
    if (!settings && !overlay)
      setLastWork({ href: workLocation, ...(projectId ? { projectId } : {}) });
  }, [settings, overlay, workLocation, projectId]);
  const section = settingsSection(location.pathname, location.search.section);
  const settingsTitle = !settings
    ? ''
    : section === 'defaults' || section === 'project-defaults'
      ? tn(section === 'defaults' ? 'personalDefaults' : 'projectDefaults')
      : section === 'harness'
        ? th('heading')
        : ['skills', 'hooks', 'mcp'].includes(section)
          ? tr(section)
          : section === 'workspace'
            ? tn('projectFolder')
            : td(section);
  const pageTitle = settings
    ? settingsTitle
    : (data?.session?.title ??
      data?.definition?.name ??
      (location.pathname === '/projects'
        ? projectsText('allProjects')
        : selectedRun
          ? tn('runDetails')
          : location.pathname === '/compare'
            ? tn('compare')
            : location.pathname === '/demo'
              ? tn('demo')
              : ''));
  const activeRuns = sidebar.runs.filter(
    (run) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status),
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1023px)').matches);
  const showLocation = !/^\/sessions\/[^/]+(?:\/|$)/.test(location.pathname);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const media = matchMedia('(max-width: 1023px)');
    const update = () => {
      setNarrow(media.matches);
      setMobileOpen(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    void location.href;
    setMobileOpen(false);
  }, [location.href]);
  useEffect(() => {
    // The desktop window and its title bar buttons follow the page's theme (CR-017).
    const update = () => {
      const dark = applyTheme(prefs.theme);
      void desktop?.theme(dark).catch(() => {});
    };
    update();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [prefs.theme]);
  useEffect(() => {
    if (!prefs.sidebarOpen) setMobileOpen(false);
  }, [prefs.sidebarOpen]);
  return (
    <TooltipProvider>
      <SettingsNavigationContext.Provider value={settingsNavigation}>
        <TopbarSlotContext.Provider value={slot}>
          <div
            className="app-shell"
            data-sidebar-open={prefs.sidebarOpen}
            style={{ '--app-sidebar-width': `${prefs.sidebarWidth}px` } as CSSProperties}
          >
            {narrow ? (
              <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
                <DialogPopup
                  className="mobile-sidebar-dialog"
                  showCloseButton={false}
                  bottomStickOnMobile={false}
                  finalFocus={sidebarTrigger}
                >
                  <DialogTitle className="sr-only">{tw('expandSidebar')}</DialogTitle>
                  {settings ? (
                    <SettingsNavigation inbox={sidebar.inbox} currentProject={sidebar.current} />
                  ) : (
                    <Sidebar model={sidebar} />
                  )}
                </DialogPopup>
              </Dialog>
            ) : (
              <aside className="app-sidebar">
                {settings ? (
                  <SettingsNavigation inbox={sidebar.inbox} currentProject={sidebar.current} />
                ) : (
                  <Sidebar model={sidebar} />
                )}
              </aside>
            )}
            {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA window splitter */}
            <div
              role="separator"
              aria-label={tw('resizeSidebar')}
              aria-orientation="vertical"
              tabIndex={0}
              aria-valuenow={prefs.sidebarWidth}
              aria-valuemin={220}
              aria-valuemax={420}
              className="app-sidebar-resizer"
              onPointerDown={(e) => {
                drag.current = { x: e.clientX, width: prefs.sidebarWidth };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (drag.current)
                  changePreferences({
                    sidebarWidth: drag.current.width + e.clientX - drag.current.x,
                  });
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  changePreferences({
                    sidebarWidth: prefs.sidebarWidth + (e.key === 'ArrowRight' ? 16 : -16),
                  });
                }
              }}
            />
            <div className="app-main">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a title bar's double click is a pointer convenience; the window menu does the same */}
              <header className="app-topbar" onDoubleClick={onTopbarDoubleClick}>
                <h1 className="sr-only">{t('title')}</h1>
                <Tooltip content={tw('expandSidebar')} shortcut={shortcutLabel('view.sidebar')}>
                  <Button
                    ref={sidebarTrigger}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tw('expandSidebar')}
                    className="app-sidebar-trigger"
                    onClick={() => {
                      changePreferences({ sidebarOpen: true });
                      setMobileOpen((v) => !v);
                    }}
                  >
                    <PanelLeft />
                  </Button>
                </Tooltip>
                {showLocation ? (
                  <nav
                    aria-label={tn('location')}
                    className="flex min-w-0 items-center gap-1.5 text-ui"
                  >
                    {settings ? (
                      <span className="shrink-0 text-muted">{td('settings')}</span>
                    ) : narrow || !prefs.sidebarOpen ? (
                      <ProjectSwitcher projects={sidebar.projects} projectId={projectId} />
                    ) : project ? (
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: project.projectId }}
                        className="max-w-52 truncate text-muted hover:text-text"
                      >
                        {projectName(project, projectsText('defaultName'))}
                      </Link>
                    ) : null}
                    {pageTitle ? (
                      <>
                        {settings || project ? (
                          <span aria-hidden="true" className="text-muted/50">
                            /
                          </span>
                        ) : null}
                        <h2 className="truncate font-medium">{pageTitle}</h2>
                      </>
                    ) : null}
                  </nav>
                ) : (
                  <h2 className="sr-only">{pageTitle}</h2>
                )}
                <SessionTabs sessions={sidebar.sessions} />
                {settings && activeRuns.length ? (
                  <Menu>
                    <MenuTrigger render={<Button variant="ghost" size="sm" />}>
                      {tn('activeRun')} ({activeRuns.length})
                    </MenuTrigger>
                    <MenuPopup>
                      {activeRuns.map((run) => (
                        <MenuItem
                          key={run.runId}
                          onClick={() =>
                            void navigate({
                              to: '/runs/$runId',
                              params: { runId: run.runId },
                            })
                          }
                        >
                          {sidebar.sessions.find((session) => session.sessionId === run.sessionId)
                            ?.title ?? run.runId}{' '}
                          · {run.runId}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : null}
                <div ref={setSlot} className="ml-auto flex shrink-0 items-center gap-1" />
                <Tooltip content={tp('button')} shortcut={shortcutLabel('palette')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tp('button')}
                    onClick={() => window.dispatchEvent(new Event('corral:open-palette'))}
                  >
                    <Search />
                  </Button>
                </Tooltip>
              </header>
              <SettingsOperationStatus />
              <div className="app-outlet">
                <Outlet />
                {!overlay ? <SettingsLeavePrompt /> : null}
              </div>
            </div>
            <CommandLayer />
            {overlay && overlaySearch.settings ? (
              <SettingsDialog
                section={overlaySearch.settings}
                inbox={sidebar.inbox}
                currentProject={sidebar.current}
              />
            ) : null}
          </div>
        </TopbarSlotContext.Provider>
      </SettingsNavigationContext.Provider>
    </TooltipProvider>
  );
}

/** The project Studio works in (CR-010); choosing one opens it, or the list of all. */
function ProjectSwitcher({
  projects,
  projectId,
}: {
  projects: ProjectSummary[];
  projectId?: string;
}) {
  const t = useTranslations('Projects');
  const n = useTranslations('Navigation');
  const navigate = useNavigate();
  const options = projects.filter((p) => !p.archivedAt || p.projectId === projectId);
  const chosen = options.find((p) => p.projectId === projectId);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={n('switchProject')}
            className="min-w-0 max-w-52 gap-1 px-2 font-medium"
          />
        }
      >
        <span className="truncate">
          {chosen ? projectName(chosen, t('defaultName')) : t('allProjects')}
        </span>
        <ChevronDown className="size-3.5 text-muted" />
      </MenuTrigger>
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

export function NotFoundView() {
  const t = useTranslations('Studio');
  return (
    <main className="flex flex-col items-start gap-3 p-6">
      <h2 className="text-lg font-semibold">{t('notFound')}</h2>
      <Link to="/" className="text-sm underline">
        {t('backToCorrals')}
      </Link>
    </main>
  );
}

export function ErrorView({ error }: ErrorComponentProps) {
  const t = useTranslations('Studio');
  const router = useRouter();
  return (
    <main role="alert" className="flex flex-col items-start gap-3 p-6">
      <h2 className="text-lg font-semibold">
        {t('error', { message: error instanceof Error ? error.message : String(error) })}
      </h2>
      <button
        type="button"
        onClick={() => router.invalidate()}
        className="rounded fill-control px-2 py-1 text-sm"
      >
        ↻
      </button>
      <Link to="/" className="text-sm underline">
        {t('backToCorrals')}
      </Link>
    </main>
  );
}

/** Server mode without a session: nothing can be read, so say how to get one. */
export function SessionMissingView() {
  const t = useTranslations('Studio');
  return (
    <main className="flex flex-col items-start gap-3 p-6">
      <h1 className="text-base font-semibold">{t('title')}</h1>
      <p role="alert" className="text-sm text-danger">
        {t('sessionMissing')}
      </p>
    </main>
  );
}
