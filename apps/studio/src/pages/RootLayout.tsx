import { ApiError } from '@corral/client';
import type { ProjectSummary } from '@corral/core';
import {
  Banner,
  BannerTitle,
  Button,
  cn,
  Dialog,
  DialogPopup,
  DialogTitle,
  fontWeights,
  SidebarProvider,
  type SidebarRailProps,
  Tooltip,
  TooltipProvider,
  useShape,
} from '@corral/react/design-kit';
import { PanelLeft, RefreshCw, Search } from '@corral/react/icons';
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useBlocker,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CommandLayer } from '../CommandPalette.tsx';
import { OPEN_PALETTE, useRegisterCommands } from '../commandRegistry.ts';
import { desktop, onTopbarDoubleClick } from '../desktop.tsx';
import { useServices } from '../services.tsx';
import { SESSION_MISSING } from '../sessionConnection.ts';
import { useShortcutBindings } from '../shortcutBindings.ts';
import { shortcutLabel } from '../shortcuts.ts';
import { documentStore } from '../workbench/documents/store.ts';
import { hasUnsavedEditorCopy } from '../workbench/editorDraft.ts';
import { NEW_MEETING, NewMeetingHost } from '../workbench/NewMeeting.tsx';
import {
  SettingsNavigationContext,
  standaloneSettingsLink,
  validateSettingsOverlay,
  withoutSettings,
  workHref,
} from '../workbench/navigation.ts';
import { applyTheme, changePreferences, usePreferences } from '../workbench/preferences.ts';
import { ScheduledRunNotifications } from '../workbench/ScheduledRunNotifications.tsx';
import { useSessionJump } from '../workbench/SessionJump.tsx';
import { SettingsDialog } from '../workbench/SettingsDialog.tsx';
import {
  SettingsLeavePrompt,
  SettingsLifecycle,
  SettingsOperationStatus,
} from '../workbench/SettingsLifecycle.tsx';
import { Sidebar, useCorralSidebar } from '../workbench/Sidebar.tsx';
import { outsidePage, TopbarPath } from '../workbench/TopbarPath.tsx';
import { TopbarBar, TopbarFit, TopbarSlotContext } from '../workbench/TopbarSlot.tsx';

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
  const { repository, workspaces, mode } = useServices();
  const [sessionMissing, setSessionMissing] = useState(false);
  useEffect(() => {
    const expired = () => setSessionMissing(true);
    window.addEventListener(SESSION_MISSING, expired);
    return () => window.removeEventListener(SESSION_MISSING, expired);
  }, []);
  useBlocker({
    shouldBlockFn: () => false,
    enableBeforeUnload: () =>
      hasUnsavedEditorCopy(repository) ||
      Boolean(mode === 'server' && workspaces && documentStore(workspaces).hasUnsaved()),
  });
  const t = useTranslations('Studio');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('CommandPalette');
  const tn = useTranslations('Navigation');
  const commands = useTranslations('Commands');
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
  const overlaySearch = validateSettingsOverlay(location.search);
  const overlay = Boolean(overlaySearch.settings) && Boolean(workHref(location.href));
  const selectedRun = sidebar.runs.find(
    (run) => location.pathname === `/runs/${encodeURIComponent(run.runId)}`,
  );
  const outside = outsidePage(location.pathname);
  const projectId = outside
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
  useSessionJump(sidebar.sessions, projectId);
  const entryProjectId = overlay
    ? sidebar.projects.find(
        (item) => item.projectId === (overlaySearch.settingsProject ?? projectId),
      )?.projectId
    : projectId;
  const workLocation = workHref(location.href) ?? '/projects';
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
    returnTo: workLocation,
    search: { ...(entryProjectId ? { projectId: entryProjectId } : {}), returnTo: workLocation },
    overlay,
    section: overlay ? overlaySearch.settings : undefined,
    close: overlay ? closeSettings : undefined,
    link: (section: string, targetProject = entryProjectId) => {
      // A screen that cannot hold the dialog (such as Automation) takes the settings address,
      // which the router replaces with the dialog over Projects.
      if (!workHref(location.href))
        return standaloneSettingsLink(section, {
          ...(targetProject ? { projectId: targetProject } : {}),
          returnTo: workLocation,
        });
      return {
        to: location.pathname,
        search: { ...location.search, settings: section, settingsProject: targetProject },
        hash: location.hash,
        replace: overlay,
        resetScroll: false as const,
        state: (previous: typeof location.state) =>
          overlay
            ? previous
            : {
                ...previous,
                settingsOwner,
                settingsOrigin: previous.__TSR_index,
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
  // Outside a project the path is the screen's own name; inside, project then this page.
  const pageTitle = outside
    ? ''
    : (data?.session?.title ?? data?.definition?.name ?? (selectedRun ? tn('runDetails') : ''));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1023px)').matches);
  const shape = useShape();
  useRegisterCommands('sidebar', [
    {
      id: 'view:sidebar',
      title: (narrow ? mobileOpen : prefs.sidebarOpen)
        ? commands('hideSidebar')
        : commands('showSidebar'),
      group: commands('groups.view'),
      shortcutId: 'view.sidebar',
      shortcut: shortcutLabel('view.sidebar'),
      run: () => {
        if (narrow) {
          changePreferences({ sidebarOpen: true });
          setMobileOpen((open) => !open);
        } else changePreferences({ sidebarOpen: !prefs.sidebarOpen });
      },
    },
  ]);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [viewsSlot, setViewsSlot] = useState<HTMLElement | null>(null);
  const [crumbsSlot, setCrumbsSlot] = useState<HTMLElement | null>(null);
  const topbarSlots = useMemo(
    () => ({ actions: slot, views: viewsSlot, crumbs: crumbsSlot }),
    [slot, viewsSlot, crumbsSlot],
  );
  const openSessionId = /^\/sessions\/([^/]+)/.exec(location.pathname)?.[1];
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
  // The narrow sidebar gives way to the palette or new-meeting dialog it opened, and leaves
  // focus to that dialog instead of pulling it back to the sidebar button.
  const handedOff = useRef(false);
  useEffect(() => {
    const handOff = () => {
      handedOff.current = true;
      setMobileOpen(false);
    };
    window.addEventListener(OPEN_PALETTE, handOff);
    window.addEventListener(NEW_MEETING, handOff);
    return () => {
      window.removeEventListener(OPEN_PALETTE, handOff);
      window.removeEventListener(NEW_MEETING, handOff);
    };
  }, []);
  useEffect(() => {
    if (mobileOpen) handedOff.current = false;
  }, [mobileOpen]);
  useEffect(() => {
    // The desktop window and its title bar buttons follow the page's theme.
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
  const railProps: SidebarRailProps = {
    role: 'separator',
    'aria-label': tw('resizeSidebar'),
    'aria-orientation': 'vertical',
    'aria-valuenow': prefs.sidebarWidth,
    'aria-valuemin': 220,
    'aria-valuemax': 420,
    tabIndex: 0,
    tooltipContent: (
      <span className="flex flex-col items-start gap-2">
        <span className="[text-box:trim-both_cap_alphabetic]">{tw('sidebarResizeHint')}</span>
        <span className="[text-box:trim-both_cap_alphabetic]">{tw('sidebarCollapseHint')}</span>
      </span>
    ),
  };
  return (
    <TooltipProvider>
      <SettingsNavigationContext.Provider value={settingsNavigation}>
        <TopbarSlotContext.Provider value={topbarSlots}>
          <TopbarFit>
            <SidebarProvider
              className="app-shell min-h-0"
              data-sidebar-open={prefs.sidebarOpen}
              persist={false}
              shortcut={null}
              mobileBreakpoint={0}
              open={prefs.sidebarOpen}
              onOpenChange={(sidebarOpen) => changePreferences({ sidebarOpen })}
              width={`${prefs.sidebarWidth}px`}
              onWidthChange={(width) =>
                changePreferences({ sidebarWidth: Number.parseFloat(width) })
              }
              minWidth={220}
              maxWidth={420}
            >
              {narrow ? (
                <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
                  <DialogPopup
                    className="mobile-sidebar-dialog"
                    position="left"
                    showCloseButton={false}
                    bottomStickOnMobile={false}
                    finalFocus={() => (handedOff.current ? false : sidebarTrigger.current)}
                  >
                    <DialogTitle className="sr-only">{tw('expandSidebar')}</DialogTitle>
                    <Sidebar model={sidebar} mobile />
                  </DialogPopup>
                </Dialog>
              ) : (
                <Sidebar model={sidebar} railProps={railProps} />
              )}
              {/* The kit's SidebarInset recipe, on a div: each page renders its own <main>. Beside
                  the inset sidebar the work sits one surface up; a narrow drawer leaves the floor. */}
              <div
                className={cn(
                  'app-main relative overflow-hidden bg-background',
                  'peer-data-[variant=inset]:m-2 peer-data-[variant=inset]:peer-data-[side=left]:ml-0',
                  'peer-data-[variant=inset]:peer-data-[state=collapsed]:peer-data-[side=left]:ml-2',
                  'transition-[margin] duration-80',
                  shape.bgRadius >= 20
                    ? 'peer-data-[variant=inset]:rounded-3xl'
                    : 'peer-data-[variant=inset]:rounded-xl',
                  'peer-data-[variant=inset]:bg-surface-2 peer-data-[variant=inset]:shadow-surface-2',
                )}
              >
                {/* A title bar's double click is a pointer convenience; the window menu does the same. */}
                <TopbarBar className="app-topbar" onDoubleClick={onTopbarDoubleClick}>
                  <h1 className="sr-only">{t('title')}</h1>
                  <Tooltip content={tw('expandSidebar')} shortcut={shortcutLabel('view.sidebar')}>
                    <Button
                      ref={sidebarTrigger}
                      variant="ghost"
                      size="icon-compact"
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
                  <TopbarPath
                    pathname={location.pathname}
                    projects={sidebar.projects}
                    projectId={projectId}
                    project={project}
                    pageTitle={pageTitle}
                    sessions={sidebar.sessions}
                    runs={sidebar.runs}
                    sessionId={
                      openSessionId && data?.session ? decodeURIComponent(openSessionId) : undefined
                    }
                    onOpenSession={(sessionId) =>
                      void navigate({ to: '/sessions/$sessionId', params: { sessionId } })
                    }
                    crumbs={setCrumbsSlot}
                  />
                  <div
                    ref={setViewsSlot}
                    data-topbar-part="views"
                    className="app-topbar-views ml-auto flex shrink-0 items-center"
                  />
                  <div
                    ref={setSlot}
                    data-topbar-part="actions"
                    className="app-topbar-actions flex shrink-0 items-center gap-1"
                  />
                  <Tooltip content={tp('button')} shortcut={shortcutLabel('palette')}>
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={tp('button')}
                      onClick={() => window.dispatchEvent(new Event('corral:open-palette'))}
                    >
                      <Search />
                    </Button>
                  </Tooltip>
                </TopbarBar>
                <SettingsOperationStatus />
                <ScheduledRunNotifications
                  results={sidebar.scheduledResults}
                  dismiss={sidebar.dismissScheduled}
                />
                {sessionMissing ? (
                  <Banner status="warning" size="compact">
                    <BannerTitle>{t('sessionMissing')}</BannerTitle>
                  </Banner>
                ) : null}
                <div className="app-outlet">
                  <Outlet />
                  {!overlay ? <SettingsLeavePrompt /> : null}
                </div>
              </div>
              <CommandLayer
                sessions={sidebar.sessions}
                projects={sidebar.projects}
                projectId={projectId}
                fallbackFocus={sidebarTrigger}
              />
              <NewMeetingHost />
              {overlay && overlaySearch.settings ? (
                <SettingsDialog
                  section={overlaySearch.settings}
                  inbox={sidebar.inbox}
                  currentProject={sidebar.current}
                />
              ) : null}
            </SidebarProvider>
          </TopbarFit>
        </TopbarSlotContext.Provider>
      </SettingsNavigationContext.Provider>
    </TooltipProvider>
  );
}

export function NotFoundView() {
  const t = useTranslations('Studio');
  return (
    <main className="flex flex-col items-start gap-3 p-6">
      <h2 className="text-title" style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('notFound')}
      </h2>
      <Button variant="ghost" size="compact" render={<Link to="/" />}>
        {t('backToCorrals')}
      </Button>
    </main>
  );
}

export function ErrorView({ error }: ErrorComponentProps) {
  const t = useTranslations('Studio');
  const router = useRouter();
  if (error instanceof ApiError && error.code === 'SESSION_INVALID') return <SessionMissingView />;
  return (
    <main role="alert" className="flex flex-col items-start gap-3 p-6">
      <h2 className="text-title" style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('error', { message: error instanceof Error ? error.message : String(error) })}
      </h2>
      <div className="flex gap-2">
        <Button variant="tertiary" size="compact" onClick={() => router.invalidate()}>
          <RefreshCw />
          {t('retry')}
        </Button>
        <Button variant="ghost" size="compact" render={<Link to="/" />}>
          {t('backToCorrals')}
        </Button>
      </div>
    </main>
  );
}

/** Server mode without a session: nothing can be read, so say how to get one. */
export function SessionMissingView() {
  const t = useTranslations('Studio');
  return (
    <main className="flex flex-col items-start gap-3 p-6">
      <h1 className="text-title" style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('title')}
      </h1>
      <p role="alert" className="text-body text-danger">
        {t('sessionMissing')}
      </p>
      <Button variant="secondary" onClick={() => window.location.reload()}>
        {t('retryConnection')}
      </Button>
    </main>
  );
}
