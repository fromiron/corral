// Adapted from T3 Code Sidebar's grouped rows and action menus (MIT). See THIRD-PARTY-NOTICES/T3-Code.md.
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { StatusDot } from '@corral/react';
import {
  ChevronDown,
  Ellipsis,
  FolderPlus,
  Inbox,
  PanelLeft,
  Pin,
  Search,
  Settings,
  SquarePen,
} from '@corral/react/icons';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Tooltip,
} from '@corral/react/ui';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useRemembered } from '../pages/Workbench.tsx';
import {
  projectName,
  projectsChanged,
  useCurrentProject,
  useProjectsVersion,
} from '../projects.ts';
import { useServices } from '../services.tsx';
import { shortcutLabel } from '../shortcuts.ts';
import { changePreferences } from './preferences.ts';

export function useCorralSidebar() {
  const { repository, transport, workspaces } = useServices();
  const href = useRouterState({ select: (s) => s.location.href });
  const version = useProjectsVersion();
  const current = useCurrentProject();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [inbox, setInbox] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void version;
    let live = true;
    void (async () => {
      try {
        const ps = await repository.listProjects();
        const lists = await Promise.all(
          ps.filter((p) => !p.archivedAt).map((p) => repository.listSessions(p.projectId)),
        );
        if (!live) return;
        setProjects(ps.filter((p) => !p.archivedAt));
        setSessions(lists.flat().filter((s) => !s.archivedAt));
        setError(null);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [repository, version]);
  useEffect(() => {
    void href;
    let live = true;
    void repository.listSessions(current).then(
      (list) => {
        if (live)
          setSessions((all) => [
            ...all.filter((s) => s.projectId !== current),
            ...list.filter((s) => !s.archivedAt),
          ]);
      },
      (failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [repository, current, href]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void transport.listRuns().then(
        (r) => {
          if (live) setRuns(r);
        },
        () => {},
      );
      void workspaces?.inbox(current).then(
        (r) => {
          if (live) setInbox(r.length);
        },
        () => {},
      );
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [transport, workspaces, current]);
  return { projects, sessions, runs, inbox, error, current };
}

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/** "3m ago", "2h ago" in the reader's language: when a session last changed. */
function useAgo() {
  const locale = useLocale();
  const format = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'always' }),
    [locale],
  );
  return (iso: string) => {
    const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
    if (Math.abs(minutes) < 60) return format.format(Math.min(-1, minutes), 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, 'hour');
    return format.format(Math.round(hours / 24), 'day');
  };
}

export const Sidebar = memo(function Sidebar() {
  const t = useTranslations('Desktop');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('Projects');
  const ts = useTranslations('Sessions');
  const status = useTranslations('Status');
  const studio = useTranslations('Studio');
  const ago = useAgo();
  const { repository, mode, live } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const model = useCorralSidebar();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<WorkSession | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needle = query.trim().toLocaleLowerCase();
  const [collapsed, setCollapsed] = useRemembered<Record<string, boolean>>(
    'corral:sidebar-collapsed:v1',
    {},
  );
  const scroll = useRef<HTMLElement>(null);
  const rows = useMemo(() => {
    const result: (
      | { kind: 'project'; project: ProjectSummary }
      | { kind: 'session'; session: WorkSession }
      | { kind: 'empty'; id: string }
    )[] = [];
    const groups = new Map<string, WorkSession[]>();
    for (const session of model.sessions) {
      if (needle && !`${session.title}\n${session.objective}`.toLocaleLowerCase().includes(needle))
        continue;
      const group = groups.get(session.projectId) ?? [];
      group.push(session);
      groups.set(session.projectId, group);
    }
    for (const project of model.projects) {
      const sessions = groups.get(project.projectId) ?? [];
      if (needle && !sessions.length) continue;
      result.push({ kind: 'project', project });
      if (!needle && collapsed?.[project.projectId] === true) continue;
      sessions.sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
      );
      for (const session of sessions) result.push({ kind: 'session', session });
      if (!sessions.length) result.push({ kind: 'empty', id: project.projectId });
    }
    return result;
  }, [model.projects, model.sessions, needle, collapsed]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 34,
    overscan: 8,
    getItemKey: (index) => {
      const row = rows[index];
      return row?.kind === 'session'
        ? row.session.sessionId
        : row?.kind === 'project'
          ? row.project.projectId
          : `empty:${index}`;
    },
  });
  const activeIndex = rows.findIndex(
    (row) => row.kind === 'session' && path.startsWith(`/sessions/${row.session.sessionId}`),
  );
  const hasActive = activeIndex >= 0;
  // Navigate/search brings the selected session into view; background data changes do not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only intentional navigation/search scrolls the sidebar
  useLayoutEffect(() => {
    if (hasActive) virtual.scrollToIndex(activeIndex, { align: 'auto' });
  }, [path, needle, hasActive, virtual]);

  const update = async (
    session: WorkSession,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await repository.updateSession(session.sessionId, {
        ...patch,
        expectedRevision: session.revision,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEditing(null);
      projectsChanged();
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="app-sidebar" className="flex h-full min-h-0 flex-col bg-sidebar text-sm">
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-3">
        <Link to="/" className="mr-auto flex items-center gap-2 px-1 font-semibold tracking-tight">
          <span className="corral-mark">c</span>Corral
        </Link>
        <Tooltip content={tw('newSession')} shortcut={shortcutLabel('session.new')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tw('newSession')}
            render={
              <Link
                to="/projects/$projectId"
                params={{ projectId: model.current }}
                search={{ newSession: true }}
              />
            }
          >
            <SquarePen />
          </Button>
        </Tooltip>
        <Tooltip content={tw('collapseSidebar')} shortcut={shortcutLabel('view.sidebar')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tw('collapseSidebar')}
            onClick={() => changePreferences({ sidebarOpen: false })}
          >
            <PanelLeft />
          </Button>
        </Tooltip>
      </div>
      <div className="px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-md px-2 text-muted focus-within:bg-raised focus-within:ring-1 focus-within:ring-line">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={tw('searchSessions')}
            placeholder={t('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-ui text-text outline-none placeholder:text-muted"
          />
        </div>
      </div>
      {model.inbox > 0 ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId: model.current }}
          className="mx-3 mb-1 flex h-8 items-center gap-2 rounded-md px-2 text-ui text-warning hover:bg-warning/10"
        >
          <Inbox size={14} />
          {tw('needsYou', { count: model.inbox })}
        </Link>
      ) : null}
      <div className="flex items-center justify-between pt-2 pr-3 pb-1 pl-5 text-2xs font-medium text-muted">
        <Link to="/projects" className="hover:text-text">
          {tw('allProjects')}
        </Link>
        <Tooltip content={t('newProject')}>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={t('newProject')}
            render={<Link to="/projects" />}
          >
            <FolderPlus />
          </Button>
        </Tooltip>
      </div>
      {model.error ? (
        <p role="alert" className="px-5 py-1 text-xs text-danger">
          {model.error}
        </p>
      ) : null}
      <nav
        ref={scroll}
        aria-label={tw('sidebar')}
        className="min-h-0 flex-1 overflow-y-auto px-2"
        onKeyDown={(event) => {
          if (
            !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
            !(event.target instanceof HTMLElement)
          )
            return;
          const current = event.target.closest<HTMLElement>('[data-sidebar-index]');
          if (!current) return;
          let index = Number(current.dataset.sidebarIndex) + (event.key === 'ArrowDown' ? 1 : -1);
          if (event.key === 'Home') index = 0;
          if (event.key === 'End') index = rows.length - 1;
          const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
          while (rows[index]?.kind === 'empty') index += step;
          if (!rows[index]) return;
          event.preventDefault();
          virtual.scrollToIndex(index, { align: 'auto' });
          requestAnimationFrame(() =>
            scroll.current
              ?.querySelector<HTMLElement>(`[data-sidebar-index="${index}"] a`)
              ?.focus(),
          );
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const position = {
              position: 'absolute' as const,
              top: item.start,
              left: 0,
              width: '100%',
              height: item.size,
            };
            if (row.kind === 'empty')
              return (
                <p key={item.key} style={position} className="px-8 py-2 text-xs text-muted">
                  {tw('noSessions')}
                </p>
              );
            if (row.kind === 'project') {
              const project = row.project;
              const folded = !needle && collapsed?.[project.projectId] === true;
              return (
                <div
                  key={item.key}
                  data-sidebar-index={item.index}
                  style={position}
                  className="flex items-center gap-0.5 px-1 pt-1 text-ui font-medium text-muted"
                >
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={t('toggleProject', {
                      name: projectName(project, tp('defaultName')),
                    })}
                    aria-expanded={!folded}
                    onClick={() => setCollapsed({ ...collapsed, [project.projectId]: !folded })}
                  >
                    <ChevronDown className={`transition-transform ${folded ? '-rotate-90' : ''}`} />
                  </Button>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.projectId }}
                    className="flex min-w-0 flex-1 items-center rounded-md py-1 hover:text-text"
                  >
                    <span className="truncate">{projectName(project, tp('defaultName'))}</span>
                  </Link>
                </div>
              );
            }
            const session = row.session;
            const active = path.startsWith(`/sessions/${session.sessionId}`);
            const run = model.runs.find((r) => r.sessionId === session.sessionId);
            const working = Boolean(run && !ENDED.has(run.status));
            // Only what needs attention shows a dot: working, waiting for a person, or failed.
            const flagged = run && (working || run.status === 'failed');
            return (
              <div
                key={item.key}
                data-sidebar-index={item.index}
                style={position}
                className="group/sidebar-row relative py-px"
              >
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: session.sessionId }}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-8 min-w-0 items-center gap-2 rounded-md pr-2 pl-7 text-ui transition-colors ${active ? 'bg-sidebar-selected font-medium text-text' : 'text-text/85 hover:bg-subtle'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  {session.pinned ? <Pin size={12} className="shrink-0 text-muted" /> : null}
                  {flagged ? (
                    <StatusDot status={run.status} label={status(run.status)} />
                  ) : (
                    <span className="shrink-0 text-2xs text-muted group-focus-within/sidebar-row:invisible group-hover/sidebar-row:invisible">
                      {ago(session.updatedAt)}
                    </span>
                  )}
                </Link>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={t('sessionActions', { title: session.title })}
                        className="absolute top-1 right-1 opacity-0 group-focus-within/sidebar-row:opacity-100 group-hover/sidebar-row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                      />
                    }
                  >
                    <Ellipsis />
                  </MenuTrigger>
                  <MenuPopup align="start" side="right">
                    <MenuItem
                      onClick={() => {
                        setTitle(session.title);
                        setEditing(session);
                      }}
                    >
                      {t('rename')}
                    </MenuItem>
                    <MenuItem
                      disabled={busy}
                      onClick={() => void update(session, { pinned: !session.pinned })}
                    >
                      {session.pinned ? ts('unpin') : ts('pin')}
                    </MenuItem>
                    <MenuItem
                      disabled={busy || working}
                      onClick={() => void update(session, { archived: true })}
                    >
                      {ts('archive')}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            );
          })}
        </div>
        {needle &&
        !model.sessions.some((s) =>
          `${s.title}\n${s.objective}`.toLocaleLowerCase().includes(needle),
        ) ? (
          <p className="p-3 text-xs text-muted">{t('noMatches')}</p>
        ) : null}
      </nav>
      {error && !editing ? (
        <p role="alert" className="px-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex shrink-0 items-center gap-1 border-t border-line/50 px-2 py-2">
        <Button
          variant="ghost-muted"
          size="sm"
          className="gap-2"
          onClick={() => void navigate({ to: '/settings' })}
        >
          <Settings />
          {t('settings')}
        </Button>
        <Tooltip
          side="top"
          content={
            mode === 'server'
              ? live
                ? studio('liveNote')
                : studio('serverNote')
              : studio('demoNote')
          }
        >
          <button
            type="button"
            className="ml-auto flex items-center gap-1.5 rounded px-1.5 py-1 text-2xs text-muted"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${live ? 'bg-success' : 'bg-warning'}`}
            />
            {mode === 'server'
              ? live
                ? studio('liveShort')
                : studio('serverShort')
              : studio('demoShort')}
          </button>
        </Tooltip>
      </div>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t('rename')}</DialogTitle>
            <DialogDescription>{t('renameHint')}</DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t('sessionTitle')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && editing && title.trim())
                void update(editing, { title });
            }}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={busy || !title.trim()}
              onClick={() => editing && void update(editing, { title })}
            >
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
