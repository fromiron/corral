import type { ProjectSummary } from '@corral/core';
import { LayoutGrid, PanelLeft, Search, Settings } from '@corral/react/icons';
import { Button, Dialog, DialogPopup, DialogTitle } from '@corral/react/ui';
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
import { CommandLayer, modKey } from '../CommandPalette.tsx';
import { WindowControls } from '../desktop.tsx';
import { projectName, useCurrentProject, useProjectsVersion } from '../projects.ts';
import { useServices } from '../services.tsx';
import { applyTheme, changePreferences, usePreferences } from '../workbench/preferences.ts';
import { Sidebar } from '../workbench/Sidebar.tsx';

export function RootLayout() {
  const t = useTranslations('Studio');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('CommandPalette');
  const { mode, live } = useServices();
  const prefs = usePreferences();
  const location = useRouterState({ select: (s) => s.location.href });
  const data = useRouterState({ select: (s) => s.matches.at(-1)?.loaderData }) as
    | { session?: { title: string } }
    | undefined;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1023px)').matches);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
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
    applyTheme(prefs.theme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(prefs.theme);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [prefs.theme]);
  useEffect(() => {
    if (!prefs.sidebarOpen) setMobileOpen(false);
  }, [prefs.sidebarOpen]);
  return (
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
            changePreferences({ sidebarWidth: drag.current.width + e.clientX - drag.current.x });
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
        <header className="app-topbar">
          <h1 className="sr-only">{t('title')}</h1>
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
          <ProjectSwitcher />
          {data?.session ? (
            <h2 className="min-w-0 truncate text-sm font-medium">
              <span className="mx-2 text-muted/50">/</span>
              {data.session.title}
            </h2>
          ) : null}
          <nav className="ml-auto flex shrink-0 items-center gap-1" aria-label={t('nav')}>
            <Link to="/" aria-label={t('nav')} title={t('nav')} className="topbar-icon">
              <LayoutGrid size={16} />
            </Link>
            {mode === 'server' ? (
              <Link
                to="/settings/models"
                aria-label={t('navModels')}
                title={t('navModels')}
                className="topbar-icon"
              >
                <Settings size={16} />
              </Link>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tp('button')}
              title={`${tp('button')} (${modKey()} K)`}
              onClick={() =>
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
              }
            >
              <Search />
            </Button>
          </nav>
          <span
            className="runtime-badge"
            title={mode === 'server' ? (live ? t('liveNote') : t('serverNote')) : t('demoNote')}
          >
            <span className={live ? 'bg-success' : 'bg-warning'} />
            {mode === 'server' ? (live ? t('liveBadge') : t('serverBadge')) : t('demoBadge')}
          </span>
          <WindowControls />
        </header>
        <div className="app-outlet">
          <Outlet />
        </div>
      </div>
      <CommandLayer />
    </div>
  );
}

const ALL = '__all';

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
  return (
    <label className="flex items-center gap-1 text-xs text-muted">
      <span className="sr-only">{t('label')}</span>
      <select
        aria-label={t('label')}
        value={options.some((p) => p.projectId === current) ? current : ''}
        onChange={(event) => {
          const value = event.target.value;
          if (value === ALL) void navigate({ to: '/projects' });
          else if (value)
            void navigate({ to: '/projects/$projectId', params: { projectId: value } });
        }}
        className="max-w-44 rounded-md border border-transparent bg-transparent py-1 pr-2 text-ui font-medium text-text hover:bg-raised"
      >
        {options.some((p) => p.projectId === current) ? null : <option value="">—</option>}
        {options.map((p) => (
          <option key={p.projectId} value={p.projectId}>
            {projectName(p, t('defaultName'))}
          </option>
        ))}
        <option value={ALL}>{t('allProjects')}</option>
      </select>
    </label>
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
