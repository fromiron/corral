// Adapted from T3 Code Sidebar's grouped rows and action menus (MIT). See THIRD-PARTY-NOTICES/T3-Code.md.
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  Ellipsis,
  Folder,
  FolderPlus,
  Inbox,
  LoaderCircle,
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
} from '@corral/react/ui';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useRemembered } from '../pages/Workbench.tsx';
import {
  projectName,
  projectsChanged,
  useCurrentProject,
  useProjectsVersion,
} from '../projects.ts';
import { useServices } from '../services.tsx';
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

export const Sidebar = memo(function Sidebar() {
  const t = useTranslations('Desktop');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('Projects');
  const ts = useTranslations('Sessions');
  const status = useTranslations('Status');
  const { repository } = useServices();
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
    estimateSize: (index) => (rows[index]?.kind === 'session' ? 64 : 36),
    overscan: 6,
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
      <div className="flex h-[52px] shrink-0 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="corral-mark">c</span>Corral
        </Link>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tw('collapseSidebar')}
          onClick={() => changePreferences({ sidebarOpen: false })}
        >
          <PanelLeft />
        </Button>
      </div>
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-transparent px-2 text-muted focus-within:border-line focus-within:bg-raised">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label={tw('searchSessions')}
            placeholder={t('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
          />
          <Link
            to="/projects/$projectId"
            params={{ projectId: model.current }}
            search={{ newSession: true }}
            aria-label={tw('newSession')}
            className="rounded p-1 hover:bg-raised"
          >
            <SquarePen size={17} />
          </Link>
        </div>
      </div>
      {model.inbox > 0 ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId: model.current }}
          className="mx-3 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-warning"
        >
          <Inbox size={16} />
          {tw('needsYou', { count: model.inbox })}
        </Link>
      ) : null}
      <div className="px-2 pt-2">
        <div className="mb-2 flex items-center justify-between px-2 text-xs text-muted">
          <Link to="/projects" className="flex items-center gap-2">
            <Folder size={15} />
            {tw('allProjects')}
          </Link>
          <Link to="/projects" aria-label={t('newProject')} className="rounded p-1 hover:bg-raised">
            <FolderPlus size={15} />
          </Link>
        </div>
        {model.error ? (
          <p role="alert" className="p-2 text-xs text-danger">
            {model.error}
          </p>
        ) : null}
      </div>
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
                <p key={item.key} style={position} className="px-7 py-2 text-xs text-muted">
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
                  className="flex items-center gap-1 px-1 text-xs font-medium text-muted"
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('toggleProject', {
                      name: projectName(project, tp('defaultName')),
                    })}
                    aria-expanded={!folded}
                    onClick={() => setCollapsed({ ...collapsed, [project.projectId]: !folded })}
                  >
                    <ChevronDown size={13} className={folded ? '-rotate-90' : ''} />
                  </Button>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.projectId }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 hover:text-text"
                  >
                    <Folder size={14} />
                    <span className="truncate">{projectName(project, tp('defaultName'))}</span>
                  </Link>
                </div>
              );
            }
            const session = row.session;
            const active = path.startsWith(`/sessions/${session.sessionId}`);
            const run = model.runs.find((r) => r.sessionId === session.sessionId);
            const working =
              run && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status);
            return (
              <div
                key={item.key}
                data-sidebar-index={item.index}
                style={position}
                className={`group/sidebar-row rounded-xl border-b-4 border-sidebar transition-colors ${active ? 'bg-sidebar-selected' : 'hover:bg-sidebar-selected/60'}`}
              >
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: session.sessionId }}
                  aria-current={active ? 'page' : undefined}
                  className="block min-w-0 rounded-xl px-3 pt-2.5 pr-9 pb-2.5"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${active ? 'font-medium text-text' : 'text-text/85'}`}
                    >
                      {session.title}
                    </span>
                    {session.pinned ? <Pin size={12} className="shrink-0 text-muted" /> : null}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                    {run?.status === 'running' ? (
                      <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" />
                    ) : run?.status === 'failed' ? (
                      <CircleAlert size={11} className="text-danger" />
                    ) : (
                      <span className="h-1 w-1 rounded-full bg-muted/50" />
                    )}
                    {working
                      ? status(run.status)
                      : run
                        ? t('runCount', {
                            count: model.runs.filter((r) => r.sessionId === session.sessionId)
                              .length,
                          })
                        : t('ready')}
                  </span>
                </Link>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('sessionActions', { title: session.title })}
                        className="absolute top-2 right-1.5 text-muted opacity-60 group-hover/sidebar-row:opacity-100 focus-visible:opacity-100"
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
                      disabled={busy || Boolean(working)}
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
      <div className="flex shrink-0 items-center gap-1 border-t border-line/50 p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('settings')}
          onClick={() => void navigate({ to: '/settings' })}
        >
          <Settings />
        </Button>
        <Link
          to="/projects/$projectId"
          params={{ projectId: model.current }}
          hash="corrals"
          aria-label={tw('teamLibrary')}
          className="rounded-lg p-2 text-muted hover:bg-raised"
        >
          <BookOpen size={17} />
        </Link>
        <span className="ml-auto pr-2 text-[11px] text-muted">Corral Workbench</span>
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
