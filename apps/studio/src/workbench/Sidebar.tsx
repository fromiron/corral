import type { InboxItemView } from '@corral/client';
import type { CorralSummary, ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { SidebarStatusCard, StatusDot } from '@corral/react';
import {
  Button,
  cn,
  fontWeights,
  Sidebar as KitSidebar,
  Menu,
  MenuGroup,
  MenuGroupLabel,
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
  SidebarWorkspaceHeader,
  Tooltip,
  useSize,
  WorkspaceTile,
} from '@corral/react/design-kit';
import {
  BookOpen,
  ChevronDown,
  Clock3,
  Ellipsis,
  Folder,
  Inbox,
  MessageCircle,
  PanelLeft,
  Pin,
  Settings,
  Sparkles,
  SquarePen,
  Users,
} from '@corral/react/icons';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type KeyboardEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { openPalette } from '../commandRegistry.ts';
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
import { openNewMeeting } from './NewMeeting.tsx';
import { useSettingsNavigation, workHref } from './navigation.ts';
import {
  inboxNotificationTargets,
  type NotificationTarget,
  notificationDestination,
} from './notifications.ts';
import { changePreferences, preferences } from './preferences.ts';
import { RenameSessionDialog } from './RenameSessionDialog.tsx';
import { watchRunList } from './runList.ts';
import {
  completedScheduleRuns,
  type ScheduledRunOutcome,
  scheduledRunOutcomes,
} from './scheduledRuns.ts';
import { needsYouCount, sessionListState, uncertainSessionTerminal } from './sessionList.ts';
import { bySidebarOrder } from './sessionOrder.ts';
import { useModelProfiles } from './useModels.ts';
import { useSessionAge } from './useSessionAge.ts';

export function useCorralSidebar() {
  const { repository, transport, workspaces, terminals } = useServices();
  const td = useTranslations('Desktop');
  const scheduledText = useTranslations('Schedules');
  const statusText = useTranslations('Status');
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => workHref(s.location.href) ?? s.location.href });
  const version = useProjectsVersion();
  const current = useCurrentProject();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [corrals, setCorrals] = useState<CorralSummary[]>([]);
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [inbox, setInbox] = useState(0);
  const [terminalAttention, setTerminalAttention] = useState<InboxItemView[]>([]);
  useEffect(() => {
    void terminals;
    setTerminalAttention([]);
  }, [terminals]);
  const [error, setError] = useState<string | null>(null);
  const [scheduledResults, setScheduledResults] = useState<ScheduledRunOutcome[]>([]);
  const scheduledSeen = useRef<{
    transport: typeof transport;
    runs: RunSummary[];
  } | null>(null);
  useEffect(() => {
    void href;
    void version;
    if (scheduledSeen.current?.transport !== transport) setScheduledResults([]);
    let seen: NotificationTarget[] | null = null;
    let runKey: string | null = null;
    let latestSessions: WorkSession[] = [];
    const watcher = watchRunList(transport, async (result, currentRead, force) => {
      try {
        if ('error' in result) throw result.error;
        const latestRuns = result.runs;
        const [items, terminalItems] = await Promise.all([
          workspaces?.inbox(current).catch(() => null) ?? Promise.resolve(null),
          terminals?.attention().catch(() => null) ?? Promise.resolve([]),
        ]);
        const nextRunKey = latestRuns
          .map((run) => `${run.runId}:${run.status}`)
          .sort()
          .join(',');
        // Full session entries are needed only after a run changes or an explicit wake-up.
        if (force || nextRunKey !== runKey) {
          const [ps, teams] = await Promise.all([repository.listProjects(), repository.list()]);
          const activeProjects = ps.filter((project) => !project.archivedAt);
          const lists = await Promise.all(
            activeProjects.map((project) => repository.listSessions(project.projectId)),
          );
          if (!currentRead()) return;
          latestSessions = lists.flat().filter((session) => !session.archivedAt);
          setProjects(activeProjects);
          setCorrals(teams);
          setSessions(latestSessions);
          runKey = nextRunKey;
        }
        if (!currentRead()) return;
        if (terminalItems) setTerminalAttention(terminalItems);
        setRuns(latestRuns);
        setError(null);
        const outcomes = scheduledRunOutcomes(latestSessions, latestRuns);
        const completed = completedScheduleRuns(
          outcomes,
          scheduledSeen.current?.transport === transport ? scheduledSeen.current.runs : null,
        );
        scheduledSeen.current = { transport, runs: latestRuns };
        if (completed.length) {
          setScheduledResults((previous) => [
            ...completed,
            ...previous.filter((run) => !completed.some((next) => next.runId === run.runId)),
          ]);
          if (preferences.getState().notify && !document.hasFocus())
            for (const run of completed)
              void desktop
                ?.notify(
                  scheduledText('resultTitle'),
                  scheduledText('result', { status: statusText(run.status) }),
                )
                .catch(() => {});
        }
        if (items) {
          setInbox(items.length);
          const added = inboxNotificationTargets(items, seen ?? items);
          seen = inboxNotificationTargets(items);
          void desktop?.badge(items.length).catch(() => {});
          if (added[0] && preferences.getState().notify && !document.hasFocus())
            void desktop
              ?.notify(td('notifyTitle'), td('notifyBody', { count: items.length }), added[0])
              .catch(() => {});
        }
      } catch (failure) {
        if (currentRead()) setError(failure instanceof Error ? failure.message : String(failure));
      }
    });
    return watcher.dispose;
  }, [
    repository,
    transport,
    workspaces,
    terminals,
    current,
    href,
    version,
    td,
    scheduledText,
    statusText,
  ]);
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
  return {
    projects,
    corrals,
    sessions,
    runs,
    inbox,
    terminalAttention,
    error,
    current,
    scheduledResults,
    dismissScheduled: (runId: string) =>
      setScheduledResults((results) => results.filter((run) => run.runId !== runId)),
  };
}

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/**
 * Row heights of the project list, per density. A session row holds its title and one line of
 * state and time, each at its type role's full line height, so neither line is clipped. The
 * virtual list positions rows by these, so the rows are drawn at exactly these heights.
 */
export function sidebarRowHeights(compact: boolean) {
  return compact
    ? { project: 28, session: 36, empty: 24 }
    : { project: 32, session: 44, empty: 28 };
}
const SESSION_ROW = { default: 'h-11', compact: 'h-9' } as const;

/** Tab or Escape out of a row menu puts focus back on that row's trigger (workbench.md). */
function returnFocusOnClose(
  event: KeyboardEvent<HTMLElement>,
  open: boolean,
  trigger: string,
  close: () => void,
) {
  if (!open || !['Tab', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const button = event.currentTarget.querySelector<HTMLElement>(trigger);
  close();
  requestAnimationFrame(() => button?.focus());
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
  const shell = useTranslations('Shell');
  const studio = useTranslations('Studio');
  const ago = useSessionAge();
  const status = useTranslations('Status');
  const profiles = useModelProfiles();
  const connected = Boolean(profiles?.some((p) => p.available));
  const { repository, mode, live } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const settingsNavigation = useSettingsNavigation();
  const [editing, setEditing] = useState<WorkSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useRemembered<Record<string, boolean>>(
    'corral:sidebar-collapsed:v1',
    {},
  );
  const scroll = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const size = useSize();
  const compact = size.variant === 'compact';
  const heights = useMemo(() => sidebarRowHeights(compact), [compact]);
  const projectHeight = heights.project;
  const waiting = useMemo(
    () => needsYouCount(model.sessions, model.runs, model.terminalAttention),
    [model.sessions, model.runs, model.terminalAttention],
  );
  const rows = useMemo(() => {
    const result: (
      | { kind: 'project'; project: ProjectSummary }
      | { kind: 'session'; session: WorkSession }
      | { kind: 'empty'; id: string }
    )[] = [];
    const groups = new Map<string, WorkSession[]>();
    for (const session of model.sessions) {
      const group = groups.get(session.projectId) ?? [];
      group.push(session);
      groups.set(session.projectId, group);
    }
    for (const project of model.projects) {
      const sessions = groups.get(project.projectId) ?? [];
      result.push({ kind: 'project', project });
      if (collapsed?.[project.projectId] === true) continue;
      sessions.sort(bySidebarOrder);
      for (const session of sessions) result.push({ kind: 'session', session });
      if (!sessions.length) result.push({ kind: 'empty', id: project.projectId });
    }
    return result;
  }, [model.projects, model.sessions, collapsed]);
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
      const height = heights[row.kind];
      group.size += height;
      byIndex[index] = group;
      offset += height;
    }
    return { groups, byIndex };
  }, [rows, heights]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => heights[rows[index]?.kind ?? 'session'],
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
    // The primary menu and project label share this scroller. Their measured
    // height is the virtual list's origin, not another scroll surface.
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
  // A density change resizes every row: the virtual list lays them out again.
  const laidOut = useRef(heights);
  useLayoutEffect(() => {
    if (laidOut.current === heights) return;
    laidOut.current = heights;
    virtual.measure();
  }, [heights, virtual]);
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
  const mountedRows = virtual.getVirtualItems();
  const sessionTabIndex = mountedRows.some((row) => row.index === activeIndex)
    ? activeIndex
    : mountedRows.find((row) => rows[row.index]?.kind === 'session')?.index;
  // Navigation brings the selected session into view; background data changes do not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only intentional navigation scrolls the sidebar
  useLayoutEffect(() => {
    if (hasActive) virtual.scrollToIndex(activeIndex, { align: 'auto' });
  }, [path, hasActive, virtual]);

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

  // One reading of whether requests reach a real model: the header names it, and the footer
  // card explains it while they cannot.
  const blocked = mode === 'server' && live;
  const connection =
    mode !== 'server'
      ? studio('demoShort')
      : !live
        ? studio('serverShort')
        : connected
          ? shell('connected')
          : shell('noModel');
  // One word for the header, shown only while the whole word fits.
  const connectionWord =
    mode !== 'server'
      ? shell('stateDemo')
      : !live
        ? shell('stateSimulated')
        : connected
          ? shell('connected')
          : shell('stateNoModel');
  const connectionDot = blocked ? (connected ? 'bg-success' : 'bg-warning') : 'bg-muted-foreground';
  const statusCard =
    blocked && connected ? null : (
      <SidebarStatusCard
        data-testid="sidebar-status"
        marker={
          blocked ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
          ) : null
        }
        title={connection}
        action={
          live && !connected ? (
            <Button
              variant="ghost"
              size="compact"
              className="justify-start px-0"
              onClick={() => void navigate(settingsNavigation.link('models'))}
            >
              {studio('liveNoModel')}
            </Button>
          ) : null
        }
      >
        {blocked ? shell('noModelBody') : shell('simulatedBody')}
      </SidebarStatusCard>
    );

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
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <Tooltip content={connection} side="right">
              <div>
                <SidebarWorkspaceHeader
                  name={
                    // The state word wraps out of the one-line row, whole, when there is no room
                    // for it: the name is never cut mid-word. The dot on the tile always says it.
                    <span className="flex h-5 flex-wrap gap-x-1.5 overflow-hidden">
                      <span>Corral</span>
                      <span
                        data-testid="sidebar-connection"
                        className="whitespace-nowrap text-muted-foreground"
                        style={{ fontVariationSettings: fontWeights.normal }}
                      >
                        {connectionWord}
                      </span>
                    </span>
                  }
                  tile={
                    <span className="relative flex">
                      <WorkspaceTile>c</WorkspaceTile>
                      <span
                        className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar ${connectionDot}`}
                      />
                    </span>
                  }
                  labels={{
                    menu: shell('workspace'),
                    switchWorkspace: shell('workspaceMenuState', { state: connection }),
                    toggleSidebar: tw('expandSidebar'),
                  }}
                  menu={
                    <MenuGroup>
                      {/* The full state leads the menu as a line, not a choice. */}
                      <MenuGroupLabel className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`size-2 shrink-0 rounded-full ${connectionDot}`}
                        />
                        {connection}
                      </MenuGroupLabel>
                      <MenuItem index={0} onClick={() => void navigate({ to: '/projects' })}>
                        {shell('allProjects')}
                      </MenuItem>
                      {/* The projects page focuses its new-project form for this hash. */}
                      <MenuItem
                        index={1}
                        onClick={() => void navigate({ to: '/projects', hash: 'new-project' })}
                      >
                        {shell('newProject')}
                      </MenuItem>
                    </MenuGroup>
                  }
                />
              </div>
            </Tooltip>
          </div>
          <Tooltip content={tw('collapseSidebar')} shortcut={shortcutLabel('view.sidebar')}>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={tw('collapseSidebar')}
              onClick={() => changePreferences({ sidebarOpen: false })}
            >
              <PanelLeft />
            </Button>
          </Tooltip>
        </div>
        <div data-testid="session-search-field">
          {/* A doorway to the palette: it never holds text of its own. */}
          <SidebarSearchField
            readOnly
            shortcut={null}
            aria-label={shell('searchSessions')}
            aria-haspopup="dialog"
            placeholder={shell('search')}
            onClick={() => openPalette({ mode: 'sessions', query: '' })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const printable =
                event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
              const ime = event.key === 'Process' || event.keyCode === 229;
              if (!printable && !ime && event.key !== 'Enter') return;
              event.preventDefault();
              openPalette({ mode: 'sessions', query: printable ? event.key.trim() : '' });
            }}
          />
        </div>
      </SidebarHeader>
      {model.error ? (
        <p role="alert" className="px-4 py-1 text-xs text-danger">
          {model.error}
        </p>
      ) : null}
      <nav aria-label={tw('sidebar')} className="flex min-h-0 flex-1 flex-col">
        <p id="session-list-keys" className="sr-only">
          {ts('keyboardHint')}
        </p>
        <SidebarContent
          ref={(node) => {
            scroll.current =
              node?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? node;
          }}
        >
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <Tooltip content={shell('newConversation')} shortcut={shortcutLabel('session.new')}>
                  <SidebarMenuButton
                    icon={SquarePen}
                    render={
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: model.current }}
                        search={{ newSession: true }}
                      />
                    }
                  >
                    {shell('newConversation')}
                  </SidebarMenuButton>
                </Tooltip>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={Inbox}
                  isActive={path === '/inbox'}
                  aria-description={
                    waiting ? shell('needsYouCount', { count: waiting }) : undefined
                  }
                  render={<Link to="/inbox" />}
                >
                  {shell('needsYou')}
                </SidebarMenuButton>
                {waiting > 0 ? (
                  <SidebarMenuBadge aria-hidden="true">{waiting}</SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={BookOpen}
                  isActive={path === '/library' || path.startsWith('/library/')}
                  render={<Link to="/library/teams" />}
                >
                  {shell('library')}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={Clock3}
                  isActive={path === '/schedules'}
                  render={<Link to="/schedules" />}
                >
                  {shell('automation')}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
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
                const name = projectName(project, tp('defaultName'));
                const folded = collapsed?.[project.projectId] === true;
                const projectActive = path === `/projects/${project.projectId}`;
                const projectMenu = `project:${project.projectId}`;
                return (
                  <SidebarMenuItem
                    key={project.projectId}
                    data-sidebar-index={group.index}
                    style={{ position: 'absolute', top: group.start, left: 0, width: '100%' }}
                    onKeyDownCapture={(event) =>
                      returnFocusOnClose(
                        event,
                        openMenu === projectMenu,
                        '[data-project-menu]',
                        () => setOpenMenu(null),
                      )
                    }
                  >
                    <SidebarMenuButton
                      icon={Folder}
                      isActive={projectActive}
                      render={
                        <Link to="/projects/$projectId" params={{ projectId: project.projectId }} />
                      }
                    >
                      {name}
                    </SidebarMenuButton>
                    <SidebarMenuActions showOnHover={!projectActive}>
                      <Menu
                        open={openMenu === projectMenu}
                        onOpenChange={(open) => setOpenMenu(open ? projectMenu : null)}
                      >
                        <Tooltip content={shell('projectActions', { name })}>
                          <MenuTrigger
                            render={
                              <SidebarMenuAction
                                data-project-menu
                                aria-label={shell('projectActions', { name })}
                              />
                            }
                          >
                            <Ellipsis />
                          </MenuTrigger>
                        </Tooltip>
                        <MenuPopup align="start" side="right">
                          <MenuItem onClick={() => openNewMeeting(project.projectId)}>
                            {shell('newMeeting')}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                      <Tooltip content={t('toggleProject', { name })}>
                        <SidebarMenuAction
                          aria-label={t('toggleProject', { name })}
                          aria-expanded={!folded}
                          onClick={() =>
                            setCollapsed({ ...collapsed, [project.projectId]: !folded })
                          }
                        >
                          <ChevronDown className={folded ? '-rotate-90' : undefined} />
                        </SidebarMenuAction>
                      </Tooltip>
                    </SidebarMenuActions>
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
                              className={cn(
                                size.type.caption,
                                'flex items-center px-2 text-muted-foreground',
                              )}
                            >
                              {tw('noSessions')}
                            </li>
                          );
                        const session = row.session;
                        const active = path.startsWith(`/sessions/${session.sessionId}`);
                        const run = model.runs
                          .filter((r) => r.sessionId === session.sessionId)
                          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
                        const working = Boolean(run && !ENDED.has(run.status));
                        const terminal = uncertainSessionTerminal(
                          session.sessionId,
                          model.terminalAttention,
                        );
                        const state = sessionListState(
                          session,
                          model.runs,
                          model.terminalAttention,
                        );
                        return (
                          <SidebarMenuSubItem
                            key={item.key}
                            data-sidebar-index={item.index}
                            data-session-kind={session.meeting ? 'meeting' : 'session'}
                            style={position}
                            onKeyDownCapture={(event) =>
                              returnFocusOnClose(
                                event,
                                openMenu === session.sessionId,
                                '[data-session-menu]',
                                () => setOpenMenu(null),
                              )
                            }
                          >
                            <SidebarMenuSubButton
                              tabIndex={item.index === sessionTabIndex ? 0 : -1}
                              aria-describedby="session-list-keys"
                              isActive={active}
                              // Two full lines: the icon sits on the title's line.
                              className={cn(
                                SESSION_ROW[size.variant],
                                'items-start py-1 [&>svg]:mt-0.5',
                              )}
                              icon={session.meeting ? Users : MessageCircle}
                              render={
                                <Link
                                  to="/sessions/$sessionId"
                                  params={{ sessionId: session.sessionId }}
                                  search={
                                    terminal ? { panel: 'terminal', terminal } : { compose: true }
                                  }
                                />
                              }
                            >
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span
                                  data-session-line="title"
                                  className={cn(size.type.body, 'truncate')}
                                  style={{
                                    fontVariationSettings: active
                                      ? fontWeights.semibold
                                      : fontWeights.normal,
                                  }}
                                >
                                  {session.title}
                                </span>
                                <span
                                  data-session-line="state"
                                  className={cn(
                                    size.type.caption,
                                    'truncate text-muted-foreground',
                                  )}
                                >
                                  {/* The state's colour leads its word; the row needs no badge. */}
                                  {run || terminal ? (
                                    <span className="mr-1.5 inline-flex align-middle">
                                      <StatusDot
                                        status={terminal ? 'awaiting_user' : (run?.status ?? '')}
                                      />
                                    </span>
                                  ) : null}
                                  {terminal ? `${ts('terminalNeedsAttention')} · ` : null}
                                  {run
                                    ? `${status(run.status)} · `
                                    : terminal
                                      ? null
                                      : `${ts(`listState.${state}`)} · `}
                                  {ago(session.updatedAt)}
                                </span>
                              </span>
                              {session.pinned ? (
                                <Pin size={12} className="mt-1 shrink-0 text-muted-foreground" />
                              ) : null}
                            </SidebarMenuSubButton>
                            <Menu
                              open={openMenu === session.sessionId}
                              onOpenChange={(open) => setOpenMenu(open ? session.sessionId : null)}
                            >
                              <Tooltip content={t('sessionActions', { title: session.title })}>
                                <MenuTrigger
                                  render={
                                    <SidebarMenuAction
                                      // The open conversation keeps its menu in view.
                                      showOnHover={!active}
                                      className="top-1/2 -translate-y-1/2"
                                      data-session-menu
                                      aria-label={t('sessionActions', { title: session.title })}
                                    />
                                  }
                                >
                                  <Ellipsis />
                                </MenuTrigger>
                              </Tooltip>
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
        </SidebarContent>
      </nav>
      {error && !editing ? (
        <p role="alert" className="px-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <SidebarFooter>
        {statusCard}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={Sparkles}
              isActive={path === '/preview' || path.startsWith('/preview/')}
              render={<Link to="/preview" />}
            >
              {shell('featurePreviews')}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={Settings}
              onClick={() => void navigate(settingsNavigation.link('general'))}
            >
              {t('settings')}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
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
