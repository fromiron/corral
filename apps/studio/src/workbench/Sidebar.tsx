import type { InboxItemView } from '@corral/client';
import type { CorralSummary, ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { CorralSymbol, CorralWordmark, sessionGroupOf, usePresenceWord } from '@corral/react';
import {
  Button,
  cn,
  fontWeights,
  Sidebar as KitSidebar,
  Menu,
  MenuGroup,
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
import { PresenceMark } from './PresenceMark.tsx';
import { changePreferences, preferences } from './preferences.ts';
import { RenameSessionDialog } from './RenameSessionDialog.tsx';
import { watchRunList } from './runList.ts';
import { SessionDeletionDialog } from './SessionDeletionDialog.tsx';
import {
  completedScheduleRuns,
  type ScheduledRunOutcome,
  scheduledRunOutcomes,
} from './scheduledRuns.ts';
import {
  needsYouCount,
  sessionLiveStates,
  sessionRunOpen,
  uncertainSessionTerminal,
} from './sessionList.ts';
import { bySidebarOrder } from './sessionOrder.ts';
import { useModelProfiles } from './useModels.ts';
import { useSessionAge } from './useSessionAge.ts';
import { useSettledPresence } from './useSettledPresence.ts';

export function useCorralSidebar() {
  const { repository, transport, workspaces, terminals } = useServices();
  const td = useTranslations('Desktop');
  const scheduledText = useTranslations('Schedules');
  const statusText = usePresenceWord();
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

/**
 * Row heights of the project list, per density. A session row holds its title and one line of
 * state and time, each at its type role's full line height, so neither line is clipped. The
 * virtual list estimates rows by these and draws session rows at exactly these heights. Every
 * project row uses one measured button height when that reading is non-zero.
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
  const profiles = useModelProfiles();
  const connected = Boolean(profiles?.some((p) => p.available));
  const { repository, mode, live, sessionDeletion } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const settingsNavigation = useSettingsNavigation();
  const [editing, setEditing] = useState<WorkSession | null>(null);
  const [deleting, setDeleting] = useState<WorkSession | null>(null);
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
  const [projectHeight, setProjectHeight] = useState<number | undefined>(undefined);
  const waiting = useMemo(
    () => needsYouCount(model.sessions, model.runs, model.terminalAttention),
    [model.sessions, model.runs, model.terminalAttention],
  );
  // Rows read the held state (exit grace); the badge above and archiving read the live one.
  const livePresence = useMemo(
    () => sessionLiveStates(model.sessions, model.runs),
    [model.sessions, model.runs],
  );
  const shownPresence = useSettledPresence(livePresence);
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
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.kind === 'project') return projectHeight ?? heights.project;
      return heights[row?.kind ?? 'session'];
    },
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
  const renderedRows = virtualItems.map((item) => item.index).join(',');
  // A zero height is ignored.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read after the density class commits and when rendered rows change
  useLayoutEffect(() => {
    const menu = list.current;
    if (!menu) return;
    const projectButton = () =>
      menu.querySelector<HTMLElement>(
        ':scope > [data-sidebar="menu-item"] > [data-sidebar="menu-button"]',
      );
    const read = () => {
      const height = projectButton()?.offsetHeight ?? 0;
      if (height > 0) setProjectHeight((current) => (current === height ? current : height));
    };
    read();
    const button = projectButton();
    if (!button) return;
    const observer = new ResizeObserver(read);
    observer.observe(button);
    return () => observer.disconnect();
  }, [renderedRows, heights]);
  // estimateSize is not a measurement dependency, so a new project height has
  // to drop the cached estimate explicitly.
  const measuredProject = useRef(projectHeight);
  useLayoutEffect(() => {
    if (measuredProject.current === projectHeight) return;
    measuredProject.current = projectHeight;
    virtual.measure();
  }, [projectHeight, virtual]);
  const measurements = virtual.measurementsCache;
  const tree = useMemo(() => {
    const groups: {
      project: ProjectSummary;
      index: number;
      start: number;
      size: number;
      projectSize: number;
    }[] = [];
    const byIndex: typeof groups = [];
    const useMeasured = measurements.length === rows.length;
    let offset = 0;
    for (const [index, row] of rows.entries()) {
      if (row.kind === 'project')
        groups.push({ project: row.project, index, start: 0, size: 0, projectSize: 0 });
      const group = groups.at(-1);
      if (!group) continue;
      const measured = useMeasured ? measurements[index] : undefined;
      const size = measured?.size ?? heights[row.kind];
      if (row.kind === 'project') {
        group.projectSize = size;
        group.start = measured ? measured.start - scrollMargin : offset;
      }
      group.size += size;
      byIndex[index] = group;
      offset += size;
    }
    return { groups, byIndex };
  }, [rows, heights, scrollMargin, measurements]);
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
  const sessionTabIndex = virtualItems.some((row) => row.index === activeIndex)
    ? activeIndex
    : virtualItems.find((row) => rows[row.index]?.kind === 'session')?.index;
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

  // One reading of whether requests reach a real model, said once: the header's word, which
  // only no model, the demo and simulation have; a normal connection shows none. The full form
  // is only the Corral menu's accessible name.
  const noModel = mode === 'server' && live && !connected;
  const connection =
    mode !== 'server'
      ? studio('demoShort')
      : !live
        ? studio('serverShort')
        : connected
          ? shell('connected')
          : shell('noModel');
  const connectionWord =
    mode !== 'server'
      ? shell('stateDemo')
      : !live
        ? shell('stateSimulated')
        : connected
          ? null
          : shell('stateNoModel');
  // The word always shows whole: the name before it is what gives way in a narrow sidebar.
  const word = 'shrink-0 whitespace-nowrap text-muted-foreground';
  const newShortcut = shortcutLabel('session.new');
  const newConversation = (
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
  );

  return (
    <KitSidebar
      data-testid="app-sidebar"
      variant="inset"
      collapsible={mobile ? 'none' : 'offcanvas'}
      rail={!mobile}
      railProps={railProps}
      style={mobile ? { width: '100%' } : undefined}
      className="h-full min-h-0"
    >
      <SidebarHeader>
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <SidebarWorkspaceHeader
              name={
                <span className="flex min-w-0 items-center gap-x-1.5">
                  {/* The wordmark is the picture of the name; the text is what is read. */}
                  <span aria-hidden="true" className="flex shrink-0">
                    <CorralWordmark className="h-3.5 w-auto" />
                  </span>
                  <span className="sr-only">Corral</span>
                  {noModel || !connectionWord ? null : (
                    <span
                      data-testid="sidebar-connection"
                      className={word}
                      style={{ fontVariationSettings: fontWeights.normal }}
                    >
                      {connectionWord}
                    </span>
                  )}
                </span>
              }
              tile={<CorralSymbol className="block h-5 w-auto text-foreground" />}
              labels={{
                menu: shell('workspace'),
                switchWorkspace: shell('workspaceMenuState', { state: connection }),
                toggleSidebar: tw('expandSidebar'),
              }}
              menu={
                <MenuGroup>
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
          {noModel ? (
            // Without a model the word is the way to connect one: beside the menu, not in it.
            <Button
              data-testid="sidebar-connection"
              variant="ghost"
              size="compact"
              aria-label={shell('openModelSettings')}
              className="shrink-0 px-1.5"
              onClick={() => void navigate(settingsNavigation.link('models'))}
            >
              <span className={word} style={{ fontVariationSettings: fontWeights.normal }}>
                {connectionWord}
              </span>
            </Button>
          ) : null}
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
        <p role="alert" className="px-4 py-1 text-caption text-danger">
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
                {newShortcut ? (
                  // The row already says what it does; its tooltip adds only the shortcut.
                  <Tooltip content={null} shortcut={newShortcut}>
                    {newConversation}
                  </Tooltip>
                ) : (
                  newConversation
                )}
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
                    <SidebarMenuSub
                      // Turn the guide into the last row's title line, or the empty line.
                      elbow
                      open={!folded}
                      style={{ height: group.size - group.projectSize }}
                    >
                      {items.map((item) => {
                        const row = rows[item.index];
                        if (!row || row.kind === 'project') return null;
                        const position = {
                          position: 'absolute' as const,
                          top: item.start - scrollMargin - group.start - group.projectSize,
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
                              <span data-sidebar-guide-line="">{tw('noSessions')}</span>
                            </li>
                          );
                        const session = row.session;
                        const active = path.startsWith(`/sessions/${session.sessionId}`);
                        const live = livePresence.get(session.sessionId)?.presence;
                        const presence = shownPresence.get(session.sessionId) ?? live;
                        const working = Boolean(live && sessionRunOpen(live));
                        const terminal = uncertainSessionTerminal(
                          session.sessionId,
                          model.terminalAttention,
                        );
                        return (
                          <SidebarMenuSubItem
                            key={item.key}
                            data-sidebar-index={item.index}
                            data-session-row={session.sessionId}
                            data-session-group={
                              presence ? sessionGroupOf(presence, Boolean(terminal)) : undefined
                            }
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
                                  data-sidebar-guide-line=""
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
                                  {/* The state is the kit mark and its name, never words: the
                                      body says it (docs/specs/features/presence.md). The slot
                                      stays without a mark, so the time never moves. */}
                                  <span className="mr-1.5 inline-flex align-middle">
                                    <PresenceMark presence={presence} />
                                  </span>
                                  {terminal ? `${ts('terminalNeedsAttention')} · ` : null}
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
                                {sessionDeletion ? (
                                  <MenuItem disabled={busy} onClick={() => setDeleting(session)}>
                                    {ts('delete')}
                                  </MenuItem>
                                ) : null}
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
        <p role="alert" className="px-3 text-caption text-danger">
          {error}
        </p>
      ) : null}
      <SidebarFooter>
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
      {deleting ? (
        <SessionDeletionDialog
          open
          sessionId={deleting.sessionId}
          projectId={deleting.projectId}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const gone = deleting;
            setDeleting(null);
            projectsChanged();
            void router.invalidate();
            if (path.startsWith(`/sessions/${gone.sessionId}`))
              void navigate({
                to: '/projects/$projectId',
                params: { projectId: gone.projectId },
              });
          }}
        />
      ) : null}
    </KitSidebar>
  );
});
