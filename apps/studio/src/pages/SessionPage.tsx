import type { TextAttachment, TextRange } from '@corral/contracts';
import { TERMINAL_RUN_STATUSES, type TextAttachmentProvenance } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { askCancelConfirmation } from '@corral/react';
import { SidePanelFrame, type TabsClosableHandle, tabsClosableIds } from '@corral/react/design-kit';
import { useRouter } from '@tanstack/react-router';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { setCurrentProject } from '../projects.ts';
import { sessionRoute } from '../router.tsx';
import { modalConfirmationOpen } from '../workbench/modalConfirmation.ts';
import { panelKey, SESSION_PANELS, type SessionPanel } from '../workbench/panels/registry.ts';
import { type SessionSearch, sessionPanelDescriptor } from '../workbench/panels/routes.ts';

export type { SessionPanel } from '../workbench/panels/registry.ts';
export { Composer } from '../workbench/session/Composer.tsx';

import { useServices } from '../services.tsx';
import { ArchivedSessionNotice } from '../workbench/ArchivedSessionNotice.tsx';
import {
  AdviceArrival,
  type AdviceRequest,
  useAdviceArrivalRequest,
} from '../workbench/adviceArrival.ts';
import { type AttachmentCapture, appendComposerAttachment } from '../workbench/context/bridge.ts';
import { SourceNavigationContext } from '../workbench/context/SourceAttachments.tsx';
import { DebuggerPanel } from '../workbench/DebuggerPanel.tsx';
import { DockDocumentPanel } from '../workbench/DockDocumentPanel.tsx';
import {
  type DockOpenDocument,
  DockWorkbench,
  type DockWorkbenchHandle,
} from '../workbench/docking/DockWorkbench.tsx';
import type { DockContextView } from '../workbench/docking/layout.ts';
import { documentKey, documentStore } from '../workbench/documents/store.ts';
import { editorCopyDirty, subscribeEditorCopies } from '../workbench/editorDraft.ts';
import { FilePanel, type FileReference } from '../workbench/FilePanel.tsx';
import { ProblemsPanel } from '../workbench/ProblemsPanel.tsx';
import { deviceStorage } from '../workbench/panel/memory.ts';
import {
  conversationOperable,
  type OpenTab,
  type PanelState,
  panelOnScreen,
  toggleAvailable,
} from '../workbench/panel/model.ts';
import { runControlPlace, stopCommandRoute } from '../workbench/panel/runControls.ts';
import { RunHeadControlsContext, StopCommandContext } from '../workbench/panel/runHeadControls.ts';
import {
  PANEL_TAB_OF,
  plusTarget,
  type TabKey,
  tabKey,
  targetTab,
} from '../workbench/panel/tabs.ts';
import { runStatusOf, usePanelFrame } from '../workbench/panel/usePanelFrame.ts';
import {
  CONVERSATION_MIN_WIDTH,
  drawerWidth,
  PANEL_MIN_WIDTH,
  panelWidth,
  readPanelWidth,
  writePanelWidth,
} from '../workbench/panel/width.ts';
import { useGivenWorkAreaWidth } from '../workbench/panel/workAreaWidth.ts';
import { sessionRunViews } from '../workbench/panelRun.ts';
import { QuickOpen, requestFileReveal } from '../workbench/QuickOpen.tsx';
import { SessionChangesPanel } from '../workbench/SessionChangesPanel.tsx';
import { ChangesTabShownContext } from '../workbench/session/ComposerActivity.tsx';
import {
  createPendingTrayStore,
  PendingTrayContext,
  revealPendingTray,
} from '../workbench/session/PendingTray.tsx';
import { SessionActions } from '../workbench/session/SessionActions.tsx';
import { SessionChat } from '../workbench/session/SessionChat.tsx';
import { PANEL_ID_PREFIX, SessionPanelSide } from '../workbench/session/SessionPanelSide.tsx';
import {
  ArtifactsPanel,
  ChecksPanel,
  RunPanel,
  useRunNames,
} from '../workbench/session/SessionPanels.tsx';
import { useSessionDockArea } from '../workbench/session/useSessionDockArea.tsx';
import { terminalStore } from '../workbench/terminals/store.ts';
import { TerminalScreen } from '../workbench/terminals/TerminalScreen.tsx';
import { useTerminalList } from '../workbench/terminals/useTerminalList.ts';
import { useSessionRuns } from '../workbench/useSessionRuns.ts';
import { WorkbenchToolsPanel } from '../workbench/WorkbenchToolsPanel.tsx';
import { ChatWidgetProvider } from '../workbench/widgets/useChatWidgets.tsx';
import { TeamDesign } from './EditorPage.tsx';
import { useBinding } from './FilesViews.tsx';
import { MeetingPage } from './MeetingPage.tsx';

// A work session: what was asked, the runs it started, the queue, and
// one input box whose intent is chosen, never guessed.

/**
 * Context panes follow the session URL; document tabs keep their explicit workspace target.
 * Stores own editing and execution state independently of dock placement.
 */
/** a meeting has its own chat; every other session keeps the work view. */
/** Whether the selected tab of `state` is the one a way's target names. */
function namesSelected(target: Partial<SessionSearch>, state: PanelState): boolean {
  const key = state.selected;
  if (!target.panel || !key) return false;
  const kind = PANEL_TAB_OF[target.panel];
  if (kind === null) return false;
  if (kind === 'terminal') return target.terminal ? key === `terminal:${target.terminal}` : false;
  if (kind !== 'run') return key === kind;
  return target.run ? key === `run:${target.run}` : key.startsWith('run:');
}

export function SessionPage() {
  const { session } = sessionRoute.useLoaderData();
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${session.title} · Corral Studio`;
    return () => {
      document.title = previousTitle;
    };
  }, [session.title]);
  return session.meeting ? (
    <MeetingPage key={session.sessionId} session={session} />
  ) : (
    <WorkSessionPage />
  );
}

function WorkSessionPage() {
  const services = useServices();
  const dock = useRef<DockWorkbenchHandle | null>(null);
  const documents =
    services.mode === 'server' && services.workspaces
      ? documentStore(services.workspaces)
      : undefined;
  const { session, corrals } = sessionRoute.useLoaderData();
  const search = sessionRoute.useSearch();
  const router = useRouter();
  const { runs, active, refresh, lost, listed, sessionReads } = useSessionRuns(
    session.sessionId,
    search.run,
    session.revision,
    session.entries,
  );
  useEffect(() => setCurrentProject(session.projectId), [session.projectId]);
  const team = corrals.find((c) => c.corralId === session.corralId) ?? null;
  const { binding } = useBinding(session.projectId);
  const [pendingReference, setReference] = useState<{
    sessionId: string;
    value: FileReference;
  } | null>(null);
  const reference =
    pendingReference?.sessionId === session.sessionId ? pendingReference.value : null;

  // The conversation's runs, oldest first, once a listing asked since entering it answered; kept
  // while later listings (asked for another run) are on their way.
  const runIdsKey = runs.map((run) => run.runId).join(',');
  const [latched, setLatched] = useState<{ sessionId: string; ids: string[] } | null>(null);
  useEffect(() => {
    if (!listed) return;
    setLatched((previous) =>
      previous?.sessionId === session.sessionId && previous.ids.join(',') === runIdsKey
        ? previous
        : { sessionId: session.sessionId, ids: runIdsKey ? runIdsKey.split(',') : [] },
    );
  }, [listed, runIdsKey, session.sessionId]);
  const runIds = latched?.sessionId === session.sessionId ? latched.ids : null;

  // The work area's width: given (tests), else as the frame measures it.
  const given = useGivenWorkAreaWidth();
  const [measured, setMeasured] = useState<number | null>(null);
  const workArea = given ?? measured;
  const [rememberedWidth, setRememberedWidth] = useState(() => readPanelWidth(deviceStorage()));

  const [tray] = useState(createPendingTrayStore);
  const [adviceRequest, setAdviceRequest] = useState<AdviceRequest | null>(null);
  // The conversation's terminals, read once on entry (features/session-panel.md 터미널 탭).
  const terminals =
    services.mode === 'server' && services.terminals ? terminalStore(services.terminals) : null;
  const terminalList = useTerminalList(session.sessionId, terminals);
  // The bottom dock's part, made further down: what an address the dock opens is handed to.
  const dockAreaRef = useRef<ReturnType<typeof useSessionDockArea> | null>(null);
  const frame = usePanelFrame({
    sessionId: session.sessionId,
    search,
    workArea,
    folder: Boolean(binding),
    runIds,
    paddock: Boolean(terminals && terminalList.value?.list?.target),
    terminalIds: terminalList.answer.kind === 'answered' ? terminalList.answer.ids : null,
    onDockAddress: (target, focus) => dockAreaRef.current?.openAddressed(target, focus),
    onBringForward: (arrived) => {
      if (arrived.respond) revealPendingTray(tray, session.sessionId);
      // The frame consumes `advice` from the address as it brings the conversation forward: the
      // arrival is taken from here, never from a later read of the address.
      const runId = arrived.advice;
      if (runId) setAdviceRequest((previous) => ({ runId, n: (previous?.n ?? 0) + 1 }));
    },
    // A link that opens or selects a tab is an opening way: the focus goes as open() sends it,
    // and closing the panel gives it back to the link. A link inside the panel opens no panel and
    // leaves what opened it as it is. A link that opens or selects nothing moves no focus.
    onOpenedByLink: (arrived, next, before) => {
      if (!namesSelected(arrived, next)) return;
      rememberOpener();
      if (!panelOnScreen(next.presentation)) return;
      focusOpened(arrived, next, before);
    },
  });
  const { state, ctx, fronts } = frame;
  // The panel as it stands now, for the steps that go on after a wait (a terminal's fresh read).
  const panelNow = useRef(state);
  panelNow.current = state;
  const operable = conversationOperable(state.presentation);
  const onScreen = panelOnScreen(state.presentation);
  // Each run's name in the "+" list's run history: its request, else its team.
  const runNames = useRunNames(runs, session.entries);

  // Focus: an opened tab takes it; a panel or drawer leaving with it gives it back.
  const strip = useRef<TabsClosableHandle>(null);
  const side = useRef<HTMLElement | null>(null);
  // What opened the panel, and in which conversation: one opened elsewhere is not this one's
  // (features/session-panel.md 접근성).
  const opener = useRef<{ sessionId: string; element: HTMLElement } | null>(null);
  /** Where focus goes after the next change: the selected tab, or a tab or the list after a close. */
  const focusNext = useRef<
    'tab' | { closed: TabKey | 'selected' | 'list' } | { removed: Element } | null
  >(null);
  const rememberOpener = () => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !side.current?.contains(focused)
    )
      opener.current = { sessionId: session.sessionId, element: focused };
  };
  // The composer's whole-run confirmation is modal: while it is up, nothing the person does to the
  // panel (an opening way, the palette, the strip, the toggle, its shortcut) changes it. Back and
  // Forward still go (features/session-panel.md 실행 조작이 서는 곳). The global shortcuts are held
  // back first (CommandPalette.tsx); this is the second line, for ways that are not shortcuts.
  const heldByConfirmation = modalConfirmationOpen;
  const open = (
    target: Partial<SessionSearch> & { panel: SessionPanel },
    from: 'way' | 'plus' = 'way',
  ) => {
    if (heldByConfirmation()) return;
    const { panel, run, terminal, ...inner } = target;
    dockAreaRef.current?.cancelPending();
    // The debugger, and a terminal whose tab is not in the panel, open in the bottom dock.
    if (
      panel === 'debug' ||
      (panel === 'terminal' &&
        !(terminal && panelNow.current.tabs.some((tab) => tabKey(tab) === `terminal:${terminal}`)))
    ) {
      dockAreaRef.current?.openAddressed({ panel, terminal }, true);
      return;
    }
    rememberOpener();
    const tab = targetTab({ panel, run, terminal }, ctx.runIds);
    const own = Object.values(inner).some((value) => value !== undefined)
      ? inner
      : tab
        ? frame.tabSearch(tabKey(tab))
        : undefined;
    const before = panelNow.current;
    const { state: next } = frame.dispatch(
      {
        type: 'open',
        target: { panel, ...(run ? { run } : {}), ...(terminal ? { terminal } : {}) },
        from,
      },
      own,
    );
    focusOpened({ panel, terminal }, next, before);
  };
  /** Where the focus goes once a way opened `next`: its tab, or the place inside it it names. */
  const focusOpened = (target: Partial<SessionSearch>, next: PanelState, before: PanelState) => {
    // A way that opened or selected nothing it names (a run tab with no run) moves no focus.
    if (!namesSelected(target, next)) return;
    // A way that names the terminal or Git puts the focus in the terminal or the commit message
    // once its tab shows it; without one the focus stays on the tab.
    if (target.panel === 'terminal' && target.terminal) focusTerminal(target.terminal);
    if (target.panel === 'git')
      focusPlace('changes', (content) => content.querySelector<HTMLElement>('#git-commit-message'));
    if (
      next.presentation !== before.presentation ||
      next.selected !== before.selected ||
      next.tabs.length !== before.tabs.length
    ) {
      focusNext.current = 'tab';
      return;
    }
    // Nothing the focus effect watches changed (the tab was open and selected already): it will
    // not run, so the request is met now rather than left for a later, unrelated change. Focus
    // already inside that tab's content (a way pointing inside it) stays there.
    focusNext.current = null;
    const inside = next.selected
      ? document
          .getElementById(tabsClosableIds(PANEL_ID_PREFIX, next.selected).panel)
          ?.contains(document.activeElement)
      : false;
    if (next.selected && panelOnScreen(next.presentation) && !inside)
      strip.current?.focusTab(next.selected);
  };
  // A way that names a place inside a tab (the terminal, the commit message) waits for that
  // place to appear; one wait at a time, gone with a new request, the conversation or the page.
  // Each wait carries its conversation: leaving one ends only its own wait, not one the entry of
  // the next conversation has just started.
  const placeWait = useRef<{ sessionId: string; timer: number } | null>(null);
  const stopPlaceWait = useCallback((sessionId?: string) => {
    const wait = placeWait.current;
    if (!wait || (sessionId !== undefined && wait.sessionId !== sessionId)) return;
    window.clearTimeout(wait.timer);
    placeWait.current = null;
  }, []);
  useEffect(() => {
    const left = session.sessionId;
    return () => stopPlaceWait(left);
  }, [session.sessionId, stopPlaceWait]);
  const focusPlace = (tab: TabKey, find: (content: HTMLElement) => HTMLElement | null) => {
    stopPlaceWait();
    const sessionId = session.sessionId;
    let tries = 0;
    const attempt = () => {
      placeWait.current = null;
      const content = document.getElementById(tabsClosableIds(PANEL_ID_PREFIX, tab).panel);
      const place = content && !content.hidden ? find(content) : null;
      if (place) {
        // Only while the focus is still where the opening left it (the tab, the panel, the
        // page): the person may have gone on meanwhile.
        const focused = document.activeElement;
        if (!focused || focused === document.body || side.current?.contains(focused))
          place.focus({ preventScroll: true });
      } else if (++tries < 40)
        placeWait.current = { sessionId, timer: window.setTimeout(attempt, 50) };
    };
    placeWait.current = { sessionId, timer: window.setTimeout(attempt, 0) };
  };
  const focusTerminal = (terminalId: string) =>
    focusPlace(`terminal:${terminalId}`, (content) => {
      const screen = content.querySelector<HTMLElement>('[data-terminal-screen]');
      return screen ? (screen.querySelector<HTMLElement>('textarea') ?? screen) : null;
    });
  const bringForward = () => frame.dispatch({ type: 'bringForward' });
  const showPanel = (patch: Partial<SessionSearch>) => {
    if (patch.panel) open({ ...patch, panel: patch.panel });
    else bringForward();
  };
  const select = (key: TabKey) => {
    if (heldByConfirmation()) return;
    dockAreaRef.current?.cancelPending();
    frame.dispatch({ type: 'select', key }, frame.tabSearch(key) ?? {});
  };
  const close = (key: TabKey) => {
    if (heldByConfirmation()) return;
    dockAreaRef.current?.cancelPending();
    // Closing a terminal's tab ends its terminal, as its state says (features/session-panel.md
    // 터미널 탭); the tab goes once that is decided.
    if (key.startsWith('terminal:')) {
      void dockAreaRef.current?.closeTerminal(key.slice('terminal:'.length), () => closeTab(key));
      return;
    }
    closeTab(key);
  };
  /** Takes a tab out of the strip, the focus going on as a close sends it; ends nothing. */
  const closeTab = (key: TabKey) => {
    const state = panelNow.current;
    // Focus on the closing tab, on its close control or inside its content is one case: it goes
    // on to the tab selected next, or for a tab not selected to its neighbour in the strip, or to
    // the body's list when none is left. Anywhere else it stays (features/session-panel.md).
    const focused = document.activeElement;
    const keys = state.tabs.map(tabKey);
    const index = keys.indexOf(key);
    const ids = tabsClosableIds(PANEL_ID_PREFIX, key);
    // The strip's close control for this tab: two tabs can share a name ("실행"), not an id.
    const closeControl =
      [...(side.current?.querySelectorAll('[data-slot="tabs-closable-close"]') ?? [])].find(
        (control) => control.getAttribute('data-tab-id') === key,
      ) ?? null;
    const inClosing =
      focused !== null &&
      (document.getElementById(ids.tab)?.contains(focused) ||
        document.getElementById(ids.panel)?.contains(focused) ||
        closeControl === focused);
    if (inClosing) {
      const neighbour = keys[index + 1] ?? keys[index - 1];
      focusNext.current = {
        closed:
          keys.length === 1 ? 'list' : key === state.selected ? 'selected' : (neighbour ?? 'list'),
      };
    } else if (focused && side.current?.contains(focused)) {
      // A control of the panel (the head's "+" or 넓히기) that the close may take away.
      focusNext.current = { removed: focused };
    }
    frame.dispatch({ type: 'close', key });
  };
  const toggle = () => {
    if (heldByConfirmation()) return;
    dockAreaRef.current?.cancelPending();
    rememberOpener();
    frame.dispatch({ type: 'toggle' });
  };
  const presentation = state.presentation;
  // Whether the panel was on screen, and in which conversation: entering another conversation is
  // not closing a panel, so its first state here starts from nothing shown.
  const shown = useRef<{ sessionId: string; onScreen: boolean }>({
    sessionId: session.sessionId,
    onScreen,
  });
  useLayoutEffect(() => {
    // Runs again after an open or a close, whichever of these it changed.
    void presentation;
    void state.tabs.length;
    // Until the frame has entered this conversation, the state here is not its own (the empty
    // state of the commit that enters it): a focus asked for waits, and nothing was closed.
    if (!frame.entered) return;
    const was = shown.current.sessionId === session.sessionId && shown.current.onScreen;
    shown.current = { sessionId: session.sessionId, onScreen };
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'tab' && state.selected && onScreen) {
      strip.current?.focusTab(state.selected);
      return;
    }
    if (target && target !== 'tab' && 'removed' in target) {
      if (target.removed.isConnected) return;
      // The control went with the close: the input, if it can be used, then the selected tab,
      // then the sidebar's toggle (features/session-panel.md 접근성).
      const input = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-composer"] textarea',
      );
      if (operable && input && !input.disabled) input.focus();
      else if (state.selected && onScreen) strip.current?.focusTab(state.selected);
      else document.querySelector<HTMLElement>('.app-sidebar-trigger')?.focus();
      return;
    }
    if (target && target !== 'tab' && onScreen) {
      const next = target.closed === 'selected' ? state.selected : target.closed;
      if (next && next !== 'list') strip.current?.focusTab(next);
      else side.current?.querySelector<HTMLElement>('ul button')?.focus();
      return;
    }
    if (was && !onScreen) {
      const focused = document.activeElement;
      if (focused && focused !== document.body && !side.current?.contains(focused)) return;
      // Withdrawn for want of room, nothing was closed: the focus is handed on in the frame's
      // order, the input first (features/session-panel.md 접근성).
      if (presentation === 'withdrawn') {
        const input = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="chat-composer"] textarea',
        );
        if (input && !input.disabled) input.focus();
        else document.querySelector<HTMLElement>('.app-sidebar-trigger')?.focus();
        return;
      }
      const own = opener.current?.sessionId === session.sessionId ? opener.current.element : null;
      const back =
        own?.isConnected && !side.current?.contains(own)
          ? own
          : document.querySelector<HTMLElement>('[data-session-panel-toggle]');
      back?.focus();
    }
  }, [
    presentation,
    state.selected,
    state.tabs.length,
    onScreen,
    operable,
    frame.entered,
    session.sessionId,
  ]);

  // Documents and panes asked for before the 파일 tab's dock is ready wait for it. Readiness is
  // the dock's own: its handle is handed over again on every render, so a null between two
  // handles says nothing about it.
  // What is queued for the dock is dropped when the conversation changes. A caller that arrives
  // after its own wait (a document still opening) is not checked here.
  const dockQueue = useRef<{ sessionId: string; action: (handle: DockWorkbenchHandle) => void }[]>(
    [],
  );
  const queuedFor = useRef(session.sessionId);
  queuedFor.current = session.sessionId;
  useEffect(() => {
    void session.sessionId;
    return () => {
      dockQueue.current = [];
    };
  }, [session.sessionId]);
  const withDock = (action: (handle: DockWorkbenchHandle) => void) => {
    const handle = dock.current;
    if (handle?.ready()) action(handle);
    else dockQueue.current.push({ sessionId: session.sessionId, action });
  };
  const flushDock = () => {
    const handle = dock.current;
    if (!handle) return;
    for (const queued of dockQueue.current.splice(0))
      if (queued.sessionId === queuedFor.current) queued.action(handle);
  };

  const trayContext = useMemo(
    () => ({
      store: tray,
      respond: () => {
        frame.dispatch({ type: 'bringForward' });
        revealPendingTray(tray, session.sessionId);
      },
    }),
    [tray, session.sessionId, frame.dispatch],
  );
  // A link to read an advice: the frame brings the conversation forward and lets the request go
  // from the address; the run's row holding it takes the arrival.
  const adviceArrival = useAdviceArrivalRequest(adviceRequest);
  const runStatus = runStatusOf(runs);
  const routeStop = () => {
    const route = stopCommandRoute(state, runStatus, active?.runId ?? null);
    if (!route) return false;
    if (route.at === 'run-tab') {
      askCancelConfirmation(route.runId);
      return true;
    }
    if (route.bringForward) bringForward();
    return false;
  };
  const currentTarget = useRef({
    hostId: services.workspaceId,
    projectId: session.projectId,
    sessionId: session.sessionId,
  });
  currentTarget.current = {
    hostId: services.workspaceId,
    projectId: session.projectId,
    sessionId: session.sessionId,
  };
  const contextMessages = useTranslations('Context');
  const tdock = useTranslations('Docking');
  const tpanel = useTranslations('SessionPanel');
  const subscribeGraphs = useCallback(
    (listener: () => void) => subscribeEditorCopies(services.repository, listener),
    [services.repository],
  );
  const [terminalSource, setTerminalSource] =
    useState<Extract<TextAttachmentProvenance, { kind: 'terminal' }>>();
  const handleAttachment = (attachment: TextAttachment, capture: AttachmentCapture) => {
    if (capture.target.hostId !== currentTarget.current.hostId)
      throw new Error(contextMessages('attachFailed'));
    const result = appendComposerAttachment(capture, attachment);
    if (!result.ok) throw new Error(contextMessages('attachFailed'));
    if (
      capture.target.sessionId === currentTarget.current.sessionId &&
      capture.target.projectId === currentTarget.current.projectId
    )
      bringForward();
  };
  const handleReference = (value: FileReference) => {
    setReference({ sessionId: session.sessionId, value });
    bringForward();
  };
  const openDocument = (document: DockOpenDocument, range?: TextRange) => {
    open({ panel: 'files' });
    withDock((handle) => handle.openDocument(document, range));
    return true;
  };
  const linkedRunIds = session.entries.flatMap((entry) => (entry.runId ? [entry.runId] : []));
  const sessionRuns = runs.filter(
    (run) => run.sessionId === session.sessionId || linkedRunIds.includes(run.runId),
  );
  const sessionRunIds = sessionRuns.map((run) => run.runId);
  // What the conversation presents never follows the address's run, which a run tab keeps.
  const { presentationRunId, liveRunId } = sessionRunViews(sessionRuns, linkedRunIds);
  const selectedKind = state.tabs.find((tab) => tabKey(tab) === state.selected)?.kind ?? null;
  const filesFront =
    search.panel && PANEL_TAB_OF[search.panel] === 'files' ? search.panel : undefined;
  const changesFront =
    search.panel && PANEL_TAB_OF[search.panel] === 'changes' ? search.panel : undefined;
  const panelViews: Record<'files' | 'checks' | 'problems', () => ReactNode> = {
    files: () => (
      <FilePanel
        projectId={session.projectId}
        sessionId={session.sessionId}
        runs={runs}
        onReference={handleReference}
        onAttach={handleAttachment}
        onOpenDocument={(document, range) => dock.current?.openDocument(document, range) ?? false}
      />
    ),
    checks: () => <ChecksPanel session={session} onAttach={handleAttachment} />,
    problems: () => <ProblemsPanel sessionId={session.sessionId} />,
  };
  const changesView = (requestedView: DockContextView) => {
    // Checks are a sub-view of Changes; Problems shows in its place.
    const auxiliary = requestedView === 'problems' ? requestedView : null;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div hidden={Boolean(auxiliary)} className="min-h-0 flex-1">
          <SessionChangesPanel
            session={session}
            visible={onScreen && selectedKind === 'changes'}
            copyChanged={runStates(runs)}
            reviewSearch={
              search.review && selectedKind === 'changes'
                ? { scope: search.scope, runId: search.runId, file: search.file }
                : undefined
            }
            requestedView={
              requestedView === 'checks' || requestedView === 'git' ? requestedView : undefined
            }
            onReviewChange={(review) =>
              frame.writeTab({
                panel: 'changes',
                review: review ? true : undefined,
                scope: review?.scope,
                runId: review?.runId,
                file: review?.file,
              })
            }
            onViewChange={(next) => {
              const view = next === 'checks' || next === 'git' ? next : 'changes';
              frame.writeTab({
                panel: view,
                review: undefined,
                scope: undefined,
                runId: undefined,
                file: undefined,
              });
            }}
            onAttach={handleAttachment}
            onSessionChange={async () => {
              refresh();
              await router.invalidate();
            }}
          />
        </div>
        {auxiliary ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">{panelViews[auxiliary]()}</div>
        ) : null}
      </div>
    );
  };
  const renderContext = (view: DockContextView) => {
    if (view === 'tools')
      return (
        <WorkbenchToolsPanel
          key={session.sessionId}
          sessionId={session.sessionId}
          projectId={session.projectId}
        />
      );
    if (view !== 'files') return null;
    const target = sessionPanelDescriptor(session.projectId, session.sessionId, view, null);
    return (
      <div
        key={target ? panelKey(services, target) : view}
        // The folder tree fills the pane's height.
        className="flex h-full min-h-0 flex-col gap-3 p-3"
      >
        {panelViews[view]()}
      </div>
    );
  };
  /** A terminal tab's screen, in the panel or the dock; its ⋯ moves it to the other. */
  const renderTerminal = (
    terminalId: string,
    strip: 'panel' | 'dock',
    move: () => void,
    exitToTab: () => void,
  ) =>
    terminals ? (
      <TerminalScreen
        store={terminals}
        sessionId={session.sessionId}
        terminalId={terminalId}
        documents={documents}
        move={{ to: strip === 'panel' ? 'dock' : 'panel', onMove: move }}
        onExitToTab={exitToTab}
        onAttach={handleAttachment}
        revealSource={
          terminalSource?.target.sessionId === session.sessionId &&
          terminalSource.terminalId === terminalId
            ? terminalSource
            : undefined
        }
      />
    ) : null;
  const renderTab = (tab: OpenTab) => {
    const selected = state.selected === tabKey(tab);
    if (tab.kind === 'terminal')
      return renderTerminal(
        tab.terminalId,
        'panel',
        () => dockAreaRef.current?.moveToDock(tab.terminalId),
        () => strip.current?.focusTab(tabKey(tab)),
      );
    if (tab.kind === 'files')
      return (
        <DockWorkbench
          key={`${services.workspaceId ?? services.mode}:${session.projectId}`}
          ref={(handle) => {
            dock.current = handle;
          }}
          hostId={services.workspaceId}
          projectId={session.projectId}
          sessionId={session.sessionId}
          {...(selected && onScreen ? { selectedPanel: filesFront ?? null } : {})}
          selectionKey={`${session.sessionId}:${JSON.stringify(search)}`}
          documentOwner={documents}
          renderContext={renderContext}
          onReady={flushDock}
          onOpenElsewhere={(view) => (view === 'chat' ? bringForward() : open({ panel: view }))}
          renderDocument={(descriptor, _panelId, selection) =>
            documents ? (
              <DockDocumentPanel
                owner={documents}
                target={descriptor.target}
                path={descriptor.path}
                viewId={descriptor.viewId}
                revealSelection={selection}
                onAttach={
                  descriptor.target.sessionId === session.sessionId ? handleAttachment : undefined
                }
                onReference={
                  descriptor.target.sessionId === session.sessionId ? handleReference : undefined
                }
              />
            ) : null
          }
          renderGraph={(descriptor) => <TeamDesign corralId={descriptor.corralId} />}
          graphTitle={(corralId) =>
            `${editorCopyDirty(services.repository, session.projectId, corralId) ? '● ' : ''}${
              corrals.find((c) => c.corralId === corralId)?.name ?? tdock('team')
            }`
          }
          subscribeGraphs={subscribeGraphs}
          onActiveContext={(view) => {
            const next = SESSION_PANELS.find((value) => value === view);
            if (!next || PANEL_TAB_OF[next] !== 'files') return;
            if (state.selected === 'files' && next !== search.panel)
              frame.writeTab({ panel: next }, { replace: true });
          }}
        />
      );
    if (tab.kind === 'changes')
      return changesView(
        selected ? (changesFront ?? fronts.changes ?? 'changes') : (fronts.changes ?? 'changes'),
      );
    if (tab.kind === 'artifacts')
      return (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ArtifactsPanel
            runs={runs}
            onOpen={(runId, result) => open({ panel: 'run', run: runId, view: 'results', result })}
          />
        </div>
      );
    if (tab.kind !== 'run') return null;
    // The address while it names this tab; otherwise what the address last gave it (a link, Back),
    // which it keeps while hidden (features/session-panel.md 닫기와 패널 여닫기).
    const addressed =
      selected && search.panel === 'run' && search.run === tab.runId
        ? search
        : (frame.tabSearch(tabKey(tab)) ?? null);
    return (
      <RunTab
        runId={tab.runId}
        selected={selected}
        carries={runControlPlace(state, runStatus).at === 'run-tab' && selected}
        operable={operable}
        activeTabbed={Boolean(
          active && state.tabs.some((open) => open.kind === 'run' && open.runId === active.runId),
        )}
        addressed={addressed}
        runs={runs}
        active={active}
        entries={session.entries}
        writeTab={frame.writeTab}
        onOpenRun={(runId) => open({ panel: 'run', run: runId })}
      />
    );
  };
  const sideWidth = workArea === null ? PANEL_MIN_WIDTH : panelWidth(workArea, rememberedWidth);
  const runActive = sessionRuns.some((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  const [mainElement, setMainElement] = useState<HTMLDivElement | null>(null);
  // The bottom dock (features/session-panel.md 하단 도크): its region, button and shortcut.
  const panelTerminals = state.tabs.flatMap((tab) =>
    tab.kind === 'terminal' ? [tab.terminalId] : [],
  );
  const shownTerminal =
    onScreen && state.selected?.startsWith('terminal:')
      ? state.selected.slice('terminal:'.length)
      : null;
  const dockArea = useSessionDockArea({
    sessionId: session.sessionId,
    store: terminals,
    list: terminalList,
    panel: {
      terminals: panelTerminals,
      shown: shownTerminal,
      open: (terminalId, from) => {
        if (heldByConfirmation()) return;
        rememberOpener();
        const before = panelNow.current;
        const { state: next } = frame.dispatch(
          { type: 'open', target: { panel: 'terminal', terminal: terminalId }, from },
          {},
        );
        focusOpened({ panel: 'terminal', terminal: terminalId }, next, before);
      },
      remove: (terminalId) => closeTab(`terminal:${terminalId}`),
    },
    runActive,
    trusted: Boolean(binding?.trusted),
    drawer: state.presentation === 'drawer',
    closeDrawer: () => frame.dispatch({ type: 'closeDrawer' }),
    held: heldByConfirmation,
    openChanges: () => open({ panel: 'changes' }),
    main: mainElement,
    renderTerminal,
    renderDebug: () => (
      // A stack frame opens its document in the panel; the focus stays here to keep stepping.
      <SourceNavigationContext.Provider
        value={{
          openDocument: (target, path, range) => {
            const kept = document.activeElement;
            frame.dispatch(
              { type: 'open', target: { panel: 'files' }, from: 'way' },
              frame.tabSearch('files') ?? {},
            );
            withDock((handle) => {
              handle.openDocument({ target, path, documentKey: documentKey(target, path) }, range);
              window.setTimeout(() => {
                if (kept instanceof HTMLElement && kept.isConnected)
                  kept.focus({ preventScroll: true });
              }, 0);
            });
            return true;
          },
          openTerminal: () => {},
        }}
      >
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <DebuggerPanel sessionId={session.sessionId} projectId={session.projectId} />
        </div>
      </SourceNavigationContext.Provider>
    ),
  });
  dockAreaRef.current = dockArea;

  return (
    <>
      {dockArea.endDialog}
      <SessionActions
        session={session}
        corrals={corrals}
        team={team}
        // No changes chip in the bar: changes are reached by the activity bar's chip and the 변경 tab.
        changes={null}
        panel={search.panel}
        onPanel={(value) => showPanel({ panel: value })}
        panelToggle={toggleAvailable(state, ctx) ? { pressed: onScreen, onToggle: toggle } : null}
        dockToggle={dockArea.toggle}
        onEditTeam={(corralId) => {
          open({ panel: 'files' });
          withDock((handle) => {
            handle.openGraph(corralId);
          });
          return true;
        }}
      />
      <ArchivedSessionNotice key={session.sessionId} session={session} />
      <QuickOpen
        key={`${session.projectId}:${session.sessionId}`}
        projectId={session.projectId}
        sessionId={session.sessionId}
        openDocument={openDocument}
        showInFiles={(request) => {
          requestFileReveal(request);
          open({ panel: 'files' });
          withDock((handle) => handle.openContext('files', true));
        }}
      />
      <SourceNavigationContext.Provider
        value={{
          openDocument: (target, path, range) =>
            openDocument({ target, path, documentKey: documentKey(target, path) }, range),
          openTerminal: (source) => {
            if (
              source.target.sessionId !== session.sessionId ||
              source.target.projectId !== session.projectId
            )
              throw new Error(contextMessages('unavailable'));
            setTerminalSource(source);
            open({ panel: 'terminal', terminal: source.terminalId });
          },
        }}
      >
        <ChatWidgetProvider
          sessionId={session.sessionId}
          presentationRunId={presentationRunId}
          live={Boolean(liveRunId)}
          runIds={sessionRunIds}
        >
          <PendingTrayContext.Provider value={trayContext}>
            <StopCommandContext.Provider value={routeStop}>
              <SidePanelFrame
                className="min-h-0 flex-1"
                presentation={state.presentation}
                sideLabel={tpanel('label')}
                sideWidth={sideWidth}
                drawerWidth={
                  workArea === null ? PANEL_MIN_WIDTH : drawerWidth(workArea, rememberedWidth)
                }
                onFrameWidthChange={setMeasured}
                sideRef={side}
                mainRef={setMainElement}
                {...dockArea.frame}
                resize={{
                  'aria-label': tpanel('width'),
                  min: PANEL_MIN_WIDTH,
                  max: Math.max(PANEL_MIN_WIDTH, (workArea ?? 0) - CONVERSATION_MIN_WIDTH),
                  onChange: setRememberedWidth,
                  onCommit: (px) => writePanelWidth(deviceStorage(), px),
                }}
                onEscape={() => {
                  if (!heldByConfirmation()) frame.dispatch({ type: 'closeDrawer' });
                }}
                onScrimPress={() => {
                  if (!heldByConfirmation()) frame.dispatch({ type: 'closeDrawer' });
                }}
                main={
                  <AdviceArrival.Provider
                    key={panelKey(services, {
                      kind: 'chat',
                      projectId: session.projectId,
                      sessionId: session.sessionId,
                    })}
                    value={adviceArrival}
                  >
                    {/* While the changes tab is on screen it says the change count, not the bar. */}
                    <ChangesTabShownContext.Provider
                      value={state.selected === 'changes' && onScreen}
                    >
                      <SessionChat
                        key={panelKey(services, {
                          kind: 'chat',
                          projectId: session.projectId,
                          sessionId: session.sessionId,
                        })}
                        connection={{ lost, retry: refresh }}
                        session={session}
                        team={team}
                        corrals={corrals}
                        runs={runs}
                        active={active}
                        liveRunId={liveRunId}
                        conversationInoperable={!operable}
                        onChange={refresh}
                        sessionReads={sessionReads}
                        runsListed={listed}
                        reference={reference}
                        onReferenceUsed={() => setReference(null)}
                        onPanel={(value, run) => open({ ...run, panel: value })}
                        // The conversation's place only: no history entry, no other view.
                        onPlace={(message) => frame.writeTab({ message }, { replace: true })}
                      />
                    </ChangesTabShownContext.Provider>
                  </AdviceArrival.Provider>
                }
                side={
                  <SessionPanelSide
                    sessionId={session.sessionId}
                    state={state}
                    ctx={ctx}
                    strip={strip}
                    onSelect={select}
                    onClose={close}
                    runs={runs}
                    runNames={runNames}
                    onPlus={(item) => open(plusTarget(item, ctx), 'plus')}
                    terminalRow={dockArea.terminalRow}
                    onTerminal={(shellId) => dockArea.onPlusTerminal('panel', shellId)}
                    onOpenRun={(runId) => open({ panel: 'run', run: runId }, 'plus')}
                    onMaximize={() => {
                      if (!heldByConfirmation()) frame.dispatch({ type: 'maximize' });
                    }}
                    renderTab={renderTab}
                  />
                }
              />
            </StopCommandContext.Provider>
          </PendingTrayContext.Provider>
        </ChatWidgetProvider>
      </SourceNavigationContext.Provider>
    </>
  );
}

/** A run tab: one run's record. Its views follow the address while it is the one selected. */
function RunTab({
  runId,
  selected,
  carries,
  operable,
  activeTabbed,
  addressed,
  runs,
  active,
  entries,
  writeTab,
  onOpenRun,
}: {
  runId: string;
  selected: boolean;
  carries: boolean;
  operable: boolean;
  activeTabbed: boolean;
  /** The address while it names this tab, else what the address last gave it; null if nothing. */
  addressed: SessionSearch | null;
  runs: RunSummary[];
  active: RunSummary | null;
  entries: WorkSession['entries'];
  writeTab: (patch: Partial<SessionSearch>, options?: { replace?: boolean }) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [own, setOwn] = useState<SessionSearch>({});
  const search = addressed ?? own;
  return (
    <RunHeadControlsContext.Provider value={carries}>
      <RunPanel
        runId={runId}
        runs={runs}
        active={active}
        entries={entries}
        search={search}
        setSearch={(patch, options) => {
          setOwn((current) => ({ ...current, ...patch }));
          if (selected) writeTab({ panel: 'run', run: runId, ...patch }, options);
        }}
        operable={operable}
        activeTabbed={activeTabbed}
        onOpenRun={onOpenRun}
      />
    </RunHeadControlsContext.Provider>
  );
}

/** Each run of the session with its state: it changes when a run starts or ends. */
const runStates = (runs: readonly RunSummary[]) =>
  runs.map((run) => `${run.runId}:${run.status}`).join(',');
