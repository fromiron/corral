import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { Button, fontWeights, Kbd } from '@corral/react/design-kit';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  type AppCommand,
  harnessCommands,
  OPEN_PALETTE,
  type PaletteRequest,
  runShortcut,
  useRegisterCommands,
  useRegisteredCommands,
} from './commandRegistry.ts';
import { rankCommands } from './commands.ts';
import { desktop } from './desktop.tsx';
import { currentProject, projectName } from './projects.ts';
import { useServices } from './services.tsx';
import {
  bindingError,
  readShortcutBindings,
  useShortcutBindings,
  writeShortcutBindings,
} from './shortcutBindings.ts';
import {
  effectiveShortcuts,
  LOCAL_KEYS,
  SHORTCUTS,
  type ShortcutId,
  shortcutFor,
  shortcutLabel,
} from './shortcuts.ts';
import { createFromTemplate, useTemplateText, WORKSPACE_TEMPLATES } from './templates.ts';
import { openNewMeeting } from './workbench/NewMeeting.tsx';
import {
  SETTINGS_GROUPS,
  settingsInteractionBlocked,
  useSettingsNavigation,
} from './workbench/navigation.ts';
import { usePreferences } from './workbench/preferences.ts';
import { loadRunIdentities, runIdentity, runIdentityText } from './workbench/runIdentity.ts';
import { SessionSearchDialog } from './workbench/SessionSearchDialog.tsx';
import { useSettingsSectionLabel } from './workbench/SettingsNavigation.tsx';
import { bySidebarOrder } from './workbench/sessionOrder.ts';

/** True while the user types in a field or composes with an IME: global keys stay quiet. */
function typing(event: globalThis.KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  const target = event.target as HTMLElement | null;
  return Boolean(
    target &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)),
  );
}

/** Where session search looks: the sidebar's own lists, so the palette reads nothing twice. */
interface SessionSource {
  sessions?: readonly WorkSession[];
  projects?: readonly ProjectSummary[];
  /** The project of the open screen; undefined outside any project. */
  projectId?: string | undefined;
}
const NO_SESSIONS: readonly WorkSession[] = [];
const NO_PROJECTS: readonly ProjectSummary[] = [];

/**
 * ⌘K / Ctrl+K command palette and ? shortcut help for the whole Studio (roadmap UX-A5).
 * Modal, keyboard first, IME safe; focus returns where it was on close.
 */
export function CommandLayer({
  sessions,
  projects,
  projectId,
  fallbackFocus,
}: SessionSource & {
  /** Where focus returns when the opener has gone, as the narrow sidebar's field does. */
  fallbackFocus?: RefObject<HTMLElement | null>;
} = {}) {
  const bindings = useShortcutBindings();
  const [palette, setPalette] = useState<PaletteRequest | null>(null);
  const [help, setHelp] = useState(false);
  const [sessionSearch, setSessionSearch] = useState<string | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const open = useCallback((which: 'palette' | 'help', request: PaletteRequest = {}) => {
    returnTo.current = document.activeElement as HTMLElement | null;
    if (which === 'palette') setPalette(request);
    else setHelp(true);
  }, []);
  const restoreFocus = useCallback(() => {
    const target = returnTo.current;
    queueMicrotask(() => (target?.isConnected ? target : fallbackFocus?.current)?.focus());
  }, [fallbackFocus]);
  const close = useCallback(() => {
    setPalette(null);
    setHelp(false);
    restoreFocus();
  }, [restoreFocus]);
  useEffect(() => {
    const show = (event: Event) => {
      if (!settingsInteractionBlocked())
        open('palette', (event as CustomEvent<PaletteRequest | null>).detail ?? {});
    };
    const search = (event: Event) => {
      if (settingsInteractionBlocked()) return;
      setPalette(null);
      setSessionSearch((event as CustomEvent<string>).detail ?? '');
    };
    window.addEventListener('corral:search-sessions', search);
    window.addEventListener(OPEN_PALETTE, show);
    return () => {
      window.removeEventListener(OPEN_PALETTE, show);
      window.removeEventListener('corral:search-sessions', search);
    };
  }, [open]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (settingsInteractionBlocked()) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (help && event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      const hit = shortcutFor(event);
      if (
        typing(event) &&
        !['palette', 'help', 'composer.focus', 'run.stop'].includes(hit?.id ?? '')
      )
        return;
      if (hit?.id === 'palette') {
        event.preventDefault();
        if (palette) close();
        else open('palette');
      } else if (hit?.id === 'help' || (event.key === '?' && !typing(event))) {
        if (palette || help) return;
        event.preventDefault();
        open('help');
      } else if (hit && !palette && !help && runShortcut(hit.id, hit.digit)) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, help, open, close]);
  useGlobalCommands(() => open('help'));
  useEffect(() => {
    const sync = () => {
      const field = document.activeElement as HTMLElement | null;
      const capturing = document.querySelector('[data-shortcut-capture="true"]');
      const editing =
        field?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(field?.tagName ?? '');
      const map = Object.fromEntries(
        Object.entries(effectiveShortcuts(bindings)).filter(
          ([id]) =>
            !settingsInteractionBlocked() &&
            !capturing &&
            (!editing || ['palette', 'help', 'composer.focus', 'run.stop'].includes(id)),
        ),
      );
      void desktop?.shortcuts(map).catch(() => {});
    };
    sync();
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    window.addEventListener('corral:shortcut-context', sync);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
      window.removeEventListener('corral:shortcut-context', sync);
    };
  }, [bindings]);
  // The desktop menu asks for commands by name; they run like their shortcuts.
  useEffect(
    () =>
      desktop?.onCommand((id) => {
        if (settingsInteractionBlocked()) return;
        if (id === 'palette') open('palette');
        else if (id === 'help') open('help');
        else runShortcut(id as ShortcutId);
      }),
    [open],
  );
  return (
    <>
      {palette ? (
        <Palette
          mode={palette.mode}
          initialQuery={palette.query}
          sessions={sessions}
          projects={projects}
          projectId={projectId}
          onClose={close}
          onHelp={() => {
            setPalette(null);
            setHelp(true);
          }}
        />
      ) : null}
      <SessionSearchDialog
        open={sessionSearch !== null}
        initialQuery={sessionSearch ?? ''}
        onOpenChange={(open) => {
          if (!open) {
            setSessionSearch(null);
            restoreFocus();
          }
        }}
      />
      {help ? <ShortcutHelp onClose={close} /> : null}
    </>
  );
}

/** Commands that work everywhere in Studio: new session, the sidebar, settings, history. */
function useGlobalCommands(showHelp: () => void) {
  const navigation = useSettingsNavigation();
  const t = useTranslations('Commands');
  const th = useTranslations('Harness');
  const navigate = useNavigate();
  const { transport, runFor, sessionFor } = useServices();
  const location = useRouterState({ select: (state) => state.location });
  const sessionId = /^\/sessions\/([^/]+)/.exec(location.pathname)?.[1];
  const explicitRun =
    /^\/runs\/([^/]+)/.exec(location.pathname)?.[1] ??
    (typeof location.search.run === 'string' ? location.search.run : null);
  const [latest, setLatest] = useState<{ sessionId: string; runId: string } | null>(null);
  useEffect(() => {
    if (!sessionId || explicitRun) return;
    let current = true;
    const refresh = () =>
      void transport.listRuns().then(
        (runs) => {
          const run = runs.find((run) => run.sessionId === sessionId);
          if (current) setLatest(run ? { sessionId, runId: run.runId } : null);
        },
        () => {},
      );
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [transport, sessionId, explicitRun]);
  const runId = explicitRun ?? (latest?.sessionId === sessionId ? latest?.runId : null);
  const session = runId ? runFor(runId) : sessionFor(sessionId ?? 'navigation');
  const events = useStore(session, (state) => state.events);
  useRegisterCommands(
    'extensions',
    harnessCommands(events, th('extensionNotice'), th('startupOnly')),
  );
  const go = t('groups.go');
  const sectionLabel = useSettingsSectionLabel();
  useRegisterCommands('global', [
    {
      id: 'session:new',
      title: t('newSession'),
      group: t('groups.session'),
      slash: 'new',
      shortcutId: 'session.new',
      shortcut: shortcutLabel('session.new'),
      run: () =>
        navigate({
          to: '/projects/$projectId',
          params: { projectId: currentProject() },
          search: { newSession: true },
        }),
    },
    {
      id: 'go:settings',
      title: t('settings'),
      group: go,
      shortcutId: 'settings',
      shortcut: shortcutLabel('settings'),
      run: () => navigate(navigation.link('general')),
    },
    // Every settings section is found by its name and opens in the settings dialog (#92).
    ...SETTINGS_GROUPS.flatMap((group) =>
      group.items.map(
        (section): AppCommand => ({
          id: `settings:${section}`,
          title: sectionLabel(section),
          group: t('groups.settings'),
          keywords: [t('settings')],
          run: () => navigate(navigation.link(section, navigation.projectId)),
        }),
      ),
    ),
    {
      id: 'go:back',
      title: t('back'),
      group: go,
      shortcutId: 'nav.back',
      shortcut: shortcutLabel('nav.back'),
      run: () => window.history.back(),
    },
    {
      id: 'go:forward',
      title: t('forward'),
      group: go,
      shortcutId: 'nav.forward',
      shortcut: shortcutLabel('nav.forward'),
      run: () => window.history.forward(),
    },
    {
      id: 'help:shortcuts',
      title: t('shortcuts'),
      group: t('groups.help'),
      slash: 'help',
      shortcut: shortcutLabel('help'),
      run: showHelp,
    },
  ]);
}

export function Modal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-line bg-raised shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The palette itself. `sessions` mode lists only sessions, as the sidebar's search field asks;
 * either mode can widen session search from the open project to all projects.
 */
export function Palette({
  onClose,
  onHelp,
  mode = 'commands',
  initialQuery = '',
  sessions = NO_SESSIONS,
  projects = NO_PROJECTS,
  projectId,
}: SessionSource & {
  onClose: () => void;
  onHelp: () => void;
  mode?: PaletteRequest['mode'];
  initialQuery?: string | undefined;
}) {
  const navigation = useSettingsNavigation();
  const t = useTranslations('CommandPalette');
  const tp = useTranslations('Projects');
  const ts = useTranslations('SessionSearch');
  const ti = useTranslations('RunIdentity');
  const status = useTranslations('Status');
  const format = useFormatter();
  const templateText = useTemplateText();
  const navigate = useNavigate();
  const services = useServices();
  const [query, setQuery] = useState(initialQuery);
  // Inside a project, session search starts there; anywhere else it starts on all projects.
  const here = projectId ?? currentProject();
  const hereProject = projects.find((project) => project.projectId === here);
  const [scope, setScope] = useState<'project' | 'all'>(projectId ? 'project' : 'all');
  const searchAll = scope === 'all' || !hereProject;
  const [active, setActive] = useState(0);
  const [dynamic, setDynamic] = useState<AppCommand[]>([]);
  const [runDetails, setRunDetails] = useState<Record<string, RunSummary>>({});
  const registered = useRegisteredCommands();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let live = true;
    void Promise.all([
      services.repository.list(),
      services.transport.listRuns(),
      services.repository.listProjects(),
      services.repository.listSessions(currentProject()),
    ]).then(
      async ([corrals, runs, allProjects, projectSessions]) => {
        const shownRuns = runs.slice(0, 20);
        const identities = await loadRunIdentities(
          shownRuns,
          runs,
          projectSessions,
          (id) => services.transport.getRunDefinition(id),
          false,
        );
        if (!live) return;
        setRunDetails(Object.fromEntries(shownRuns.map((run) => [`run:${run.runId}`, run])));
        setDynamic([
          // switch to any active project but the current one.
          ...allProjects
            .filter((p) => !p.archivedAt && p.projectId !== currentProject())
            .map(
              (p): AppCommand => ({
                id: `project:${p.projectId}`,
                title: tp('switchTo', { name: projectName(p, tp('defaultName')) }),
                group: t('groups.projects'),
                keywords: ['project', '프로젝트'],
                run: () =>
                  navigate({ to: '/projects/$projectId', params: { projectId: p.projectId } }),
              }),
            ),
          ...corrals.map(
            (c): AppCommand => ({
              id: `corral:${c.corralId}`,
              title: t('openCorral', { name: c.name }),
              group: t('groups.corrals'),
              run: () =>
                navigate({ to: '/corrals/$corralId/edit', params: { corralId: c.corralId } }),
            }),
          ),
          ...shownRuns.map(
            (r): AppCommand => ({
              id: `run:${r.runId}`,
              title: ti('open', {
                name: runIdentityText(
                  identities[r.runId] ?? runIdentity(r, runs, projectSessions, null, false),
                  ti('unnamed'),
                  (number) => ti('number', { number }),
                ),
              }),
              group: t('groups.runs'),
              keywords: [r.status, r.runId],
              run: () => navigate({ to: '/runs/$runId', params: { runId: r.runId } }),
            }),
          ),
        ]);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [services, navigate, t, tp, ti]);

  // Session search matches titles and purposes (keywords) in the chosen scope.
  const names = useMemo(
    () => new Map(projects.map((p) => [p.projectId, projectName(p, tp('defaultName'))])),
    [projects, tp],
  );
  const sessionCommands = useMemo(
    () =>
      sessions
        .filter((x) => !x.archivedAt && (searchAll || x.projectId === here))
        .toSorted(bySidebarOrder)
        .map(
          (x): AppCommand => ({
            id: `session:${x.sessionId}`,
            title: x.title,
            group: t('groups.sessions'),
            keywords: [x.objective],
            run: () =>
              navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: x.sessionId },
                search: { compose: true },
              }),
          }),
        ),
    [sessions, searchAll, here, t, navigate],
  );
  const sessionProjects = useMemo(
    () =>
      searchAll
        ? new Map(sessions.map((x) => [`session:${x.sessionId}`, names.get(x.projectId)]))
        : new Map<string, string | undefined>(),
    [searchAll, sessions, names],
  );

  const commands = useMemo<AppCommand[]>(() => {
    if (mode === 'sessions') return sessionCommands;
    const fromTemplate = WORKSPACE_TEMPLATES.map(
      (id): AppCommand => ({
        id: `template:${id}`,
        title:
          id === 'blank' ? t('newBlank') : t('newFromTemplate', { name: t(`templates.${id}`) }),
        group: t('groups.create'),
        run: async () => {
          const created = await createFromTemplate(
            services.repository,
            id,
            templateText,
            currentProject(),
          );
          if (created.ok)
            await navigate({
              to: '/corrals/$corralId/edit',
              params: { corralId: created.corralId },
            });
        },
      }),
    );
    const meeting: AppCommand[] = hereProject
      ? [
          {
            id: 'create:meeting',
            title: t('newMeeting', { name: projectName(hereProject, tp('defaultName')) }),
            group: t('groups.create'),
            keywords: ['meeting', '회의'],
            run: () => openNewMeeting(hereProject.projectId),
          },
        ]
      : [];
    const draftTeam: AppCommand = {
      id: 'create:team-draft',
      title: t('draftTeam'),
      group: t('groups.create'),
      keywords: ['goal', 'team', 'draft', '목표', '팀', '초안'],
      run: () => navigate({ to: '/', search: { draft: true } }),
    };
    const go: AppCommand[] = [
      {
        id: 'go:inbox',
        title: t('needsYou'),
        group: t('groups.go'),
        keywords: ['inbox', 'pending', '확인'],
        run: () => navigate({ to: '/inbox' }),
      },
      {
        id: 'go:library',
        title: t('library'),
        group: t('groups.go'),
        keywords: ['teams', 'templates', 'resources', '팀'],
        run: () => navigate({ to: '/library/teams' }),
      },
      {
        id: 'go:schedules',
        title: t('automation'),
        group: t('groups.go'),
        keywords: ['schedules', 'scheduled', '예약'],
        run: () => navigate({ to: '/schedules' }),
      },
      {
        id: 'go:preview',
        title: t('featurePreviews'),
        group: t('groups.go'),
        keywords: ['preview', 'sample', '미리보기'],
        run: () => navigate({ to: '/preview' }),
      },
      {
        id: 'go:corrals',
        title: t('goCorrals'),
        group: t('groups.go'),
        run: () => navigate({ to: '/' }),
      },
      {
        id: 'go:projects',
        title: tp('openAll'),
        group: t('groups.go'),
        keywords: ['projects', '프로젝트'],
        run: () => navigate({ to: '/projects' }),
      },
      {
        id: 'go:demo',
        title: t('goDemo'),
        group: t('groups.go'),
        run: () => {
          window.location.assign('/demo');
        },
      },
      ...(services.mode === 'server'
        ? [
            {
              id: 'go:models',
              title: t('goModels'),
              group: t('groups.go'),
              run: () => navigate(navigation.link('models')),
            },
          ]
        : []),
    ];
    // What this screen can do comes first, then moving around, then making things.
    const help = registered.find((c) => c.id === 'help:shortcuts');
    return [
      ...registered.filter((c) => c.id !== 'help:shortcuts'),
      ...sessionCommands,
      ...dynamic,
      ...go,
      ...meeting,
      draftTeam,
      ...fromTemplate,
      ...(help ? [{ ...help, run: onHelp }] : []),
    ];
  }, [
    mode,
    sessionCommands,
    hereProject,
    dynamic,
    registered,
    services,
    navigate,
    t,
    tp,
    templateText,
    onHelp,
    navigation.link,
  ]);

  // Message and result text is the server's search. It takes the same words, so it always
  // closes the list rather than competing in the ranking.
  const textSearch: AppCommand[] =
    services.mode === 'server'
      ? [
          {
            id: 'search:text',
            title: query.trim() ? t('searchText', { query: query.trim() }) : t('searchTextEmpty'),
            group: ts('title'),
            run: () => {
              window.dispatchEvent(new CustomEvent('corral:search-sessions', { detail: query }));
            },
          },
        ]
      : [];
  const ranked = [...(rankCommands(query, commands) as AppCommand[]), ...textSearch];
  // One heading per group, in the order the groups first appear in the ranking.
  const grouped = new Map<string, AppCommand[]>();
  for (const command of ranked)
    grouped.set(command.group, [...(grouped.get(command.group) ?? []), command]);
  const shown = [...grouped.values()].flat();
  const current = Math.min(active, Math.max(0, shown.length - 1));
  const selectedRun = runDetails[shown[current]?.id ?? ''];
  const chooseScope = (next: 'project' | 'all') => {
    setScope(next);
    setActive(0);
    // The list follows the field's keys, so the field keeps focus after a click.
    inputRef.current?.focus();
  };
  const runCommand = async (command: AppCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    await command.run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % Math.max(1, shown.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + shown.length) % Math.max(1, shown.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void runCommand(shown[current]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <Modal label={t('label')} onClose={onClose}>
      <input
        ref={inputRef}
        role="combobox"
        aria-label={mode === 'sessions' ? t('sessionSearch') : t('search')}
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[current] ? `${listId}-${current}` : undefined}
        aria-autocomplete="list"
        value={query}
        placeholder={mode === 'sessions' ? t('sessionPlaceholder') : t('placeholder')}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-t-lg border-b border-line bg-transparent px-3 py-2.5 text-body outline-none"
      />
      <fieldset
        aria-label={t('scope')}
        className="flex min-w-0 flex-wrap items-center gap-1 px-2 py-1.5"
      >
        {hereProject ? (
          <Button
            variant={searchAll ? 'ghost' : 'secondary'}
            size="compact"
            aria-pressed={!searchAll}
            onClick={() => chooseScope('project')}
          >
            {projectName(hereProject, tp('defaultName'))}
          </Button>
        ) : null}
        <Button
          variant={searchAll ? 'secondary' : 'ghost'}
          size="compact"
          aria-pressed={searchAll}
          onClick={() => chooseScope('all')}
        >
          {t('allProjects')}
        </Button>
      </fieldset>
      <div
        id={listId}
        role="listbox"
        aria-label={t('results')}
        className="max-h-80 overflow-auto p-1"
      >
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-body text-muted-foreground">{t('none')}</p>
        ) : null}
        {[...grouped].map(([group, list]) => (
          // biome-ignore lint/a11y/useSemanticElements: a listbox's option groups are ARIA groups
          <div key={group} role="group" aria-label={group}>
            <p
              className="px-2 pt-2 pb-1 text-2xs text-muted-foreground"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {group}
            </p>
            {list.map((command) => {
              const index = shown.indexOf(command);
              const run = runDetails[command.id];
              const where = sessionProjects.get(command.id);
              return (
                <div
                  key={command.id}
                  id={`${listId}-${index}`}
                  role="option"
                  // Focus stays in the search field; the active option is aria-activedescendant.
                  tabIndex={-1}
                  aria-selected={index === current}
                  aria-disabled={command.disabled ? true : undefined}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    void runCommand(command);
                  }}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-ui ${
                    index === current ? 'bg-subtle' : ''
                  } ${command.disabled ? 'opacity-50' : ''}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{command.title}</span>
                    {where ? (
                      <span className="block truncate text-caption text-muted-foreground">
                        {where}
                      </span>
                    ) : null}
                    {run ? (
                      <span className="block text-caption text-muted-foreground">
                        {status(run.status)} ·{' '}
                        {format.dateTime(new Date(run.startedAt), {
                          dateStyle: 'short',
                          timeStyle: 'medium',
                        })}
                      </span>
                    ) : null}
                  </span>
                  {command.disabled && command.hint ? (
                    <span className="text-2xs text-muted-foreground">{command.hint}</span>
                  ) : command.slash ? (
                    <span className="font-mono text-2xs text-muted-foreground">
                      /{command.slash}
                    </span>
                  ) : null}
                  {command.shortcut ? <Kbd>{command.shortcut}</Kbd> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {selectedRun ? (
        <details
          key={selectedRun.runId}
          className="border-t border-line px-3 py-2 text-caption text-muted-foreground"
        >
          <summary>{ti('details')}</summary>
          <code className="select-text break-all">{selectedRun.runId}</code>
        </details>
      ) : null}
    </Modal>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const t = useTranslations('Shortcuts');
  const closeRef = useRef<HTMLButtonElement>(null);
  // UX-12: focus starts at the top, so the dialog opens on its title and first shortcut.
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), []);
  return (
    <Modal label={t('label')} onClose={onClose}>
      <div className="flex max-h-[70vh] flex-col text-body">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 style={{ fontVariationSettings: fontWeights.semibold }}>{t('label')}</h2>
          <Button ref={closeRef} variant="ghost" size="compact" onClick={onClose}>
            {t('closeButton')}
          </Button>
        </div>
        <div className="min-h-0 overflow-auto px-4 py-3">
          <ShortcutTable />
        </div>
      </div>
    </Modal>
  );
}

const LABEL: Record<ShortcutId, string> = {
  palette: 'palette',
  help: 'help',
  'session.new': 'sessionNew',
  'session.jump': 'sessionJump',
  'view.sidebar': 'viewSidebar',
  'view.panel': 'viewPanel',
  'composer.focus': 'composerFocus',
  settings: 'settings',
  'nav.back': 'navBack',
  'nav.forward': 'navForward',
  'run.stop': 'runStop',
  'reply.quote': 'replyQuote',
};

/** Every shortcut that works here, from the one table the key handler uses. */
export function ShortcutTable({ editable = false }: { editable?: boolean }) {
  useShortcutBindings();
  const [capture, setCapture] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations('Shortcuts');
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('corral:shortcut-context', { detail: { capture } }));
    return () => {
      queueMicrotask(() => window.dispatchEvent(new Event('corral:shortcut-context')));
    };
  }, [capture]);
  const record = (event: KeyboardEvent<HTMLButtonElement>, id: ShortcutId) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      setCapture(null);
      setError(null);
      return;
    }
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const key =
      id === 'session.jump' && /^[1-9]$/.test(event.key)
        ? 'Digit'
        : /^Key[A-Z]$/.test(event.code)
          ? event.code.slice(3).toLowerCase()
          : event.key.toLowerCase();
    const chord = {
      key,
      mod: mac ? event.metaKey : event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    };
    const invalid =
      (mac ? event.ctrlKey : event.metaKey) || event.getModifierState('AltGraph')
        ? 'reserved'
        : bindingError(id, chord, effectiveShortcuts(), Boolean(desktop));
    if (invalid) {
      setError(t(invalid));
      return;
    }
    try {
      writeShortcutBindings({ ...readShortcutBindings(), [id]: chord });
      setError(null);
      setCapture(null);
    } catch {
      setError(t('saveFailed'));
    }
  };
  const { sendKey } = usePreferences();
  const sessionIds = new Set(['session.new', 'session.jump', 'run.stop', 'reply.quote']);
  const commands = (session: boolean): [string, string, ShortcutId?][] =>
    SHORTCUTS.flatMap((s) => {
      const keys = shortcutLabel(s.id);
      return keys && sessionIds.has(s.id) === session
        ? [[t(LABEL[s.id] as 'palette'), keys, s.id]]
        : [];
    });
  const local = (ids: string[]): [string, string][] =>
    LOCAL_KEYS.filter((k) => ids.includes(k.id)).map((k) => [t(k.id), k.keys(sendKey === 'enter')]);
  const groups = [
    { id: 'app', rows: [...commands(false), [t('helpKey'), '?'], ...local(['close'])] },
    { id: 'session', rows: commands(true) },
    { id: 'composer', rows: local(['send', 'newline', 'recall', 'mention', 'slash']) },
    { id: 'editor', rows: local(['save', 'undo', 'redo']) },
  ] as const;
  return (
    <div className="flex flex-col gap-5">
      {editable ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-ui text-muted-foreground">{t('editHint')}</p>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => {
              try {
                writeShortcutBindings({});
                setCapture(null);
                setError(null);
              } catch {
                setError(t('saveFailed'));
              }
            }}
          >
            {t('reset')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui text-danger">
          {error}
        </p>
      ) : null}
      {groups.map((group) => (
        <section key={group.id}>
          <h3
            className="mb-2 text-subtitle"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {t(`groups.${group.id}`)}
          </h3>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5">
            {group.rows.map(([what, keys, id]) => (
              <div key={what} className="contents">
                <dt className="text-ui">{what}</dt>
                <dd className="text-right">
                  {editable && id ? (
                    <Button
                      variant="ghost"
                      size="compact"
                      aria-label={t('edit', { command: what })}
                      aria-pressed={capture === id}
                      data-shortcut-capture={capture === id ? 'true' : undefined}
                      onClick={() => {
                        setError(null);
                        setCapture(id as ShortcutId);
                      }}
                      onBlur={() => setCapture(null)}
                      onKeyDown={
                        capture === id ? (event) => record(event, id as ShortcutId) : undefined
                      }
                    >
                      <Kbd>{capture === id ? t('capture') : keys}</Kbd>
                    </Button>
                  ) : (
                    <Kbd>{keys}</Kbd>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
