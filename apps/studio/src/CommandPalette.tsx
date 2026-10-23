import { TIDY_EVENT } from '@corral/react';
import { Button, Kbd } from '@corral/react/design-kit';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  type AppCommand,
  harnessCommands,
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
import { createFromTemplate, WORKSPACE_TEMPLATES } from './templates.ts';
import {
  SETTINGS_GROUPS,
  settingsInteractionBlocked,
  useSettingsNavigation,
} from './workbench/navigation.ts';
import { changePreferences, preferences, usePreferences } from './workbench/preferences.ts';
import { useSettingsSectionLabel } from './workbench/SettingsNavigation.tsx';

/** True while the user types in a field or composes with an IME: global keys stay quiet. */
function typing(event: globalThis.KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  const target = event.target as HTMLElement | null;
  return Boolean(
    target &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)),
  );
}

/**
 * ⌘K / Ctrl+K command palette and ? shortcut help for the whole Studio (roadmap UX-A5).
 * Modal, keyboard first, IME safe; focus returns where it was on close.
 */
export function CommandLayer() {
  const bindings = useShortcutBindings();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const open = useCallback((which: 'palette' | 'help') => {
    returnTo.current = document.activeElement as HTMLElement | null;
    if (which === 'palette') setPalette(true);
    else setHelp(true);
  }, []);
  const close = useCallback(() => {
    setPalette(false);
    setHelp(false);
    const target = returnTo.current;
    queueMicrotask(() => target?.focus());
  }, []);
  useEffect(() => {
    const show = () => {
      if (!settingsInteractionBlocked()) open('palette');
    };
    window.addEventListener('corral:open-palette', show);
    return () => window.removeEventListener('corral:open-palette', show);
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
  // The desktop menu asks for commands by name; they run like their shortcuts (CR-017).
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
          onClose={close}
          onHelp={() => {
            setPalette(false);
            setHelp(true);
          }}
        />
      ) : null}
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
  const prefs = usePreferences();
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
      id: 'view:sidebar',
      title: prefs.sidebarOpen ? t('hideSidebar') : t('showSidebar'),
      group: t('groups.view'),
      shortcutId: 'view.sidebar',
      shortcut: shortcutLabel('view.sidebar'),
      run: () => changePreferences({ sidebarOpen: !preferences.getState().sidebarOpen }),
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

function Palette({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const navigation = useSettingsNavigation();
  const t = useTranslations('CommandPalette');
  const tw = useTranslations('Workspace');
  const tp = useTranslations('Projects');
  const navigate = useNavigate();
  const services = useServices();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [dynamic, setDynamic] = useState<AppCommand[]>([]);
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
      ([corrals, runs, projects, sessions]) => {
        if (!live) return;
        setDynamic([
          ...sessions
            .filter((x) => !x.archivedAt)
            .sort(
              (a, b) =>
                Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
            )
            .map(
              (x): AppCommand => ({
                id: `session:${x.sessionId}`,
                title: x.title,
                group: t('groups.sessions'),
                keywords: [x.objective],
                run: () =>
                  navigate({ to: '/sessions/$sessionId', params: { sessionId: x.sessionId } }),
              }),
            ),
          // CR-010: switch to any active project but the current one.
          ...projects
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
          ...runs.slice(0, 20).map(
            (r): AppCommand => ({
              id: `run:${r.runId}`,
              title: t('openRun', { runId: r.runId }),
              group: t('groups.runs'),
              keywords: [r.status],
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
  }, [services, navigate, t, tp]);

  const commands = useMemo<AppCommand[]>(() => {
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
            tw('newName'),
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
    // Only in the editor: the canvas listens for the tidy event (roadmap 18).
    const editing = /\/corrals\/[^/]+\/edit$|^\/demo$/.test(window.location.pathname);
    const tidy: AppCommand[] = editing
      ? [
          {
            id: 'editor:tidy',
            title: t('tidy'),
            group: t('groups.editor'),
            keywords: ['arrange', 'layout', 'tidy', '정리', '배치'],
            run: () => {
              window.dispatchEvent(new Event(TIDY_EVENT));
            },
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
      ...tidy,
      ...registered.filter((c) => c.id !== 'help:shortcuts'),
      ...dynamic,
      ...go,
      draftTeam,
      ...fromTemplate,
      ...(help ? [{ ...help, run: onHelp }] : []),
    ];
  }, [dynamic, registered, services, navigate, t, tw, tp, onHelp, navigation.link]);

  const ranked = rankCommands(query, commands) as AppCommand[];
  // One heading per group, in the order the groups first appear in the ranking.
  const grouped = new Map<string, AppCommand[]>();
  for (const command of ranked)
    grouped.set(command.group, [...(grouped.get(command.group) ?? []), command]);
  const shown = [...grouped.values()].flat();
  const current = Math.min(active, Math.max(0, shown.length - 1));
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
        aria-label={t('search')}
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[current] ? `${listId}-${current}` : undefined}
        aria-autocomplete="list"
        value={query}
        placeholder={t('placeholder')}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-t-lg border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={t('results')}
        className="max-h-80 overflow-auto p-1"
      >
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('none')}</p>
        ) : null}
        {[...grouped].map(([group, list]) => (
          // biome-ignore lint/a11y/useSemanticElements: a listbox's option groups are ARIA groups
          <div key={group} role="group" aria-label={group}>
            <p className="px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground">{group}</p>
            {list.map((command) => {
              const index = shown.indexOf(command);
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
                  <span className="min-w-0 flex-1 truncate">{command.title}</span>
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
      <div className="flex max-h-[70vh] flex-col text-sm">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="font-semibold">{t('label')}</h2>
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
  const sessionIds = new Set(['session.new', 'session.jump', 'run.stop']);
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
          <h3 className="mb-2 text-sm font-semibold">{t(`groups.${group.id}`)}</h3>
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
