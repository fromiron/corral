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
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CommandLayer } from '../CommandPalette.tsx';
import { desktop, onTopbarDoubleClick } from '../desktop.tsx';
import { projectName, useCurrentProject, useProjectsVersion } from '../projects.ts';
import { useServices } from '../services.tsx';
import { shortcutLabel } from '../shortcuts.ts';
import { applyTheme, changePreferences, usePreferences } from '../workbench/preferences.ts';
import { Sidebar } from '../workbench/Sidebar.tsx';
import { TopbarSlotContext } from '../workbench/TopbarSlot.tsx';

export function RootLayout() {
  const t = useTranslations('Studio');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('CommandPalette');
  const prefs = usePreferences();
  const location = useRouterState({ select: (s) => s.location.href });
  const data = useRouterState({ select: (s) => s.matches.at(-1)?.loaderData }) as
    | { session?: { title: string } }
    | undefined;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1023px)').matches);
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
    void location;
    setMobileOpen(false);
  }, [location]);
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
                <Sidebar />
              </DialogPopup>
            </Dialog>
          ) : (
            <aside className="app-sidebar">
              <Sidebar />
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
              <ProjectSwitcher />
              {data?.session ? (
                <h2 className="flex min-w-0 items-center text-ui font-medium">
                  <span aria-hidden="true" className="mr-1.5 text-muted/50">
                    /
                  </span>
                  <span className="truncate">{data.session.title}</span>
                </h2>
              ) : null}
              <div ref={setSlot} className="ml-auto flex shrink-0 items-center gap-1" />
              <Tooltip content={tp('button')} shortcut={shortcutLabel('palette')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tp('button')}
                  onClick={() =>
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
                  }
                >
                  <Search />
                </Button>
              </Tooltip>
            </header>
            <div className="app-outlet">
              <Outlet />
            </div>
          </div>
          <CommandLayer />
        </div>
      </TopbarSlotContext.Provider>
    </TooltipProvider>
  );
}

/** The project Studio works in (CR-010); choosing one opens it, or the list of all. */
function ProjectSwitcher() {
  const t = useTranslations('Projects');
  const { repository } = useServices();
  const navigate = useNavigate();
  const current = useCurrentProject();
  const version = useProjectsVersion();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  useEffect(() => {
    void version;
    let live = true;
    repository.listProjects().then(
      (list) => live && setProjects(list),
      () => live && setProjects(null),
    );
    return () => {
      live = false;
    };
  }, [repository, version]);
  if (!projects) return null;
  const options = projects.filter((p) => !p.archivedAt || p.projectId === current);
  const chosen = options.find((p) => p.projectId === current);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('label')}
            className="min-w-0 max-w-52 gap-1 px-2 font-medium"
          />
        }
      >
        <span className="truncate">{chosen ? projectName(chosen, t('defaultName')) : '—'}</span>
        <ChevronDown className="size-3.5 text-muted" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        <MenuRadioGroup
          value={chosen ? current : ''}
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
        className="rounded border border-line px-2 py-1 text-sm"
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
