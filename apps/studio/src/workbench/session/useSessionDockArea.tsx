// The bottom dock in the session screen (features/session-panel.md 하단 도크): the region the
// frame lays under the conversation and the panel, its button in the top bar, its shortcut, and
// what an empty dock shows when the person opens it. SessionPage hands in what only it knows
// (the drawer, the run, how a tab's screen is drawn) and spreads what comes back.
import type { TerminalView } from '@corral/contracts';
import { Button, type TabsClosableHandle, tabsClosableIds } from '@corral/react/design-kit';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  type DockKey,
  type DockTab,
  dockKey,
  MESSAGES_MIN_HEIGHT,
} from '../panel/dock.ts';
import { isLive, liveTerminal, terminalCreation } from '../terminals/creation.ts';
import { type TerminalStore, terminalStore } from '../terminals/store.ts';
import { DOCK_ID_PREFIX, type DockPlus, SessionDock, useCreationReason } from './SessionDock.tsx';
import { useSessionDock } from './useSessionDock.ts';

const noSubscription = () => () => {};

interface DockAreaInput {
  sessionId: string;
  /** A run of this conversation is going: no new terminal now. */
  runActive: boolean;
  /** The project's binding is trusted: the debugger can run in its Paddock. */
  trusted: boolean;
  /** The panel is a drawer: a dock toggle closes it first. */
  drawer: boolean;
  closeDrawer: () => void;
  /** The composer's modal confirmation holds the screen. */
  held: () => boolean;
  /** Where a conversation without a Paddock sets one up: the 변경 tab. */
  openChanges: () => void;
  renderTerminal: (terminalId: string) => ReactNode;
  renderDebug: () => ReactNode;
  /** The conversation's own region, measured for the message area the dock leaves. */
  main: HTMLElement | null;
}

/** The message area's floor in main: 160px of messages and everything else main holds. */
function useMainFloor(main: HTMLElement | null) {
  const [floor, setFloor] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!main || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const box = main.getBoundingClientRect();
      // Hidden (maximized, say): the last floor stands.
      if (box.height === 0) return;
      const timeline = main.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
      const composer = main.querySelector<HTMLElement>('[data-testid="chat-composer"]');
      if (!timeline || !composer) return;
      // The composer lies over the timeline's bottom edge: the messages end where it starts.
      const messages = composer.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
      if (messages <= 0) return;
      setFloor(Math.round(MESSAGES_MIN_HEIGHT + (box.height - messages)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    const composer = main.querySelector<HTMLElement>('[data-testid="chat-composer"]');
    if (composer) observer.observe(composer);
    measure();
    return () => observer.disconnect();
  }, [main]);
  return floor;
}

/**
 * Where the focus goes when the dock's place leaves the screen with it inside: the composer if it
 * can be used, else the panel's selected tab, else the sidebar's toggle (features/session-panel.md
 * 접근성).
 */
function handFocusOn() {
  const composer = document.querySelector<HTMLTextAreaElement>(
    '[data-testid="chat-composer"] textarea',
  );
  if (composer && !composer.disabled && !composer.closest('[inert]')) return composer.focus();
  const tab = document.querySelector<HTMLElement>(
    '[data-slot="side-panel-side"]:not([inert]) [role="tab"][aria-selected="true"]',
  );
  if (tab) return tab.focus();
  document.querySelector<HTMLElement>('.app-sidebar-trigger')?.focus();
}

export function useSessionDockArea(input: DockAreaInput) {
  const { sessionId, runActive, trusted, drawer, closeDrawer, held, openChanges } = input;
  const services = useServices();
  const t = useTranslations('SessionPanel');
  const tt = useTranslations('Terminals');
  const tf = useTranslations('Files');
  const reason = useCreationReason();
  const store: TerminalStore | null =
    services.mode === 'server' && services.terminals ? terminalStore(services.terminals) : null;
  const { dock, dispatch, refreshTerminals } = useSessionDock(sessionId, store);
  const readSession = useCallback(
    () => (store ? store.getState().sessions[sessionId] : undefined),
    [store, sessionId],
  );
  const value = useSyncExternalStore(store?.subscribe ?? noSubscription, readSession, readSession);
  const terminals: readonly TerminalView[] = value?.list?.terminals ?? [];
  const creation = terminalCreation(value, runActive);
  const live = liveTerminal(value);
  const runActiveNow = useRef(runActive);
  runActiveNow.current = runActive;

  // Focus: the person's open goes to the dock's selected tab (a terminal's input); a close or a
  // withdrawal with the focus inside hands it back (features/session-panel.md 접근성).
  const strip = useRef<TabsClosableHandle>(null);
  const region = useRef<HTMLElement | null>(null);
  const opener = useRef<{ sessionId: string; element: HTMLElement } | null>(null);
  const focusWanted = useRef<{ sessionId: string } | null>(null);
  const handBack = useRef<'opener' | 'frame' | null>(null);
  const rememberOpener = () => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !region.current?.contains(focused)
    )
      opener.current = { sessionId, element: focused };
  };
  const focusInside = () => {
    const focused = document.activeElement;
    return Boolean(focused && region.current?.contains(focused));
  };
  useLayoutEffect(() => {
    void dock;
    const back = handBack.current;
    if (back) {
      handBack.current = null;
      if (back === 'opener') {
        const own = opener.current?.sessionId === sessionId ? opener.current.element : null;
        (own?.isConnected && !region.current?.contains(own)
          ? own
          : document.querySelector<HTMLElement>('[data-session-dock-toggle]')
        )?.focus();
      } else handFocusOn();
    }
    const wanted = focusWanted.current;
    if (!wanted || wanted.sessionId !== sessionId || !dock.open || !dock.selected) return;
    focusWanted.current = null;
    const selected = dock.selected;
    // After the frame's own focus moves of this change (a drawer closing gives its opener the
    // focus): the dock's rule wins.
    if (!selected.startsWith('terminal:')) {
      window.setTimeout(() => strip.current?.focusTab(selected), 0);
      return;
    }
    // A terminal's input appears once its screen has attached: wait for it a little.
    let tries = 0;
    const attempt = () => {
      const panel = document.getElementById(tabsClosableIds(DOCK_ID_PREFIX, selected).panel);
      const screen =
        panel && !panel.hidden ? panel.querySelector<HTMLElement>('[data-terminal-screen]') : null;
      const place = screen ? (screen.querySelector<HTMLElement>('textarea') ?? screen) : null;
      if (place) place.focus({ preventScroll: true });
      else if (++tries < 40) window.setTimeout(attempt, 50);
      else strip.current?.focusTab(selected);
    };
    window.setTimeout(attempt, 0);
  }, [dock, sessionId]);

  const openTerminalTab = (terminalId: string, keepOpen = false) =>
    dispatch(
      { type: 'open', tab: { kind: 'terminal', terminalId }, ...(keepOpen ? { keepOpen } : {}) },
      sessionId,
    );

  /** Makes a terminal with `shellId` and opens its tab; a late one leaves the dock as it is. */
  const create = async (shellId: string) => {
    if (!store) return;
    const from = sessionId;
    const terminalId = await store.create(from, shellId);
    if (!terminalId) return;
    await store.refresh(from);
    dispatch({ type: 'open', tab: { kind: 'terminal', terminalId }, keepOpen: true }, from);
    focusWanted.current = { sessionId: from };
  };

  /** An empty dock opened by its toggles: the live terminal, a new one, or the reason line. */
  const openEmpty = async () => {
    const from = sessionId;
    dispatch({ type: 'show' }, from);
    let current = store?.getState().sessions[from];
    if (store && !current?.list) {
      await refreshTerminals();
      current = store.getState().sessions[from];
    }
    const found = liveTerminal(current);
    if (found) {
      dispatch({ type: 'open', tab: { kind: 'terminal', terminalId: found.terminalId } }, from);
      focusWanted.current = { sessionId: from };
      return;
    }
    const now = terminalCreation(current, runActiveNow.current);
    const first = now.ok ? now.shells[0] : undefined;
    if (first) await create(first.id);
  };

  const toggle = () => {
    if (held()) return;
    if (drawer) closeDrawer();
    if (dock.open) {
      if (focusInside()) handBack.current = 'opener';
      dispatch({ type: 'toggle' });
      return;
    }
    // A drawer closed for the dock: the dock's rule wins, and the drawer's opener is not this one.
    if (!drawer) rememberOpener();
    else opener.current = null;
    focusWanted.current = { sessionId };
    if (dock.tabs.length) dispatch({ type: 'toggle' });
    else void openEmpty();
  };

  const select = (key: DockKey) => {
    if (held()) return;
    dispatch({ type: 'select', key });
  };
  const close = (key: DockKey) => {
    if (held()) return;
    // Closing a terminal's tab ends it once the terminal tab's close rule is in; until then a dock
    // tab closes as any tab does, sending nothing.
    const keys = dock.tabs.map(dockKey);
    const index = keys.indexOf(key);
    if (focusInside()) {
      if (keys.length === 1) handBack.current = 'opener';
      else {
        const next =
          key === dock.selected
            ? (keys[index + 1] ?? keys[index - 1])
            : (keys[index + 1] ?? keys[index - 1]);
        if (next) window.setTimeout(() => strip.current?.focusTab(next), 0);
      }
    }
    dispatch({ type: 'close', key });
  };

  const terminalRow: DockPlus['terminal'] =
    store && value?.list?.target
      ? {
          live: Boolean(live),
          blocked: creation.ok ? null : creation.reason,
          shells: creation.ok ? creation.shells : [],
        }
      : null;
  const plus: DockPlus = {
    terminal: terminalRow,
    debug:
      Boolean(value?.list?.target) &&
      trusted &&
      services.mode === 'server' &&
      typeof services.workspaces?.debugState === 'function',
  };
  const onTerminal = (shellId?: string) => {
    if (held()) return;
    if (live) {
      openTerminalTab(live.terminalId);
      focusWanted.current = { sessionId };
      return;
    }
    if (!creation.ok) return;
    const shell = shellId ?? creation.shells[0]?.id;
    if (shell) void create(shell);
  };
  const onDebug = () => {
    if (held()) return;
    dispatch({ type: 'open', tab: { kind: 'debug' } });
    focusWanted.current = { sessionId };
  };

  // The body of a dock with no tab: why no terminal opened, with at most one action.
  const body = (() => {
    if (!store) return null;
    if (value?.loading && !value.pendingCreate) return <p role="status">{tt('loading')}</p>;
    if (value?.list && !value.list.target)
      return (
        <>
          <p>{tf('noCopyTitle')}</p>
          <Button variant="tertiary" size="compact" onClick={openChanges}>
            {tf('makeCopyThere')}
          </Button>
        </>
      );
    if (value?.pendingCreate)
      return (
        <>
          <p role="status">{tt('createPending')}</p>
          <Button
            variant="tertiary"
            size="compact"
            disabled={value.loading}
            onClick={() => void store.checkCreate(sessionId)}
          >
            {tt('checkCreate')}
          </Button>
        </>
      );
    if (!creation.ok && creation.reason !== 'createHeld')
      return <p role="status">{reason(creation.reason)}</p>;
    return null;
  })();

  // A withdrawn dock that held the focus hands it on in the frame's order.
  const onBottomWithdrawnChange = (withdrawn: boolean) => {
    if (withdrawn && focusInside()) {
      handBack.current = 'frame';
      // The report comes after the change: nothing else will run the effect.
      window.setTimeout(() => {
        if (handBack.current !== 'frame') return;
        handBack.current = null;
        handFocusOn();
      }, 0);
    }
  };

  const floor = useMainFloor(input.main);
  // The button's dot: a running terminal, or one whose end needs confirming, off screen while
  // the dock is closed (a withdrawn dock is open). Starting and stopping ones have none.
  const offScreen = dock.open ? [] : terminals.filter(isLive);
  const dot = offScreen.some((item) => item.state === 'uncertain')
    ? ('warning' as const)
    : offScreen.some((item) => item.state === 'running')
      ? ('running' as const)
      : null;

  const renderTab = (tab: DockTab) =>
    tab.kind === 'terminal' ? input.renderTerminal(tab.terminalId) : input.renderDebug();

  return {
    toggle: store ? { pressed: dock.open, dot, onToggle: toggle } : null,
    frame: store
      ? {
          bottom: (
            <SessionDock
              sessionId={sessionId}
              dock={dock}
              strip={strip}
              terminals={terminals}
              plus={plus}
              body={body}
              onSelect={select}
              onClose={close}
              onTerminal={onTerminal}
              onDebug={onDebug}
              renderTab={renderTab}
            />
          ),
          bottomLabel: t('dock'),
          bottomHeight: dock.height,
          bottomOpen: dock.open,
          bottomMinHeight: DOCK_MIN_HEIGHT,
          ...(floor !== undefined ? { mainMinHeight: floor } : {}),
          bottomRef: (node: HTMLElement | null) => {
            region.current = node;
          },
          bottomResize: {
            'aria-label': t('dockHeight'),
            min: DOCK_MIN_HEIGHT,
            max: 100_000,
            onChange: (px: number) => dispatch({ type: 'height', px }),
            onReset: () => dispatch({ type: 'height', px: DOCK_DEFAULT_HEIGHT }),
          },
          onBottomWithdrawnChange,
        }
      : {},
  };
}
