import type { TextAttachment, TextRange } from '@corral/contracts';
import { TERMINAL_RUN_STATUSES, type TextAttachmentProvenance } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { askCancelConfirmation } from '@corral/react';
import {
  Button,
  SidePanelFrame,
  type TabsClosableHandle,
  Tooltip,
  tabsClosableIds,
} from '@corral/react/design-kit';
import { X } from '@corral/react/icons';
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
import { setCurrentProject } from '../../projects.ts';
import { sessionRoute } from '../../router.tsx';
import { modalConfirmationOpen } from '../../workbench/modalConfirmation.ts';
import { panelKey, type SessionPanel } from '../../workbench/panels/registry.ts';
import { type SessionSearch, sessionPanelDescriptor } from '../../workbench/panels/routes.ts';

export type { SessionPanel } from '../../workbench/panels/registry.ts';
export { Composer } from '../../workbench/session/Composer.tsx';

import { useServices } from '../../services.tsx';
import { ArchivedSessionNotice } from '../../workbench/ArchivedSessionNotice.tsx';
import {
  AdviceArrival,
  type AdviceRequest,
  useAdviceArrivalRequest,
} from '../../workbench/adviceArrival.ts';
import {
  BrowserAnnotateProvider,
  BrowserAnnouncer,
  ComposerAnnotateContext,
  ComposerAnnotateRegistry,
  useBrowserAnnotate,
} from '../../workbench/browser/annotate.tsx';
import { BrowserTab } from '../../workbench/browser/BrowserTab.tsx';
import { BrowserTabsProvider, useBrowserTabs } from '../../workbench/browser/browserTabs.tsx';
import { type PreviewTabs, PreviewTabsContext } from '../../workbench/browser/previewTabs.tsx';
import { usePageHoldSwitch } from '../../workbench/browser/usePageStill.ts';
import {
  type AttachmentCapture,
  appendComposerAttachment,
} from '../../workbench/context/bridge.ts';
import { SourceNavigationContext } from '../../workbench/context/SourceAttachments.tsx';
import { DebuggerPanel } from '../../workbench/DebuggerPanel.tsx';
import { DocumentCloseDialog } from '../../workbench/documents/DocumentCloseDialog.tsx';
import {
  type CloseChoice,
  type DocumentStore,
  documentStore,
} from '../../workbench/documents/store.ts';
import {
  FilePanel,
  type FileReference,
  type OpenDocumentRequest,
} from '../../workbench/FilePanel.tsx';
import { forgetTreeState } from '../../workbench/fileTreeState.ts';
import { ProblemsPanel } from '../../workbench/ProblemsPanel.tsx';
import { deviceStorage } from '../../workbench/panel/memory.ts';
import {
  conversationOperable,
  DOCUMENT_LIMIT,
  documentLimitReached,
  type OpenTab,
  type PanelState,
  panelOnScreen,
  toggleAvailable,
  treeColumn,
} from '../../workbench/panel/model.ts';
import { runControlPlace, stopCommandRoute } from '../../workbench/panel/runControls.ts';
import {
  RunHeadControlsContext,
  StopCommandContext,
} from '../../workbench/panel/runHeadControls.ts';
import {
  type CopyIdentity,
  PANEL_TAB_OF,
  type PanelTab,
  plusTarget,
  type TabKey,
  tabKey,
  targetTab,
} from '../../workbench/panel/tabs.ts';
import { newBrowserId, runStatusOf, usePanelFrame } from '../../workbench/panel/usePanelFrame.ts';
import {
  CONVERSATION_MIN_WIDTH,
  drawerWidth,
  PANEL_MIN_WIDTH,
  panelWidth,
  readPanelWidth,
  writePanelWidth,
} from '../../workbench/panel/width.ts';
import { useGivenWorkAreaWidth } from '../../workbench/panel/workAreaWidth.ts';
import { sessionRunViews } from '../../workbench/panelRun.ts';
import { QuickOpen, requestFileReveal } from '../../workbench/QuickOpen.tsx';
import { SessionChangesPanel } from '../../workbench/SessionChangesPanel.tsx';
import { ChangesTabShownContext } from '../../workbench/session/ComposerActivity.tsx';
import { DocumentTab, documentViewId } from '../../workbench/session/DocumentTab.tsx';
import { documentTabFor } from '../../workbench/session/documentTarget.ts';
import { OriginalDocumentTab } from '../../workbench/session/OriginalDocumentTab.tsx';
import {
  createPendingTrayStore,
  PendingTrayContext,
  revealPendingTray,
} from '../../workbench/session/PendingTray.tsx';
import { SessionActions } from '../../workbench/session/SessionActions.tsx';
import { SessionChat } from '../../workbench/session/SessionChat.tsx';
import { PANEL_ID_PREFIX, SessionPanelSide } from '../../workbench/session/SessionPanelSide.tsx';
import {
  ArtifactsPanel,
  ChecksPanel,
  RunPanel,
  useRunNames,
} from '../../workbench/session/SessionPanels.tsx';
import { useSourceReread } from '../../workbench/session/sourceReread.ts';
import { useDocumentRestore } from '../../workbench/session/useDocumentRestore.ts';
import {
  type FocusTarget,
  useSessionDockArea,
} from '../../workbench/session/useSessionDockArea.tsx';
import { useUnsavedTabs } from '../../workbench/session/useUnsavedTabs.ts';
import { OpenTerminalContext } from '../../workbench/TerminalWriterNotice.tsx';
import { terminalStore } from '../../workbench/terminals/store.ts';
import { TerminalScreen } from '../../workbench/terminals/TerminalScreen.tsx';
import { useTerminalList } from '../../workbench/terminals/useTerminalList.ts';
import { useSessionRuns } from '../../workbench/useSessionRuns.ts';
import { WorkbenchToolsPanel } from '../../workbench/WorkbenchToolsPanel.tsx';
import { ChatWidgetProvider } from '../../workbench/widgets/useChatWidgets.tsx';
import { WORKSPACE_CHANGED } from '../../workbench/workspaceEvents.ts';
import { TeamDesign } from '../editor/EditorPage.tsx';
import { useBinding } from '../FilesViews.tsx';
import { MeetingPage } from '../meeting/MeetingPage.tsx';

// A work session: what was asked, the runs it started, the queue, and
// one input box whose intent is chosen, never guessed.

/**
 * Context panes follow the session URL; document tabs keep their explicit workspace target.
 * Stores own editing and execution state independently of dock placement.
 */
/** a meeting has its own chat; every other session keeps the work view. */
/** Whether the selected tab of `state` is the one a way's target names. */
/** The views of the 변경 tab: its own, Git, Checks, or Problems in their place. */
type ChangesView = 'changes' | 'git' | 'checks' | 'problems';

function namesSelected(
  target: Partial<SessionSearch> & { source?: 'original' },
  state: PanelState,
): boolean {
  const key = state.selected;
  if (!target.panel || !key) return false;
  const kind = PANEL_TAB_OF[target.panel];
  if (kind === null) return false;
  if (kind === 'terminal') return target.terminal ? key === `terminal:${target.terminal}` : false;
  // A 문서 or 팀 그래프 tab is named by its file or its design, not by its kind alone.
  if (kind === 'document' || kind === 'graph') {
    const source = target.source ?? (target.target === 'original' ? 'original' : undefined);
    const tab = targetTab({ ...target, panel: target.panel, ...(source ? { source } : {}) }, null);
    return tab ? key === tabKey(tab) : false;
  }
  // A browser tab is named by its ID; without one the way asked for a new tab (or a lease's).
  if (kind === 'browser')
    return target.browser ? key === `browser:${target.browser}` : key.startsWith('browser:');
  if (kind !== 'run') return key === kind;
  return target.run ? key === `run:${target.run}` : key.startsWith('run:');
}

/**
 * The conversation's ready preview leases from one listing after entering it, for the clean-up of
 * restored preview tabs (features/browser-tab.md 계약 "되살리기의 정리"); null until it answers,
 * and null when it could not be read, so the restored tabs stay. Only where the browser tab is.
 */
function useReadyLeases(sessionId: string): readonly string[] | null {
  const { workspaces, mode, browser } = useServices();
  const [read, setRead] = useState<{ sessionId: string; ids: string[] } | null>(null);
  useEffect(() => {
    if (!browser || !workspaces || mode !== 'server') return;
    let live = true;
    void workspaces.previews(sessionId).then(
      (items) => {
        if (live)
          setRead({
            sessionId,
            ids: items.filter((item) => item.state === 'ready').map((item) => item.leaseId),
          });
      },
      () => {},
    );
    return () => {
      live = false;
      // A later visit asks again: this one's answer is not its.
      setRead(null);
    };
  }, [browser, workspaces, mode, sessionId]);
  return read?.sessionId === sessionId ? read.ids : null;
}

/**
 * The conversation's Paddock as last read: `known` once a read answered, `copy` null without one.
 * Read on entering the conversation and again when a Paddock is made or removed.
 */
function useCurrentCopy(sessionId: string) {
  const { workspaces, mode } = useServices();
  const [read, setRead] = useState<{
    sessionId: string;
    copy: CopyIdentity | null;
  } | null>(null);
  useEffect(() => {
    if (!workspaces || mode !== 'server') return;
    let live = true;
    const ask = () =>
      void workspaces.worktree(sessionId).then(
        (copy) => {
          if (!live) return;
          setRead({
            sessionId,
            copy:
              copy && !copy.missing && !copy.removedAt
                ? { bindingId: copy.bindingId, generation: copy.copyGeneration }
                : null,
          });
        },
        () => {},
      );
    ask();
    window.addEventListener(WORKSPACE_CHANGED, ask);
    return () => {
      live = false;
      window.removeEventListener(WORKSPACE_CHANGED, ask);
    };
  }, [workspaces, mode, sessionId]);
  return read?.sessionId === sessionId
    ? { known: true as const, copy: read.copy }
    : { known: false as const, copy: null };
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
  const teamNames = Object.fromEntries(corrals.map((corral) => [corral.corralId, corral.name]));
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
  const sessionNow = useRef(session.sessionId);
  sessionNow.current = session.sessionId;
  // The conversation's Paddock as read since entering it: a 문서 tab belongs to it alone.
  const copyNow = useCurrentCopy(session.sessionId);
  const currentCopy = useRef(copyNow);
  currentCopy.current = copyNow;
  // The buffer each 문서 tab shows, once its file was read (its close asks the buffer).
  const documentKeys = useRef(new Map<TabKey, string>());
  // The place inside a file the last way to it named, for its tab to show.
  const [reveal, setReveal] = useState<{ sessionId: string; key: TabKey; range: TextRange }>();
  // A 문서 tab with changes not saved asking before it closes, and what its answer is doing.
  const [closing, setClosing] = useState<{
    sessionId: string;
    key: TabKey;
    buffer: string;
    path: string;
    busy: boolean;
    failed: boolean;
  } | null>(null);
  // The dialog closed because its tab did: the focus goes on as the tab's close sends it.
  const closedByDialog = useRef(false);
  // The tab last asked about, for the focus once the dialog is gone.
  const askedTab = useRef<TabKey | null>(null);
  if (closing) askedTab.current = closing.key;
  // A file refused for the 20 문서 tab limit: the panel says why until one of them closes.
  const [limited, setLimited] = useState<string | null>(null);
  // The last 문서 tab opened from the tree column, said politely; `n` says it again.
  const [opened, setOpened] = useState<{ sessionId: string; key: TabKey; n: number } | null>(null);
  // The bottom dock's part, made further down: what an address the dock opens is handed to.
  const dockAreaRef = useRef<ReturnType<typeof useSessionDockArea> | null>(null);
  const readyLeases = useReadyLeases(session.sessionId);
  const frame = usePanelFrame({
    sessionId: session.sessionId,
    search,
    workArea,
    rememberedWidth,
    folder: Boolean(binding),
    runIds,
    paddock: Boolean(terminals && terminalList.value?.list?.target),
    terminalIds: terminalList.answer.kind === 'answered' ? terminalList.answer.ids : null,
    corralIds: corrals.map((corral) => corral.corralId),
    browser: Boolean(services.browser),
    leaseIds: readyLeases,
    browserId: newBrowserId,
    onDockAddress: (target, focus) => dockAreaRef.current?.openAddressed(target, focus),
    // The tree shared by the 파일 tab and the tree column is one visit's.
    onEnter: forgetTreeState,
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
      if (!namesSelected(arrived, next) && !besideTheTree(arrived, next)) return;
      rememberOpener();
      if (!panelOnScreen(next.presentation)) return;
      focusOpened(arrived, next, before);
    },
  });
  const { state, ctx, fronts } = frame;
  const unsavedTabs = useUnsavedTabs({
    tabs: state.tabs,
    documents,
    repository: services.repository,
    hostId: services.workspaceId,
    projectId: session.projectId,
    sessionId: session.sessionId,
  });
  useDocumentRestore({
    sessionId: session.sessionId,
    projectId: session.projectId,
    hostId: services.workspaceId,
    workspaces: services.workspaces ?? undefined,
    documents,
    entered: frame.entered,
    state,
    copy: copyNow,
    dispatch: (event) => frame.dispatch(event),
    current: () => sessionNow.current,
  });
  useSourceReread({
    sessionId: session.sessionId,
    projectId: session.projectId,
    workspaces: services.workspaces ?? undefined,
    state,
    dispatch: (event) => frame.dispatch(event),
    current: () => sessionNow.current,
  });
  // The panel as it stands now, for the steps that go on after a wait (a terminal's fresh read).
  const panelNow = useRef(state);
  panelNow.current = state;
  const operable = conversationOperable(state.presentation);
  const onScreen = panelOnScreen(state.presentation);
  // Dragging the splitter, a browser tab's page is a picture until it is let go.
  const splitterDrag = usePageHoldSwitch();
  const browserTabs = useBrowserTabs({
    bridge: services.browser,
    sessionId: session.sessionId,
    projectId: session.projectId,
    state,
    onScreen,
    dispatch: (event) => frame.dispatch(event),
    current: () => sessionNow.current,
    newId: newBrowserId,
    stopPreview: (sessionId, leaseId) =>
      services.workspaces?.stopPreview(sessionId, leaseId) ?? Promise.resolve(),
  });
  // Browser annotation (features/browser-annotate.md): the mode and the overlay's context; the
  // composer publishes its draft's side through `composerAnnotate`.
  const [composerAnnotate] = useState(() => new ComposerAnnotateRegistry());
  const annotate = useBrowserAnnotate({
    bridge: services.browser,
    sessionId: session.sessionId,
    owns: (tabId) =>
      panelNow.current.tabs.some((tab) => tab.kind === 'browser' && tab.browserId === tabId),
    leaseOf: (tabId) => {
      const tab = panelNow.current.tabs.find(
        (open) => open.kind === 'browser' && open.browserId === tabId,
      );
      return tab?.kind === 'browser' ? (tab.lease ?? null) : null;
    },
    composer: composerAnnotate,
  });
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
  /**
   * An opening way. Returns whether it opened or chose the browser tab it asked for (a preview
   * lease's tab, `lease` being never part of the address); other ways answer false.
   */
  const open = (
    target: Partial<SessionSearch> & { panel: SessionPanel; lease?: string },
    from: 'way' | 'plus' | 'debugger' = 'way',
    place?: 'tree',
  ): boolean => {
    if (heldByConfirmation()) return false;
    const { panel, run, terminal, corral, lease, ...rest } = target;
    // A 문서 tab is named by its file (and its source): they are its identity, not its state.
    const documentTarget =
      panel === 'document' && rest.file
        ? {
            file: rest.file,
            ...(rest.target === 'original' ? { source: 'original' as const } : {}),
          }
        : {};
    const { file: _file, target: _source, ...named } = rest;
    const inner = panel === 'document' ? named : rest;
    dockAreaRef.current?.cancelPending();
    // The debugger, and a terminal whose tab is not in the panel, open in the bottom dock.
    if (
      panel === 'debug' ||
      (panel === 'terminal' &&
        !(terminal && panelNow.current.tabs.some((tab) => tabKey(tab) === `terminal:${terminal}`)))
    ) {
      dockAreaRef.current?.openAddressed({ panel, terminal }, true);
      return false;
    }
    rememberOpener();
    const tab = targetTab({ panel, run, terminal, corral, ...documentTarget }, ctx.runIds);
    const own = Object.values(inner).some((value) => value !== undefined)
      ? inner
      : tab
        ? frame.tabSearch(tabKey(tab))
        : undefined;
    const before = panelNow.current;
    const { state: next } = frame.dispatch(
      {
        type: 'open',
        target: {
          panel,
          ...(run ? { run } : {}),
          ...(terminal ? { terminal } : {}),
          ...(corral ? { corral } : {}),
          ...(lease && panel === 'browser' ? { lease } : {}),
          ...documentTarget,
        },
        from,
      },
      own,
    );
    const leaseTab =
      Boolean(lease) &&
      next.tabs.some(
        (tab) => tab.kind === 'browser' && tab.lease === lease && tabKey(tab) === next.selected,
      );
    // The debugger keeps the focus to go on stepping (features/session-panel.md 디버그와 문서).
    if (from === 'debugger') {
      focusNext.current = null;
      return leaseTab;
    }
    // A new browser tab has only its head: the focus goes to its address field
    // (features/browser-tab.md 여는 곳).
    const fresh = next.tabs.find(
      (tab) =>
        tab.kind === 'browser' &&
        !tab.lease &&
        tabKey(tab) === next.selected &&
        !before.tabs.some((old) => tabKey(old) === tabKey(tab)),
    );
    if (panel === 'browser' && fresh?.kind === 'browser') {
      focusNext.current = null;
      browserTabs?.pages.focusAddress(fresh.browserId);
      return leaseTab;
    }
    // Opened from the tree column, which stays beside the document: the focus stays on the row
    // and the opening is said instead (features/session-panel.md 파일 탭과 트리 열).
    if (place === 'tree' && next.selected !== 'files' && treeColumn(next, ctx)) {
      focusNext.current = null;
      const key = next.selected;
      if (key) setOpened((last) => ({ sessionId: session.sessionId, key, n: (last?.n ?? 0) + 1 }));
      return leaseTab;
    }
    focusOpened({ panel, terminal, corral, ...documentTarget }, next, before);
    return leaseTab;
  };
  // The 작업 tab's previews open in a preview tab where the desktop's browser tab is: one value
  // per conversation, opening through the latest `open`.
  const openNow = useRef(open);
  openNow.current = open;
  const previewTabs = useMemo<PreviewTabs | null>(
    () =>
      browserTabs
        ? {
            open: (leaseId, options) => {
              const opened = openNow.current({ panel: 'browser', lease: leaseId });
              if (opened && options?.started) browserTabs.started(leaseId);
              return opened;
            },
          }
        : null,
    [browserTabs],
  );
  /** A way to 파일 that, on a wide panel, selected the 문서 tab beside the tree column instead. */
  const besideTheTree = (target: Partial<SessionSearch>, next: PanelState) =>
    target.panel === 'files' && next.selected !== 'files' && treeColumn(next, ctx);
  /** Where the focus goes once a way opened `next`: its tab, or the place inside it it names. */
  const focusOpened = (
    target: Partial<SessionSearch> & { source?: 'original' },
    next: PanelState,
    before: PanelState,
  ) => {
    // A way to 파일 beside a 문서 tab on a wide panel selects the document, the tree its column:
    // the focus goes into the tree.
    if (besideTheTree(target, next)) {
      focusNext.current = null;
      focusPlace(
        'files',
        (content) =>
          content.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
          content.querySelector<HTMLElement>('input, button:not([disabled])'),
      );
      return;
    }
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
    // Where the opening found the focus: a link outside the panel, say.
    const from = document.activeElement;
    let tries = 0;
    const attempt = () => {
      placeWait.current = null;
      const content = document.getElementById(tabsClosableIds(PANEL_ID_PREFIX, tab).panel);
      const place = content && !content.hidden ? find(content) : null;
      if (place) {
        // Only while the focus is still where the opening left it (where it was, the tab, the
        // panel, the page): the person may have gone on meanwhile.
        const focused = document.activeElement;
        if (
          !focused ||
          focused === from ||
          focused === document.body ||
          side.current?.contains(focused)
        )
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
      void dockAreaRef.current?.closeTerminal(key.slice('terminal:'.length), (focused) =>
        closeTab(key, focused),
      );
      return;
    }
    // A 문서 tab's buffer decides: one with changes not saved asks first (features/session-panel.md
    // 문서 탭); the tab stays while it asks.
    if (key.startsWith('document:copy:') && documents) {
      const buffer = documentKeys.current.get(key);
      const path = key.slice('document:copy:'.length);
      if (buffer) {
        const from = session.sessionId;
        void documents.closeView(buffer, documentViewId(from, path)).then((result) => {
          if (sessionNow.current !== from) return;
          if (result === 'closed') closeTab(key, tabElement(key));
          else if (result === 'confirm')
            setClosing({ sessionId: from, key, buffer, path, busy: false, failed: false });
        });
        return;
      }
    }
    closeTab(key);
  };
  const tabElement = (key: TabKey) =>
    document.getElementById(tabsClosableIds(PANEL_ID_PREFIX, key).tab);
  /** The close confirmation's answer: keep editing, save and close, or discard and close. */
  const chooseClosing = async (choice: CloseChoice) => {
    const asked = closing;
    if (!asked || !documents) return;
    if (choice === 'cancel') return setClosing(null);
    setClosing({ ...asked, busy: true, failed: false });
    let result: Awaited<ReturnType<DocumentStore['closeView']>> | 'error';
    try {
      result = await documents.closeView(
        asked.buffer,
        documentViewId(asked.sessionId, asked.path),
        choice,
      );
    } catch {
      result = 'error';
    }
    if (sessionNow.current !== asked.sessionId) return;
    if (result === 'closed') {
      closedByDialog.current = true;
      setClosing(null);
      closeTab(asked.key, tabElement(asked.key));
    } else if (result === 'cancelled') setClosing(null);
    else setClosing({ ...asked, busy: false, failed: true });
  };
  /** Takes a tab out of the strip, the focus going on as a close sends it; ends nothing. */
  const closeTab = (key: TabKey, focused: Element | null = document.activeElement): FocusTarget => {
    const state = panelNow.current;
    // Focus on the closing tab, on its close control or inside its content is one case: it goes
    // on to the tab selected next, or for a tab not selected to its neighbour in the strip, or to
    // the body's list when none is left. Anywhere else it stays (features/session-panel.md).
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
    let target: FocusTarget = null;
    if (inClosing) {
      const neighbour = keys[index + 1] ?? keys[index - 1];
      const closed =
        keys.length === 1 ? 'list' : key === state.selected ? 'selected' : (neighbour ?? 'list');
      focusNext.current = { closed };
      target = () => {
        const next = closed === 'selected' ? panelNow.current.selected : closed;
        return next && next !== 'list'
          ? document.getElementById(tabsClosableIds(PANEL_ID_PREFIX, next).tab)
          : (side.current?.querySelector<HTMLElement>('ul button') ?? null);
      };
    } else if (focused && side.current?.contains(focused)) {
      // A control of the panel (the head's "+" or 넓히기) that the close may take away.
      focusNext.current = { removed: focused };
    }
    frame.dispatch({ type: 'close', key });
    // A closed 파일 tab keeps no screen state: opened again, its tree starts fresh.
    if (key === 'files') forgetTreeState(session.sessionId);
    return target;
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

  // The panel crossing 800px turns the tree between its 파일 tab and the column; the focus moves
  // only when it was in the place that goes (features/session-panel.md 파일 탭과 트리 열). This runs
  // before the frame hands the new width to the model, while the place is still on screen.
  const wide = Boolean(ctx.wide);
  const lastWide = useRef<{ sessionId: string; wide: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: crossing 800px is the trigger; the context and the select are read as they are then.
  useLayoutEffect(() => {
    const was = lastWide.current;
    lastWide.current = { sessionId: session.sessionId, wide };
    if (!frame.entered || !was || was.sessionId !== session.sessionId || was.wide === wide) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    const files = tabsClosableIds(PANEL_ID_PREFIX, 'files');
    const now = panelNow.current;
    if (!wide) {
      // Narrower, with the focus in the tree column: the tree is its tab again, and selected.
      if (now.selected === 'files' || !document.getElementById(files.panel)?.contains(focused))
        return;
      select('files');
      if (document.activeElement !== focused && focused.isConnected)
        focused.focus({ preventScroll: true });
      return;
    }
    // Wider, with the focus on the strip's 파일 tab: that tab leaves the strip, and the 문서 tab
    // selected in its place takes the focus.
    if (
      now.selected === 'files' &&
      treeColumn(now, ctx) &&
      document.getElementById(files.tab)?.contains(focused)
    )
      focusNext.current = 'tab';
  }, [wide, session.sessionId, frame.entered]);

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
  const tpanel = useTranslations('SessionPanel');
  const tdock = useTranslations('Docking');
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
  /**
   * A way to a file of the conversation's current copy opens its 문서 tab, at `range` when it
   * names one. A file of another conversation's copy, or of an earlier copy, has no tab here: it
   * is refused as unavailable, as a terminal outside the conversation is.
   */
  const openDocument = (
    request: Pick<OpenDocumentRequest, 'target' | 'path'> | { source: 'original'; path: string },
    range?: TextRange,
    options: { from?: 'debugger'; place?: 'tree' } = {},
  ) => {
    const { path } = request;
    const original = 'source' in request;
    const key = original
      ? (`document:original:${path}` as const)
      : documentTabFor(request.target, path, {
          projectId: session.projectId,
          sessionId: session.sessionId,
          current: currentCopy.current,
        });
    if (!key) throw new Error(contextMessages('unavailable'));
    const wanted: PanelTab = {
      kind: 'document',
      source: original ? 'original' : 'copy',
      path,
    };
    if (documentLimitReached(panelNow.current, wanted)) {
      // No tab opens; the panel says why, shown as the way would have shown the file.
      setLimited(session.sessionId);
      if (options.from !== 'debugger' && !panelOnScreen(panelNow.current.presentation))
        frame.dispatch({ type: 'toggle' });
      return true;
    }
    setLimited(null);
    if (range && !original) setReveal({ sessionId: session.sessionId, key, range });
    const kept = document.activeElement;
    open(
      { panel: 'document', file: path, ...(original ? { target: 'original' as const } : {}) },
      options.from ?? 'way',
      options.place,
    );
    if (options.from === 'debugger')
      window.setTimeout(() => {
        if (kept instanceof HTMLElement && kept.isConnected) kept.focus({ preventScroll: true });
      }, 0);
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
  const changesFront =
    search.panel && PANEL_TAB_OF[search.panel] === 'changes' ? search.panel : undefined;
  const panelViews: Record<'files' | 'checks' | 'problems', (headEnd?: ReactNode) => ReactNode> = {
    files: (headEnd) => (
      <FilePanel
        projectId={session.projectId}
        sessionId={session.sessionId}
        runs={runs}
        onReference={handleReference}
        onAttach={handleAttachment}
        onOpenDocument={(document, range) => openDocument(document, range, { place: 'tree' })}
        onOpenOriginal={(path) =>
          openDocument({ source: 'original', path }, undefined, { place: 'tree' })
        }
        headEnd={headEnd}
      />
    ),
    checks: () => <ChecksPanel session={session} onAttach={handleAttachment} />,
    problems: () => <ProblemsPanel sessionId={session.sessionId} />,
  };
  // The view in front inside 변경: one of its own, or its first.
  const changesWindow = (panel: SessionPanel | undefined): ChangesView =>
    panel === 'git' || panel === 'checks' || panel === 'problems' ? panel : 'changes';
  const changesView = (requestedView: ChangesView) => {
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
  /** The 파일 tab: the folder tree, filling the tab's height. */
  const renderFiles = (column = false) => {
    const target = sessionPanelDescriptor(session.projectId, session.sessionId, 'files', null);
    const closeFiles = tpanel('close', { name: tdock('files') });
    return (
      <div
        key={target ? panelKey(services, target) : 'files'}
        className="flex h-full min-h-0 flex-col gap-3 p-3"
      >
        {panelViews.files(
          // Beside a document the tree is a column: its own close closes 파일, and the focus goes
          // to the strip's selected document (features/session-panel.md 파일 탭과 트리 열).
          column ? (
            <Tooltip content={closeFiles}>
              <Button
                size="icon"
                variant="ghost"
                aria-label={closeFiles}
                onClick={() => {
                  close('files');
                  focusNext.current = 'tab';
                }}
              >
                <X />
              </Button>
            </Tooltip>
          ) : undefined,
        )}
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
  const renderTab = (tab: OpenTab, column = false) => {
    const selected = state.selected === tabKey(tab);
    if (tab.kind === 'terminal')
      return renderTerminal(
        tab.terminalId,
        'panel',
        () => dockAreaRef.current?.moveToDock(tab.terminalId),
        () => strip.current?.focusTab(tabKey(tab)),
      );
    if (tab.kind === 'files') return renderFiles(column);
    if (tab.kind === 'browser') return <BrowserTab tab={tab} visible={selected && onScreen} />;
    if (tab.kind === 'document')
      return tab.source === 'copy' && documents ? (
        <DocumentTab
          owner={documents}
          hostId={services.workspaceId}
          projectId={session.projectId}
          sessionId={session.sessionId}
          path={tab.path}
          copy={tab.copy}
          reveal={
            reveal?.sessionId === session.sessionId && reveal.key === tabKey(tab)
              ? reveal.range
              : undefined
          }
          onCopy={(copy) =>
            frame.dispatch({ type: 'documentCopy', key: tabKey(tab), instance: tab.instance, copy })
          }
          onKey={(key) => {
            if (key) documentKeys.current.set(tabKey(tab), key);
            else documentKeys.current.delete(tabKey(tab));
          }}
          onAttach={handleAttachment}
          onReference={handleReference}
        />
      ) : tab.source === 'original' ? (
        <OriginalDocumentTab
          projectId={session.projectId}
          sessionId={session.sessionId}
          path={tab.path}
          onReference={handleReference}
        />
      ) : null;
    if (tab.kind === 'changes')
      return changesView(
        changesWindow(selected ? (changesFront ?? fronts.changes) : fronts.changes),
      );
    // The team editor's own screen, without its trial run (features/canvas.md).
    if (tab.kind === 'graph')
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <TeamDesign corralId={tab.corralId} sessionId={session.sessionId} />
        </div>
      );
    if (tab.kind === 'tools')
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <WorkbenchToolsPanel
            sessionId={session.sessionId}
            projectId={session.projectId}
            view={tab.view}
            onViewChange={(view) => frame.dispatch({ type: 'toolsView', view })}
          />
        </div>
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
          openDocument: (target, path, range) =>
            openDocument({ target, path }, range, { from: 'debugger' }),
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
    <OpenTerminalContext.Provider
      value={(terminalId) => open({ panel: 'terminal', terminal: terminalId })}
    >
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
          open({ panel: 'graph', corral: corralId });
          return true;
        }}
      />
      <ArchivedSessionNotice key={session.sessionId} session={session} />
      {(() => {
        const asked = closing?.sessionId === session.sessionId ? closing : null;
        const entry = asked && documents ? documents.getState().documents[asked.buffer] : undefined;
        return (
          <DocumentCloseDialog
            path={asked ? asked.path.slice(asked.path.lastIndexOf('/') + 1) : null}
            busy={asked?.busy ?? false}
            failed={Boolean(asked?.failed || entry?.pendingSave)}
            saveDisabled={Boolean(entry?.pendingSave && !entry.canRetrySave)}
            discardDisabled={Boolean(entry?.pendingSave)}
            // Kept, the tab takes the focus back; closed, its close already sent it on.
            finalFocus={() => {
              if (closedByDialog.current) {
                closedByDialog.current = false;
                return false;
              }
              return (askedTab.current && tabElement(askedTab.current)) ?? false;
            }}
            onChoose={(choice) => void chooseClosing(choice)}
            onDismiss={() => setClosing(null)}
          />
        );
      })()}
      <QuickOpen
        key={`${session.projectId}:${session.sessionId}`}
        projectId={session.projectId}
        sessionId={session.sessionId}
        openDocument={(request) => openDocument(request)}
        showInFiles={(request) => {
          // A file of the source folder opens its read-only tab; a folder is shown in the tree.
          if (request.kind === 'file' && request.source === 'project') {
            openDocument({ source: 'original', path: request.path });
            return;
          }
          requestFileReveal(request);
          open({ panel: 'files' });
        }}
      />
      <SourceNavigationContext.Provider
        value={{
          openDocument: (target, path, range) => openDocument({ target, path }, range),
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
        <ComposerAnnotateContext.Provider value={composerAnnotate}>
          <BrowserAnnotateProvider value={annotate}>
            <BrowserAnnouncer annotate={annotate} />
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
                      onDragChange: splitterDrag,
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
                      <BrowserTabsProvider value={browserTabs}>
                        <PreviewTabsContext.Provider value={previewTabs}>
                          <SessionPanelSide
                            sessionId={session.sessionId}
                            teamNames={teamNames}
                            unsaved={unsavedTabs}
                            notice={
                              limited === session.sessionId &&
                              state.tabs.filter((tab) => tab.kind === 'document').length >=
                                DOCUMENT_LIMIT
                                ? tdock('tabLimit')
                                : null
                            }
                            opened={opened?.sessionId === session.sessionId ? opened : null}
                            state={state}
                            ctx={ctx}
                            strip={strip}
                            onSelect={select}
                            onClose={close}
                            onReorder={(key, toIndex) => {
                              if (!heldByConfirmation())
                                frame.dispatch({ type: 'reorder', key, toIndex });
                            }}
                            // Out by drag into the dock: as a close, ending nothing.
                            onMoveOut={(key) => closeTab(key)}
                            onMoveIn={(terminalId, index) =>
                              frame.dispatch({ type: 'moveIn', terminalId, index })
                            }
                            runs={runs}
                            runNames={runNames}
                            onPlus={(item) => open(plusTarget(item, ctx), 'plus')}
                            terminalRow={dockArea.terminalRow}
                            terminals={terminalList.value?.list?.terminals ?? []}
                            onTerminal={(shellId) => dockArea.onPlusTerminal('panel', shellId)}
                            onOpenRun={(runId) => open({ panel: 'run', run: runId }, 'plus')}
                            onMaximize={() => {
                              if (!heldByConfirmation()) frame.dispatch({ type: 'maximize' });
                            }}
                            renderTab={renderTab}
                          />
                        </PreviewTabsContext.Provider>
                      </BrowserTabsProvider>
                    }
                  />
                </StopCommandContext.Provider>
              </PendingTrayContext.Provider>
            </ChatWidgetProvider>
          </BrowserAnnotateProvider>
        </ComposerAnnotateContext.Provider>
      </SourceNavigationContext.Provider>
    </OpenTerminalContext.Provider>
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
