import type { CorralSummary, ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { StatusDot } from '@corral/react';
import {
  Button,
  Sidebar as KitSidebar,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  type SidebarRailProps,
  SidebarSearchField,
  SidebarSeparator,
  Tooltip,
  useSize,
  WorkspaceTile,
} from '@corral/react/design-kit';
import {
  ChevronDown,
  Clock3,
  Ellipsis,
  Folder,
  FolderPlus,
  Inbox,
  PanelLeft,
  Pin,
  Settings,
  SquarePen,
  TextSearch,
} from '@corral/react/icons';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { desktop } from '../desktop.tsx';
import { useRemembered } from '../pages/Workbench.tsx';
import {
  projectName,
  projectsChanged,
  useCurrentProject,
  useProjectsVersion,
} from '../projects.ts';
import { useServices } from '../services.tsx';
import { useShortcutBindings } from '../shortcutBindings.ts';
import { shortcutLabel } from '../shortcuts.ts';
import { useSettingsNavigation, workHref } from './navigation.ts';
import {
  inboxNotificationTargets,
  type NotificationTarget,
  notificationDestination,
} from './notifications.ts';
import { changePreferences, preferences } from './preferences.ts';
import { RenameSessionDialog } from './RenameSessionDialog.tsx';
import { SessionSearchDialog } from './SessionSearchDialog.tsx';
import { useModelProfiles } from './useModels.ts';

export function useCorralSidebar() {
  const { repository, transport, workspaces } = useServices();
  const td = useTranslations('Desktop');
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => workHref(s.location.href) ?? s.location.href });
  const version = useProjectsVersion();
  const current = useCurrentProject();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [corrals, setCorrals] = useState<CorralSummary[]>([]);
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
    void version;
    let live = true;
    void Promise.all([repository.listSessions(current), repository.list()]).then(
      ([list, teams]) => {
        if (live) {
          setCorrals(teams);
          setSessions((all) => [
            ...all.filter((s) => s.projectId !== current),
            ...list.filter((s) => !s.archivedAt),
          ]);
        }
      },
      (failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [repository, current, href, version]);
  useEffect(() => {
    let live = true;
    let loading = false;
    let seen: NotificationTarget[] | null = null;
    const refresh = () => {
      if (loading) return;
      loading = Boolean(workspaces);
      void transport.listRuns().then(
        (r) => {
          if (live) setRuns(r);
        },
        () => {},
      );
      void workspaces
        ?.inbox(current)
        .then(
          (r) => {
            if (!live) return;
            setInbox(r.length);
            const added = inboxNotificationTargets(r, seen ?? r);
            // First load is the baseline; equal counts can still contain a new decision.
            seen = inboxNotificationTargets(r);
            void desktop?.badge(r.length).catch(() => {});
            if (added[0] && preferences.getState().notify && !document.hasFocus())
              void desktop
                ?.notify(td('notifyTitle'), td('notifyBody', { count: r.length }), added[0])
                .catch(() => {});
          },
          () => {},
        )
        .finally(() => {
          loading = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [transport, workspaces, current, td]);
  useEffect(() => {
    if (!desktop?.onNotification || !workspaces) return;
    let version = 0;
    const off = desktop.onNotification((target) => {
      const request = ++version;
      void notificationDestination(target, {
        getSession: (id) => repository.getSession(id),
        inbox: (id) => workspaces.inbox(id),
      })
        .then(async (to) => {
          if (!to || request !== version) return;
          await navigate({ to });
          if (request !== version || target.kind !== 'decision' || !target.runId) return;
          // Existing compact run views own the response form and its initial focus.
          document.querySelector<HTMLElement>(`[data-run-response="${target.runId}"]`)?.focus();
        })
        .catch(() => {});
    });
    return () => {
      version++;
      off();
    };
  }, [repository, workspaces, navigate]);
  return { projects, corrals, sessions, runs, inbox, error, current };
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

export const Sidebar = memo(function Sidebar({
  model,
  mobile = false,
  railProps,
}: {
  model: ReturnType<typeof useCorralSidebar>;
  mobile?: boolean;
  railProps?: SidebarRailProps;
}) {
  useShortcutBindings();
  const t = useTranslations('Desktop');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('Projects');
  const ts = useTranslations('Sessions');
  const status = useTranslations('Status');
  const studio = useTranslations('Studio');
  const ago = useAgo();
  const profiles = useModelProfiles();
  const connected = Boolean(profiles?.some((p) => p.available));
  const { repository, mode, live } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const settingsNavigation = useSettingsNavigation();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchText = useTranslations('SessionSearch');
  const [editing, setEditing] = useState<WorkSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needle = query.trim().toLocaleLowerCase();
  const [collapsed, setCollapsed] = useRemembered<Record<string, boolean>>(
    'corral:sidebar-collapsed:v1',
    {},
  );
  const scroll = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const compact = useSize().variant === 'compact';
  const projectHeight = compact ? 28 : 32;
  const sessionHeight = compact ? 24 : 28;
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
  // Keep one virtual range across projects, but retain the source tree ancestry
  // for every mounted conversation. A project header remains with its visible
  // children even when that header itself is above the viewport.
  const tree = useMemo(() => {
    const groups: {
      project: ProjectSummary;
      index: number;
      start: number;
      size: number;
    }[] = [];
    const byIndex: typeof groups = [];
    let offset = 0;
    for (const [index, row] of rows.entries()) {
      if (row.kind === 'project')
        groups.push({ project: row.project, index, start: offset, size: 0 });
      const group = groups.at(-1);
      if (!group) continue;
      const height = row.kind === 'project' ? projectHeight : sessionHeight;
      group.size += height;
      byIndex[index] = group;
      offset += height;
    }
    return { groups, byIndex };
  }, [rows, projectHeight, sessionHeight]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => (rows[index]?.kind === 'project' ? projectHeight : sessionHeight),
    scrollMargin,
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
  useLayoutEffect(() => {
    const viewport = scroll.current;
    const menu = list.current;
    if (!viewport || !menu) return;
    // The source Workspace group and project label share this scroller. Their
    // measured height is the virtual list's origin, not another scroll surface.
    const measure = () =>
      setScrollMargin(
        menu.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop,
      );
    measure();
    const observer = new ResizeObserver(measure);
    const content = menu.closest('[data-sidebar="content"]');
    observer.observe(content ?? menu);
    return () => observer.disconnect();
  }, []);
  const virtualItems = virtual.getVirtualItems();
  const visibleGroups = new Map<(typeof tree.groups)[number], typeof virtualItems>();
  for (const item of virtualItems) {
    const group = tree.byIndex[item.index];
    if (!group) continue;
    const items = visibleGroups.get(group) ?? [];
    items.push(item);
    visibleGroups.set(group, items);
  }
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
        return false;
      }
      setEditing(null);
      projectsChanged();
      await router.invalidate();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <KitSidebar
      data-testid="app-sidebar"
      variant="sidebar"
      collapsible={mobile ? 'none' : 'offcanvas'}
      rail={!mobile}
      railProps={railProps}
      bordered={!mobile}
      style={mobile ? { width: '100%' } : undefined}
      className="h-full min-h-0"
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/" aria-label={studio('nav')} />}>
              <WorkspaceTile>c</WorkspaceTile>
              <span className="truncate text-foreground">Corral</span>
            </SidebarMenuButton>
            <SidebarMenuActions>
              <Tooltip content={tw('newSession')} shortcut={shortcutLabel('session.new')}>
                <SidebarMenuAction
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
                </SidebarMenuAction>
              </Tooltip>
              <Tooltip content={tw('collapseSidebar')} shortcut={shortcutLabel('view.sidebar')}>
                <SidebarMenuAction
                  aria-label={tw('collapseSidebar')}
                  onClick={() => changePreferences({ sidebarOpen: false })}
                >
                  <PanelLeft />
                </SidebarMenuAction>
              </Tooltip>
            </SidebarMenuActions>
          </SidebarMenuItem>
        </SidebarMenu>
        <div data-testid="session-search-field" className="relative">
          <SidebarSearchField
            type="search"
            shortcut={null}
            aria-label={tw('searchSessions')}
            placeholder={tw('searchSessions')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (mode === 'server' && e.key === 'Enter' && !e.nativeEvent.isComposing)
                setSearchOpen(true);
            }}
          />
          {mode === 'server' ? (
            <Tooltip content={searchText('title')}>
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={searchText('title')}
                className="absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => setSearchOpen(true)}
              >
                <TextSearch />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </SidebarHeader>
      {mode === 'server' ? (
        <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} initialQuery={query} />
      ) : null}
      {model.error ? (
        <p role="alert" className="px-4 py-1 text-xs text-danger">
          {model.error}
        </p>
      ) : null}
      <nav aria-label={tw('sidebar')} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent
          ref={(node) => {
            scroll.current =
              node?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? node;
          }}
        >
          <SidebarGroup>
            <SidebarGroupLabel>{tw('sidebarNavigation')}</SidebarGroupLabel>
            <SidebarMenu>
              {model.inbox > 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    icon={Inbox}
                    render={
                      <Link to="/projects/$projectId" params={{ projectId: model.current }} />
                    }
                  >
                    {tw('needsYou', { count: model.inbox })}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={Clock3}
                  isActive={path === '/schedules'}
                  render={<Link to="/schedules" />}
                >
                  {t('schedules')}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={Folder}
                  isActive={path === '/projects'}
                  render={<Link to="/projects" />}
                >
                  {tw('allProjects')}
                </SidebarMenuButton>
                <Tooltip content={t('newProject')}>
                  <SidebarMenuAction aria-label={t('newProject')} render={<Link to="/projects" />}>
                    <FolderPlus />
                  </SidebarMenuAction>
                </Tooltip>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>{tw('sidebarProjects')}</SidebarGroupLabel>
            {/* Whole-list navigation must include rows the virtualizer has not mounted. */}
            <SidebarMenu
              ref={list}
              style={{ height: virtual.getTotalSize() }}
              onKeyDown={(event) => {
                if (
                  event.defaultPrevented ||
                  !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
                  !(event.target instanceof HTMLElement)
                )
                  return;
                if (
                  !event.target.matches(
                    '[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]',
                  )
                ) {
                  // Native Home/End scrolling would unmount a focused virtual
                  // action before its menu can open. It is not a row command.
                  if (
                    event.target.closest('[data-sidebar="menu-action"]') &&
                    ['Home', 'End'].includes(event.key)
                  )
                    event.preventDefault();
                  return;
                }
                const current = event.target.closest<HTMLElement>('[data-sidebar-index]');
                if (!current) return;
                let index =
                  Number(current.dataset.sidebarIndex) + (event.key === 'ArrowDown' ? 1 : -1);
                if (event.key === 'Home') index = 0;
                if (event.key === 'End') index = rows.length - 1;
                const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
                while (rows[index]?.kind === 'empty') index += step;
                if (!rows[index]) return;
                event.preventDefault();
                event.stopPropagation();
                virtual.scrollToIndex(index, { align: 'auto' });
                requestAnimationFrame(() =>
                  scroll.current
                    ?.querySelector<HTMLElement>(`[data-sidebar-index="${index}"] a`)
                    ?.focus(),
                );
              }}
            >
              {[...visibleGroups].map(([group, items]) => {
                const project = group.project;
                const folded = !needle && collapsed?.[project.projectId] === true;
                return (
                  <SidebarMenuItem
                    key={project.projectId}
                    data-sidebar-index={group.index}
                    style={{ position: 'absolute', top: group.start, left: 0, width: '100%' }}
                  >
                    <SidebarMenuButton
                      icon={Folder}
                      isActive={path === `/projects/${project.projectId}`}
                      render={
                        <Link to="/projects/$projectId" params={{ projectId: project.projectId }} />
                      }
                    >
                      {projectName(project, tp('defaultName'))}
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      aria-label={t('toggleProject', {
                        name: projectName(project, tp('defaultName')),
                      })}
                      aria-expanded={!folded}
                      onClick={() => setCollapsed({ ...collapsed, [project.projectId]: !folded })}
                    >
                      <ChevronDown className={folded ? '-rotate-90' : undefined} />
                    </SidebarMenuAction>
                    <SidebarMenuSub open={!folded} style={{ height: group.size - projectHeight }}>
                      {items.map((item) => {
                        const row = rows[item.index];
                        if (!row || row.kind === 'project') return null;
                        const position = {
                          position: 'absolute' as const,
                          top: item.start - scrollMargin - group.start - projectHeight,
                          // Keep the source submenu's pl-2 content inset for
                          // absolutely positioned virtual rows.
                          left: '0.5rem',
                          right: 0,
                          height: item.size,
                        };
                        if (row.kind === 'empty')
                          return (
                            <li
                              key={item.key}
                              style={position}
                              className="px-2 text-caption text-muted-foreground"
                            >
                              {tw('noSessions')}
                            </li>
                          );
                        const session = row.session;
                        const active = path.startsWith(`/sessions/${session.sessionId}`);
                        const run = model.runs.find((r) => r.sessionId === session.sessionId);
                        const working = Boolean(run && !ENDED.has(run.status));
                        // Only what needs attention shows a dot: working, waiting for a person, or failed.
                        const flagged = run && (working || run.status === 'failed');
                        return (
                          <SidebarMenuSubItem
                            key={item.key}
                            data-sidebar-index={item.index}
                            style={position}
                          >
                            <SidebarMenuSubButton
                              isActive={active}
                              render={
                                <Link
                                  to="/sessions/$sessionId"
                                  params={{ sessionId: session.sessionId }}
                                />
                              }
                            >
                              {session.title}
                              <span className="ml-auto flex shrink-0 items-center gap-2">
                                {session.pinned ? <Pin size={12} /> : null}
                                {!flagged ? (
                                  <span className="text-2xs group-focus-within/menu-sub-item:invisible group-hover/menu-sub-item:invisible">
                                    {ago(session.updatedAt)}
                                  </span>
                                ) : null}
                              </span>
                            </SidebarMenuSubButton>
                            {flagged ? (
                              <SidebarMenuBadge>
                                <StatusDot status={run.status} label={status(run.status)} />
                              </SidebarMenuBadge>
                            ) : null}
                            <Menu>
                              <MenuTrigger
                                render={
                                  <SidebarMenuAction
                                    showOnHover
                                    aria-label={t('sessionActions', { title: session.title })}
                                  />
                                }
                              >
                                <Ellipsis />
                              </MenuTrigger>
                              <MenuPopup align="start" side="right">
                                <MenuItem onClick={() => setEditing(session)}>
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
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
          {needle &&
          !model.sessions.some((s) =>
            `${s.title}\n${s.objective}`.toLocaleLowerCase().includes(needle),
          ) ? (
            <p className="p-3 text-xs text-muted-foreground">{t('noMatches')}</p>
          ) : null}
        </SidebarContent>
      </nav>
      {error && !editing ? (
        <p role="alert" className="px-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={Settings}
              onClick={() => void navigate(settingsNavigation.link('general'))}
            >
              {t('settings')}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {mode === 'server' && live && connected ? null : (
          <Tooltip
            side="top"
            content={
              mode === 'server'
                ? live
                  ? studio('liveNoModelNote')
                  : studio('serverNote')
                : studio('demoNote')
            }
          >
            <button
              type="button"
              onClick={() =>
                live && !connected ? void navigate(settingsNavigation.link('models')) : null
              }
              className="flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-muted-foreground"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
              {mode === 'server'
                ? live
                  ? studio('liveNoModel')
                  : studio('serverShort')
                : studio('demoShort')}
            </button>
          </Tooltip>
        )}
      </SidebarFooter>
      <RenameSessionDialog
        title={editing?.title ?? null}
        busy={busy}
        error={editing ? error : null}
        onSave={(title) => (editing ? update(editing, { title }) : Promise.resolve(false))}
        onClose={() => setEditing(null)}
      />
    </KitSidebar>
  );
});
