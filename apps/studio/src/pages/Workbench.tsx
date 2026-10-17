import type { WorkSession } from '@corral/core';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { projectName, useProjectsVersion } from '../projects.ts';
import { useServices } from '../services.tsx';

// The workbench frame (02-UX-Spec §1–§2): projects and sessions on the left, the work in the
// middle, and a side panel on the right. Both sides can be resized (pointer or arrow keys) and
// hidden; the widths and choices are remembered in this browser. Below 1024px one area shows
// at a time, chosen from a tab row, so nothing is squeezed.

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** A view preference kept in this browser; never a fact about a run (02-UX-Spec §9). */
export function useRemembered<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => stored(key, fallback));
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Remembered for this page only.
    }
  };
  return [value, set];
}

const LEFT = { initial: 240, min: 180, max: 420 };
const RIGHT = { initial: 360, min: 280, max: 720 };

function Resizer({
  label,
  value,
  bounds,
  onChange,
  invert = false,
}: {
  label: string;
  value: number;
  bounds: { min: number; max: number };
  onChange: (value: number) => void;
  /** The right panel grows when dragged left. */
  invert?: boolean;
}) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (n: number) => Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    onChange(clamp(value + (invert ? -delta : delta)));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const delta = event.clientX - start.current.x;
    onChange(clamp(start.current.value + (invert ? -delta : delta)));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter is the WAI-ARIA window splitter pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        start.current = null;
      }}
      className="hidden w-1 shrink-0 cursor-col-resize bg-line/40 hover:bg-accent focus-visible:bg-accent lg:block"
    />
  );
}

type Area = 'sidebar' | 'main' | 'panel';

export function WorkbenchLayout({
  sidebar,
  main,
  panel,
}: {
  sidebar: ReactNode;
  main: ReactNode;
  /** The right panel; omitted on pages that have none. */
  panel?: ReactNode;
}) {
  const t = useTranslations('Workbench');
  const [left, setLeft] = useRemembered('corral:wb:left', LEFT.initial);
  const [right, setRight] = useRemembered('corral:wb:right', RIGHT.initial);
  const [leftOpen, setLeftOpen] = useRemembered('corral:wb:left-open', true);
  const [rightOpen, setRightOpen] = useRemembered('corral:wb:right-open', true);
  const [area, setArea] = useState<Area>('main');
  const areas: Area[] = panel ? ['sidebar', 'main', 'panel'] : ['sidebar', 'main'];
  const shown = (name: Area) => (area === name ? 'flex' : 'hidden');
  const label = { sidebar: t('areaSidebar'), main: t('areaMain'), panel: t('areaPanel') };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={t('areas')}
        className="flex gap-1 border-b border-line px-2 py-1 lg:hidden"
      >
        {areas.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={area === name}
            onClick={() => setArea(name)}
            className={`rounded px-2 py-1 text-xs ${area === name ? 'bg-accent text-on-accent' : 'border border-line'}`}
          >
            {label[name]}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        {leftOpen ? (
          <>
            <nav
              aria-label={t('sidebar')}
              style={{ ['--wb-left' as string]: `${left}px` }}
              className={`${shown('sidebar')} min-h-0 w-full shrink-0 flex-col overflow-auto border-r border-line lg:flex lg:w-[var(--wb-left)]`}
            >
              <div className="flex justify-end px-2 pt-2 max-lg:hidden">
                <button
                  type="button"
                  onClick={() => setLeftOpen(false)}
                  aria-label={t('collapseSidebar')}
                  className="rounded border border-line px-1.5 text-xs"
                >
                  «
                </button>
              </div>
              {sidebar}
            </nav>
            <Resizer label={t('resizeSidebar')} value={left} bounds={LEFT} onChange={setLeft} />
          </>
        ) : (
          <button
            type="button"
            onClick={() => setLeftOpen(true)}
            aria-label={t('expandSidebar')}
            className="hidden shrink-0 border-r border-line px-1 text-xs lg:block"
          >
            »
          </button>
        )}
        <div className={`${shown('main')} min-h-0 min-w-0 flex-1 flex-col lg:flex`}>{main}</div>
        {panel ? (
          rightOpen ? (
            <>
              <Resizer
                label={t('resizePanel')}
                value={right}
                bounds={RIGHT}
                onChange={setRight}
                invert
              />
              <aside
                aria-label={t('panelTabs')}
                style={{ ['--wb-right' as string]: `${right}px` }}
                className={`${shown('panel')} min-h-0 w-full shrink-0 flex-col overflow-auto border-l border-line lg:flex lg:w-[var(--wb-right)]`}
              >
                <div className="flex px-2 pt-2 max-lg:hidden">
                  <button
                    type="button"
                    onClick={() => setRightOpen(false)}
                    aria-label={t('collapsePanel')}
                    className="rounded border border-line px-1.5 text-xs"
                  >
                    »
                  </button>
                </div>
                {panel}
              </aside>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setRightOpen(true)}
              aria-label={t('expandPanel')}
              className="hidden shrink-0 border-l border-line px-1 text-xs lg:block"
            >
              «
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

/** The current project's sessions, what needs a person, and the way to teams and settings. */
export function WorkbenchSidebar({
  projectId,
  activeSessionId = null,
}: {
  projectId: string;
  activeSessionId?: string | null;
}) {
  const t = useTranslations('Workbench');
  const tp = useTranslations('Projects');
  const { repository, workspaces, mode } = useServices();
  const href = useRouterState({ select: (s) => s.location.href });
  const version = useProjectsVersion();
  const [name, setName] = useState('');
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [inbox, setInbox] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void href;
    void version;
    let live = true;
    void Promise.all([repository.listProjects(), repository.listSessions(projectId)]).then(
      ([projects, list]) => {
        if (!live) return;
        setName(
          projectName(
            projects.find((p) => p.projectId === projectId),
            tp('defaultName'),
          ),
        );
        setSessions(list.filter((s) => !s.archivedAt));
      },
    );
    workspaces?.inbox(projectId).then(
      (items) => live && setInbox(items.length),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [repository, workspaces, projectId, href, version, tp]);

  const needle = query.trim().toLowerCase();
  const shown = sessions.filter(
    (s) => !needle || `${s.title}\n${s.objective}`.toLowerCase().includes(needle),
  );

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div className="flex flex-col">
        <span className="text-xs text-muted">{tp('label')}</span>
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="font-semibold underline-offset-4 hover:underline"
        >
          {name || '…'}
        </Link>
      </div>
      <input
        type="search"
        aria-label={t('searchSessions')}
        placeholder={t('searchSessions')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="rounded border border-line bg-surface px-2 py-1 text-xs"
      />
      {inbox > 0 ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="rounded border border-warning px-2 py-1 text-xs text-warning"
        >
          {t('needsYou', { count: inbox })}
        </Link>
      ) : null}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-muted">{t('sessions')}</h2>
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ newSession: true }}
          className="text-xs underline"
        >
          {t('newSession')}
        </Link>
      </div>
      {shown.length === 0 ? <p className="text-xs text-muted">{t('noSessions')}</p> : null}
      <ul className="flex flex-col gap-0.5">
        {shown.map((s) => (
          <li key={s.sessionId}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: s.sessionId }}
              aria-current={s.sessionId === activeSessionId ? 'page' : undefined}
              className={`block truncate rounded px-2 py-1 ${
                s.sessionId === activeSessionId ? 'bg-accent/15 font-medium' : 'hover:bg-raised'
              }`}
            >
              {s.pinned ? '📌 ' : ''}
              {s.title}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-xs">
        <Link to="/projects/$projectId" params={{ projectId }} hash="corrals" className="underline">
          {t('teamLibrary')}
        </Link>
        <Link to="/projects" className="underline">
          {t('allProjects')}
        </Link>
        {mode === 'server' ? (
          <Link to="/settings/models" className="underline">
            {t('models')}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
