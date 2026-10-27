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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSearchField,
  Tooltip,
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
import { sessionListState } from './sessionList.ts';
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
}: {
  model: ReturnType<typeof useCorralSidebar>;
}) {
  useShortcutBindings();
  const t = useTranslations('Desktop');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('Projects');
  const ts = useTranslations('Sessions');
  const studio = useTranslations('Studio');
  const status = useTranslations('Status');
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
  const [openMenu, setOpenMenu] = useState<string | null>(null);
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
  const mountedRows = virtual.getVirtualItems();
  const sessionTabIndex = mountedRows.some((row) => row.index === activeIndex)
    ? activeIndex
    : mountedRows.find((row) => rows[row.index]?.kind === 'session')?.index;
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
    <SidebarProvider
      persist={false}
      shortcut={null}
      mobileBreakpoint={0}
      width="100%"
      className="h-full min-h-0"
    >
      <KitSidebar
        data-testid="app-sidebar"
        collapsible="none"
        rail={false}
        bordered={false}
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
          <p className="px-2 text-caption text-muted-foreground">{searchText('sidebarScope')}</p>
        </SidebarHeader>
        {mode === 'server' ? (
          <SessionSearchDialog
            open={searchOpen}
            onOpenChange={setSearchOpen}
            initialQuery={query}
          />
        ) : null}
        <SidebarGroup className="pt-0">
          <SidebarMenu>
            {model.inbox > 0 ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={Inbox}
                  render={<Link to="/projects/$projectId" params={{ projectId: model.current }} />}
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
        {model.error ? (
          <p role="alert" className="px-4 py-1 text-xs text-danger">
            {model.error}
          </p>
        ) : null}
        <nav aria-label={tw('sidebar')} className="flex min-h-0 flex-1 flex-col">
          <p id="session-list-keys" className="px-4 pb-1 text-caption text-muted-foreground">
            {ts('keyboardHint')}
          </p>
          <SidebarContent
            ref={(node) => {
              scroll.current =
                node?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
            }}
          >
            <SidebarGroup className="pt-0">
              {/* Whole-list navigation must include rows the virtualizer has not mounted. */}
              <SidebarMenu
                style={{ height: virtual.getTotalSize() }}
                onKeyDown={(event) => {
                  if (
                    !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
                    !(event.target instanceof HTMLElement)
                  )
                    return;
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
                  virtual.scrollToIndex(index, { align: 'auto' });
                  requestAnimationFrame(() =>
                    scroll.current
                      ?.querySelector<HTMLElement>(`[data-sidebar-index="${index}"] a`)
                      ?.focus(),
                  );
                }}
              >
                {mountedRows.map((item) => {
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
                      <li
                        key={item.key}
                        style={position}
                        className="px-8 py-2 text-xs text-muted-foreground"
                      >
                        {tw('noSessions')}
                      </li>
                    );
                  if (row.kind === 'project') {
                    const project = row.project;
                    const folded = !needle && collapsed?.[project.projectId] === true;
                    return (
                      <SidebarMenuItem
                        key={item.key}
                        data-sidebar-index={item.index}
                        style={position}
                        className="py-px"
                      >
                        <SidebarMenuButton
                          icon={Folder}
                          isActive={path === `/projects/${project.projectId}`}
                          render={
                            <Link
                              to="/projects/$projectId"
                              params={{ projectId: project.projectId }}
                            />
                          }
                        >
                          {projectName(project, tp('defaultName'))}
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          aria-label={t('toggleProject', {
                            name: projectName(project, tp('defaultName')),
                          })}
                          aria-expanded={!folded}
                          onClick={() =>
                            setCollapsed({ ...collapsed, [project.projectId]: !folded })
                          }
                        >
                          <ChevronDown className={folded ? '-rotate-90' : undefined} />
                        </SidebarMenuAction>
                      </SidebarMenuItem>
                    );
                  }
                  const session = row.session;
                  const active = path.startsWith(`/sessions/${session.sessionId}`);
                  const run = model.runs
                    .filter((r) => r.sessionId === session.sessionId)
                    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
                  const working = Boolean(run && !ENDED.has(run.status));
                  const state = sessionListState(session, model.runs);
                  return (
                    <SidebarMenuItem
                      key={item.key}
                      data-sidebar-index={item.index}
                      style={position}
                      className="py-px"
                      onKeyDownCapture={(event) => {
                        if (
                          openMenu !== session.sessionId ||
                          !['Tab', 'Escape'].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        const trigger =
                          event.currentTarget.querySelector<HTMLElement>('[data-session-menu]');
                        setOpenMenu(null);
                        requestAnimationFrame(() => trigger?.focus());
                      }}
                    >
                      <SidebarMenuButton
                        tabIndex={item.index === sessionTabIndex ? 0 : -1}
                        aria-describedby="session-list-keys"
                        isActive={active}
                        className="pl-8"
                        render={
                          <Link
                            to="/sessions/$sessionId"
                            params={{ sessionId: session.sessionId }}
                          />
                        }
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate leading-3.5">{session.title}</span>
                          <span className="truncate text-micro leading-3 text-muted-foreground">
                            {ts(`listState.${state}`)} · {ago(session.updatedAt)}
                          </span>
                        </span>
                        {session.pinned ? <Pin size={12} /> : null}
                      </SidebarMenuButton>
                      {run ? (
                        <SidebarMenuBadge>
                          <StatusDot status={run.status} label={status(run.status)} />
                        </SidebarMenuBadge>
                      ) : null}
                      <Menu
                        open={openMenu === session.sessionId}
                        onOpenChange={(open) => setOpenMenu(open ? session.sessionId : null)}
                      >
                        <MenuTrigger
                          render={
                            <SidebarMenuAction
                              showOnHover
                              data-session-menu
                              aria-label={t('sessionActions', { title: session.title })}
                            />
                          }
                        >
                          <Ellipsis />
                        </MenuTrigger>
                        <MenuPopup align="start" side="right">
                          <MenuItem onClick={() => setEditing(session)}>{t('rename')}</MenuItem>
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
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
            {needle &&
            !model.sessions.some((s) =>
              `${s.title}\n${s.objective}`.toLocaleLowerCase().includes(needle),
            ) ? (
              <div className="p-3 text-xs text-muted-foreground">
                <p>{t('noMatches')}</p>
                {mode === 'server' ? (
                  <Button variant="ghost" size="compact" onClick={() => setSearchOpen(true)}>
                    {searchText('searchBody')}
                  </Button>
                ) : null}
              </div>
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
    </SidebarProvider>
  );
});
