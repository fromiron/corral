import type { ProjectSummary } from '@corral/core';
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CommandLayer, modKey } from '../CommandPalette.tsx';
import { LOCALES, type Locale, useLocale } from '../locale.tsx';
import { projectName, useCurrentProject, useProjectsVersion } from '../projects.ts';
import { useServices } from '../services.tsx';

export function RootLayout() {
  const t = useTranslations('Studio');
  const tp = useTranslations('CommandPalette');
  const { mode, live } = useServices();
  const { locale, setLocale } = useLocale();
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised px-4 py-2">
        <nav className="flex items-center gap-4">
          <h1 className="text-base font-semibold">{t('title')}</h1>
          <ProjectSwitcher />
          <Link to="/" className="text-sm underline-offset-4 hover:underline">
            {t('nav')}
          </Link>
          {mode === 'server' ? (
            <Link to="/settings/models" className="text-sm underline-offset-4 hover:underline">
              {t('navModels')}
            </Link>
          ) : null}
        </nav>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
          }
          className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-xs text-muted"
        >
          {tp('button')}
          <kbd className="font-mono">{modKey()} K</kbd>
        </button>
        <label className="flex items-center gap-1 text-xs text-muted">
          <span>{t('language')}</span>
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
            className="rounded border border-line bg-surface px-1 py-0.5 text-text"
          >
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-warning px-2 py-0.5 font-semibold text-warning">
            {mode === 'server' ? (live ? t('liveBadge') : t('serverBadge')) : t('demoBadge')}
          </span>
          <span className="text-muted">
            {mode === 'server' ? (live ? t('liveNote') : t('serverNote')) : t('demoNote')}
          </span>
        </p>
      </header>
      <div className="min-h-0">
        <Outlet />
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
      <span aria-hidden="true">{t('label')}</span>
      <select
        aria-label={t('label')}
        value={options.some((p) => p.projectId === current) ? current : ''}
        onChange={(event) => {
          const value = event.target.value;
          if (value === ALL) void navigate({ to: '/projects' });
          else if (value)
            void navigate({ to: '/projects/$projectId', params: { projectId: value } });
        }}
        className="max-w-48 rounded border border-line bg-surface px-1 py-0.5 text-text"
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
