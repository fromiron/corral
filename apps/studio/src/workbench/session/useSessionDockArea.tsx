// The bottom dock in the session screen (features/session-panel.md 하단 도크) and the terminals it
// shares with the panel (터미널 탭): the region the frame lays under the conversation and the
// panel, its button in the top bar, its shortcut, what an empty dock shows when the person opens
// it, and where a terminal opens, closes and moves. SessionPage hands in what only it knows (the
// drawer, the run, the panel's terminal tabs, how a tab's screen is drawn) and spreads what
// comes back.
import type { TerminalView } from '@corral/contracts';
import { Button, type TabsClosableHandle, tabsClosableIds } from '@corral/react/design-kit';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { usePageHoldSwitch } from '../browser/usePageStill.ts';
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  type DockKey,
  type DockTab,
  dockKey,
  MESSAGES_MIN_HEIGHT,
} from '../panel/dock.ts';
import type { PanelTarget } from '../panel/tabs.ts';
import { addressedTerminalPlace, plusTerminalPlace } from '../panel/terminalPlace.ts';
import { closingTerminal } from '../terminals/closing.ts';
import { isLive, liveTerminal, terminalCreation } from '../terminals/creation.ts';
import { EndTerminalDialog } from '../terminals/EndTerminalDialog.tsx';
import type { TerminalStore } from '../terminals/store.ts';
import type { TerminalList } from '../terminals/useTerminalList.ts';
import { DOCK_ID_PREFIX, type DockPlus, SessionDock } from './SessionDock.tsx';
import { useSessionDock } from './useSessionDock.ts';

/** Where the focus goes after a close, found once the strip has changed; null leaves it. */
export type FocusTarget = (() => HTMLElement | null) | null;
/** Takes a tab out of its strip, handed where the focus was when the close began. */
export type TabRemoval = (focused: Element | null) => FocusTarget;

/** What the dock reads of the panel's terminal tabs, and what it asks the panel to do. */
export interface PanelTerminals {
  /** The terminals with a tab in the panel. */
  readonly terminals: readonly string[];
  /** The terminal whose tab is the panel's selected tab while the panel is on screen. */
  readonly shown: string | null;
  /** Opens or selects the terminal's tab in the panel (`plus`: without a history entry). */
  open(terminalId: string, from: 'way' | 'plus'): void;
  /** Takes the terminal's tab out of the panel as a close does, ending nothing. */
  remove(terminalId: string): void;
}

interface DockAreaInput {
  sessionId: string;
  store: TerminalStore | null;
  list: TerminalList;
  /** Whether a run of this conversation is going. */
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
  panel: PanelTerminals;
  /** A terminal tab's screen, in the strip it is in. */
  renderTerminal: (
    terminalId: string,
    strip: 'panel' | 'dock',
    move: () => void,
    exitToTab: () => void,
  ) => ReactNode;
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
      const view = timeline.closest<HTMLElement>('[data-chat-view]');
      // An empty conversation centers its first line and the composer in the view: the space
      // around them is the message area, everything in the view but the composer and the
      // notices above. Otherwise the composer lies over the timeline's bottom edge: the messages
      // end where it starts.
      const messages =
        view?.hasAttribute('data-empty-centered') && view.contains(composer)
          ? [...view.children].reduce(
              (left, child) =>
                child === timeline ? left : left - child.getBoundingClientRect().height,
              view.getBoundingClientRect().height,
            )
          : composer.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
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
  const { sessionId, store, runActive, trusted, drawer, closeDrawer, held, openChanges, panel } =
    input;
  const { value, answer } = input.list;
  const services = useServices();
  const t = useTranslations('SessionPanel');
  // Dragging the dock's height moves a browser tab's page: a picture until it is let go.
  const heightDrag = usePageHoldSwitch();
  const tt = useTranslations('Terminals');
  const tf = useTranslations('Files');
  const { dock, dispatch } = useSessionDock(sessionId, answer);
  const terminals: readonly TerminalView[] = value?.list?.terminals ?? [];
  const creation = terminalCreation(value, runActive, services.sharedDevelopment === true);
  const live = liveTerminal(value);
  // What the steps that wait (a creation, a fresh read, the list) read when they go on.
  const latest = useRef({ sessionId, creation, panel, dock, answer, value });
  latest.current = { sessionId, creation, panel, dock, answer, value };

  // Focus: the person's open goes to the dock's selected tab (a terminal's input); a close or a
  // withdrawal with the focus inside hands it back (features/session-panel.md 접근성).
  const strip = useRef<TabsClosableHandle>(null);
  const region = useRef<HTMLElement | null>(null);
  const opener = useRef<{ sessionId: string; element: HTMLElement } | null>(null);
  const focusWanted = useRef<{ sessionId: string } | null>(null);
  // The wait for a terminal's input, which ends with the conversation it was started in.
  const inputWait = useRef<number | null>(null);
  useEffect(() => {
    void sessionId;
    return () => {
      if (inputWait.current !== null) window.clearTimeout(inputWait.current);
      inputWait.current = null;
    };
  }, [sessionId]);
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
  /** A dock with no tab: the focus goes to its body's first row, or its line's button. */
  const focusBody = (from: string) => {
    focusWanted.current = null;
    window.setTimeout(() => {
      if (latest.current.sessionId !== from || latest.current.dock.tabs.length) return;
      region.current?.querySelector<HTMLElement>('[data-dock-body] button')?.focus();
    }, 0);
  };
  // focusIn reads only refs and the conversation, which the dependencies carry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
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
    if (!wanted || wanted.sessionId !== sessionId || !dock.open) return;
    focusWanted.current = null;
    focusIn(dock.selected);
  }, [dock, sessionId]);
  /**
   * The person's open: the focus goes to the dock's selected tab (a terminal's input), or to its
   * body's first row or button with no tab. After the frame's own focus moves of this change (a
   * drawer closing gives its opener the focus): the dock's rule wins.
   */
  function focusIn(selected: DockKey | null) {
    if (!selected) {
      focusBody(sessionId);
      return;
    }
    if (!selected.startsWith('terminal:')) {
      window.setTimeout(() => strip.current?.focusTab(selected), 0);
      return;
    }
    // A terminal's input appears once its screen has attached: wait for it a little.
    if (inputWait.current !== null) window.clearTimeout(inputWait.current);
    let tries = 0;
    let before: Element | null | undefined;
    const attempt = () => {
      inputWait.current = null;
      // The person moved the focus while the screen attached: their move wins.
      const now = document.activeElement;
      const moved = now && now !== document.body ? now : null;
      if (before === undefined) before = moved;
      else if (moved && moved !== before) return;
      const tabPanel = document.getElementById(tabsClosableIds(DOCK_ID_PREFIX, selected).panel);
      const screen =
        tabPanel && !tabPanel.hidden
          ? tabPanel.querySelector<HTMLElement>('[data-terminal-screen]')
          : null;
      const place = screen ? (screen.querySelector<HTMLElement>('textarea') ?? screen) : null;
      if (place) place.focus({ preventScroll: true });
      else if (++tries < 40) inputWait.current = window.setTimeout(attempt, 50);
      else strip.current?.focusTab(selected);
    };
    inputWait.current = window.setTimeout(attempt, 0);
  }

  /** The terminals with a tab in each strip, as they stand now. */
  const strips = () => ({
    panel: new Set(latest.current.panel.terminals),
    dock: new Set(
      latest.current.dock.tabs.flatMap((tab) => (tab.kind === 'terminal' ? [tab.terminalId] : [])),
    ),
  });
  /** Opens or selects a terminal's tab in the dock and opens the dock (a drawer closes first). */
  const showInDock = (terminalId: string, focus: boolean, keepOpen = false) => {
    if (drawer) closeDrawer();
    dispatch(
      { type: 'open', tab: { kind: 'terminal', terminalId }, ...(keepOpen ? { keepOpen } : {}) },
      sessionId,
    );
    if (focus) focusWanted.current = { sessionId };
  };

  /** Makes a terminal with `shellId` for a strip and opens its tab there. */
  const create = async (shellId: string, into: 'panel' | 'dock') => {
    if (!store) return false;
    const from = sessionId;
    const terminalId = await store.create(from, shellId);
    if (!terminalId) return false;
    await store.refresh(from);
    if (into === 'dock') {
      // A late one is the dock's still, but never opens it again (keepOpen).
      dispatch({ type: 'open', tab: { kind: 'terminal', terminalId }, keepOpen: true }, from);
      focusWanted.current = { sessionId: from };
    } else if (latest.current.sessionId === from) latest.current.panel.open(terminalId, 'plus');
    return true;
  };

  // An address that waits for the terminal list (features/session-panel.md 여는 길); anything
  // the person does to the panel or the dock meanwhile drops it.
  const pending = useRef<{ sessionId: string; target: PanelTarget; focus: boolean } | null>(null);
  const cancelPending = () => {
    pending.current = null;
  };
  const place = (target: PanelTarget, focus: boolean) => {
    const now = latest.current;
    const where = addressedTerminalPlace(target.terminal, strips(), now.answer, now.creation.ok);
    switch (where.place) {
      case 'wait':
        pending.current = { sessionId, target, focus };
        return;
      case 'panel':
        now.panel.open(where.terminalId, 'plus');
        return;
      case 'dock':
        showInDock(where.terminalId, focus);
        return;
      case 'create': {
        if (drawer) closeDrawer();
        dispatch({ type: 'show' }, sessionId);
        const shell = now.creation.ok ? now.creation.shells[0] : undefined;
        if (shell) void create(shell.id, 'dock');
        return;
      }
      case 'dockOnly':
        if (drawer) closeDrawer();
        dispatch({ type: 'show' }, sessionId);
        return;
      case 'none':
        return;
    }
  };
  /** An opening way or an address the dock opens: `panel=debug`, or a terminal not in the panel. */
  const openAddressed = (target: PanelTarget, focus: boolean) => {
    pending.current = null;
    if (target.panel === 'debug') {
      if (drawer) closeDrawer();
      dispatch({ type: 'open', tab: { kind: 'debug' } }, sessionId);
      if (focus) focusWanted.current = { sessionId };
      return;
    }
    place(target, focus);
  };
  const answerKey =
    answer.kind === 'answered' ? `${answer.ids.join(',')}|${answer.live}` : answer.kind;
  // place reads the latest render through `latest`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    void answerKey;
    const waiting = pending.current;
    if (!waiting || waiting.sessionId !== sessionId || latest.current.answer.kind === 'waiting')
      return;
    pending.current = null;
    place(waiting.target, waiting.focus);
  }, [answerKey, sessionId]);

  // Closing a terminal's tab ends the terminal as its state says (closing.ts): the dialog asks
  // first when a command may be running, and nothing is sent while it asks.
  const [asking, setAsking] = useState<{
    sessionId: string;
    terminalId: string;
    remove: TabRemoval;
    focused: Element | null;
  } | null>(null);
  /**
   * `remove` takes the tab out of its strip; it is handed where the focus was when the close
   * began, since a dialog that asks holds the focus meanwhile, and says where the focus goes.
   */
  const closeTerminal = async (terminalId: string, remove: TabRemoval) => {
    const focused = document.activeElement;
    if (!store) {
      remove(focused);
      return;
    }
    const from = sessionId;
    // A tab restored before the list answered: what the terminal is comes from the list.
    if (!store.getState().sessions[from]?.list) await store.refresh(from);
    if (latest.current.sessionId !== from) return;
    const state =
      store
        .getState()
        .sessions[from]?.list?.terminals.find((item) => item.terminalId === terminalId)?.state ??
      'exited';
    const action = await closingTerminal(state, () => store.readForeground(terminalId));
    if (latest.current.sessionId !== from) return;
    if (action === 'ask') {
      setAsking({ sessionId: from, terminalId, remove, focused });
      return;
    }
    remove(focused);
    if (action === 'end' || action === 'recheck') void store.stop(terminalId).catch(() => {});
  };
  // Leaving the conversation drops the question, sending nothing.
  const askingHere = asking?.sessionId === sessionId ? asking : null;
  // Where the focus goes once the dialog that ended a terminal has closed.
  const endedFocus = useRef<FocusTarget>(null);
  const endDialog = (
    <EndTerminalDialog
      open={Boolean(askingHere)}
      onKeep={() => setAsking(null)}
      onEnd={() => {
        const ending = askingHere;
        setAsking(null);
        if (!ending || !store) return;
        endedFocus.current = ending.remove(ending.focused);
        void store.stop(ending.terminalId).catch(() => {});
      }}
      afterEnd={() => {
        const target = endedFocus.current;
        endedFocus.current = null;
        return target?.() ?? null;
      }}
    />
  );

  // The toggles only show and hide the dock: they never make a terminal or take one in from the
  // panel, since a live terminal holds the Paddock (features/session-panel.md 하단 도크).
  const toggle = () => {
    if (held()) return;
    pending.current = null;
    if (drawer) {
      // With a drawer up the dock ends on screen: the drawer closes, a closed dock opens and an
      // open one stays. The dock's rule wins, and the drawer's opener is not this one.
      closeDrawer();
      opener.current = null;
      if (dock.open) {
        const selected = dock.selected;
        window.setTimeout(() => focusIn(selected), 0);
      } else {
        focusWanted.current = { sessionId };
        dispatch({ type: 'show' });
      }
      return;
    }
    if (dock.open) {
      if (focusInside()) handBack.current = 'opener';
      dispatch({ type: 'toggle' });
      return;
    }
    rememberOpener();
    focusWanted.current = { sessionId };
    dispatch({ type: 'show' });
  };

  const select = (key: DockKey) => {
    if (held()) return;
    pending.current = null;
    dispatch({ type: 'select', key });
  };
  /** Takes a tab out of the dock, the focus going on as a close sends it. */
  const dropTab = (key: DockKey, focused: Element | null = document.activeElement): FocusTarget => {
    const keys = latest.current.dock.tabs.map(dockKey);
    const index = keys.indexOf(key);
    if (index < 0) return null;
    let target: FocusTarget = null;
    if (focused && region.current?.contains(focused)) {
      if (keys.length === 1) {
        focusBody(sessionId);
        target = () =>
          region.current?.querySelector<HTMLElement>('[data-dock-body] button') ?? null;
      } else {
        const next = keys[index + 1] ?? keys[index - 1];
        if (next) {
          window.setTimeout(() => strip.current?.focusTab(next), 0);
          target = () => document.getElementById(tabsClosableIds(DOCK_ID_PREFIX, next).tab);
        }
      }
    }
    dispatch({ type: 'close', key });
    return target;
  };
  const close = (key: DockKey) => {
    if (held()) return;
    pending.current = null;
    if (key.startsWith('terminal:'))
      void closeTerminal(key.slice('terminal:'.length), (focused) => dropTab(key, focused));
    else dropTab(key);
  };
  /** The ⋯ move: the panel's tab of the terminal goes to the dock's right end, selected. */
  const moveToDock = (terminalId: string) => {
    if (held()) return;
    panel.remove(terminalId);
    showInDock(terminalId, true);
  };
  const moveToPanel = (terminalId: string) => {
    if (held()) return;
    // As a drag out: the last tab leaving hides the dock.
    dispatch({ type: 'close', key: `terminal:${terminalId}`, hide: true });
    panel.open(terminalId, 'plus');
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
  /** "+" → 터미널 in either strip's list: the live terminal's tab where it is, or a new one. */
  const onPlusTerminal = (from: 'panel' | 'dock', shellId?: string) => {
    if (held()) return;
    pending.current = null;
    const where = plusTerminalPlace(from, live?.terminalId ?? null, strips(), creation.ok);
    if (where.place === 'panel') panel.open(where.terminalId, 'plus');
    else if (where.place === 'dock') showInDock(where.terminalId, true);
    else if (where.place === 'create' && creation.ok) {
      const shell = shellId ?? creation.shells[0]?.id;
      if (shell) void create(shell, where.strip);
    }
  };
  const onDebug = () => {
    if (held()) return;
    pending.current = null;
    dispatch({ type: 'open', tab: { kind: 'debug' } });
    focusWanted.current = { sessionId };
  };

  // A dock with no tab lists what it can open; one line stands in the list's place only without
  // a Paddock or without the terminal list, each with its one button.
  const retryList = async () => {
    if (!store) return;
    const from = sessionId;
    const retrying = document.activeElement;
    await store.refresh(from);
    // The button goes with the line: the focus it held goes on to the list.
    if (latest.current.value?.list && retrying instanceof HTMLElement && !retrying.isConnected)
      focusBody(from);
  };
  const line = (() => {
    if (!store) return null;
    if (!value?.list) {
      if (value?.loading || answer.kind === 'waiting') return <p role="status">{tt('loading')}</p>;
      return (
        <>
          <p role="status">{tt('listUnread')}</p>
          <Button variant="tertiary" onClick={() => void retryList()}>
            {tt('retryList')}
          </Button>
        </>
      );
    }
    if (!value.list.target)
      return (
        <>
          <p>{tf('noCopyTitle')}</p>
          <Button variant="tertiary" onClick={openChanges}>
            {tf('makeCopyThere')}
          </Button>
        </>
      );
    if (value.pendingCreate)
      return (
        <>
          <p role="status">{tt('createPending')}</p>
          <Button
            variant="tertiary"
            disabled={value.loading}
            onClick={() => void store.checkCreate(sessionId)}
          >
            {tt('checkCreate')}
          </Button>
          {value.canRetryCreate ? (
            <Button
              variant="tertiary"
              disabled={value.loading}
              onClick={() => void store.retryCreate(sessionId)}
            >
              {tt('retryCreate')}
            </Button>
          ) : null}
        </>
      );
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
  // The button's dot: a running terminal, or one whose end needs confirming, not on screen while
  // the dock is closed (a withdrawn dock is open). On screen is the panel's selected tab of a
  // panel on screen. Starting and stopping ones have none.
  const offScreen = dock.open
    ? []
    : terminals.filter((item) => isLive(item) && item.terminalId !== panel.shown);
  const dot = offScreen.some((item) => item.state === 'uncertain')
    ? ('warning' as const)
    : offScreen.some((item) => item.state === 'running')
      ? ('running' as const)
      : null;

  const renderTab = (tab: DockTab) =>
    tab.kind === 'terminal'
      ? input.renderTerminal(
          tab.terminalId,
          'dock',
          () => moveToPanel(tab.terminalId),
          () => strip.current?.focusTab(`terminal:${tab.terminalId}`),
        )
      : input.renderDebug();

  return {
    toggle: store ? { pressed: dock.open, dot, onToggle: toggle } : null,
    /** The "+" lists' 터미널 row (the panel's and the dock's are one). */
    terminalRow,
    onPlusTerminal,
    closeTerminal,
    moveToDock,
    openAddressed,
    cancelPending,
    endDialog: store ? endDialog : null,
    frame: store
      ? {
          bottom: (
            <SessionDock
              sessionId={sessionId}
              dock={dock}
              strip={strip}
              terminals={terminals}
              plus={plus}
              line={line}
              onSelect={select}
              onClose={close}
              onReorder={(key, toIndex) => {
                if (!held()) dispatch({ type: 'reorder', key, toIndex });
              }}
              // Out by drag into the panel: unlike a close, moving the last tab out hides the dock.
              onMoveOut={(key) => dispatch({ type: 'close', key, hide: true })}
              onMoveIn={(terminalId, index) =>
                dispatch({ type: 'open', tab: { kind: 'terminal', terminalId }, index })
              }
              onTerminal={(shellId) => onPlusTerminal('dock', shellId)}
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
            onDragChange: heightDrag,
          },
          onBottomWithdrawnChange,
        }
      : {},
  };
}
