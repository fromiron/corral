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
import { panelKey, SESSION_PANELS, type SessionPanel } from '../workbench/panels/registry.ts';
import { type SessionSearch, sessionPanelDescriptor } from '../workbench/panels/routes.ts';

export type { SessionPanel } from '../workbench/panels/registry.ts';
export { Composer } from '../workbench/session/Composer.tsx';

import { useServices } from '../services.tsx';
import { ArchivedSessionNotice } from '../workbench/ArchivedSessionNotice.tsx';
import { AdviceArrival, useAdviceArrivalRequest } from '../workbench/adviceArrival.ts';
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
  panelOnScreen,
  runPickerVisible,
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
import {
  createPendingTrayStore,
  PendingTrayContext,
  revealPendingTray,
} from '../workbench/session/PendingTray.tsx';
import { SessionActions } from '../workbench/session/SessionActions.tsx';
import { SessionChat } from '../workbench/session/SessionChat.tsx';
import { PANEL_ID_PREFIX, SessionPanelSide } from '../workbench/session/SessionPanelSide.tsx';
import { ArtifactsPanel, ChecksPanel, RunPanel } from '../workbench/session/SessionPanels.tsx';
import { TerminalActivity, TerminalPanel } from '../workbench/TerminalPanel.tsx';
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
  const frame = usePanelFrame({
    sessionId: session.sessionId,
    search,
    workArea,
    folder: Boolean(binding),
    runIds,
    onBringForward: (arrived) => {
      if (arrived.respond) revealPendingTray(tray, session.sessionId);
    },
  });
  const { state, ctx, fronts } = frame;
  const operable = conversationOperable(state.presentation);
  const onScreen = panelOnScreen(state.presentation);

  // Focus: an opened tab takes it; a panel or drawer leaving with it gives it back.
  const strip = useRef<TabsClosableHandle>(null);
  const side = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
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
      opener.current = focused;
  };
  const open = (
    target: Partial<SessionSearch> & { panel: SessionPanel },
    from: 'way' | 'plus' = 'way',
  ) => {
    const { panel, run, ...inner } = target;
    rememberOpener();
    const tab = targetTab({ panel, run }, ctx.runIds);
    const own = Object.values(inner).some((value) => value !== undefined)
      ? inner
      : tab
        ? frame.tabSearch(tabKey(tab))
        : undefined;
    focusNext.current = 'tab';
    const { state: next } = frame.dispatch(
      { type: 'open', target: { panel, ...(run ? { run } : {}) }, from },
      own,
    );
    // Nothing the focus effect watches changed (the tab was open and selected already): it will
    // not run, so the request is met now rather than left for a later, unrelated change. Focus
    // already inside that tab's content (a way pointing inside it) stays there.
    if (
      next.presentation === state.presentation &&
      next.selected === state.selected &&
      next.tabs.length === state.tabs.length
    ) {
      focusNext.current = null;
      const inside = next.selected
        ? document
            .getElementById(tabsClosableIds(PANEL_ID_PREFIX, next.selected).panel)
            ?.contains(document.activeElement)
        : false;
      if (next.selected && panelOnScreen(next.presentation) && !inside)
        strip.current?.focusTab(next.selected);
    }
  };
  const bringForward = () => frame.dispatch({ type: 'bringForward' });
  const showPanel = (patch: Partial<SessionSearch>) => {
    if (patch.panel) open({ ...patch, panel: patch.panel });
    else bringForward();
  };
  const select = (key: TabKey) =>
    frame.dispatch({ type: 'select', key }, frame.tabSearch(key) ?? {});
  const close = (key: TabKey) => {
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
    // The composer's confirmation is modal: while it is up the panel's controls do nothing.
    // A dialog on its way out (closed, ending its exit) no longer holds the screen.
    if (
      document.querySelector(
        '[data-slot="dialog-popup"]:not([data-closed]), [role="alertdialog"]:not([data-closed])',
      )
    )
      return;
    rememberOpener();
    frame.dispatch({ type: 'toggle' });
  };
  const presentation = state.presentation;
  const shown = useRef(onScreen);
  useLayoutEffect(() => {
    // Runs again after an open or a close, whichever of these it changed.
    void presentation;
    void state.tabs.length;
    const was = shown.current;
    shown.current = onScreen;
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
      const back =
        opener.current?.isConnected && !side.current?.contains(opener.current)
          ? opener.current
          : document.querySelector<HTMLElement>('[data-session-panel-toggle]');
      back?.focus();
    }
  }, [presentation, state.selected, state.tabs.length, onScreen, operable]);

  // Documents and panes asked for before the 파일 tab's dock is ready wait for it. Readiness is
  // the dock's own: its handle is handed over again on every render, so a null between two
  // handles says nothing about it.
  const dockQueue = useRef<((handle: DockWorkbenchHandle) => void)[]>([]);
  const withDock = (action: (handle: DockWorkbenchHandle) => void) => {
    const handle = dock.current;
    if (handle?.ready()) action(handle);
    else dockQueue.current.push(action);
  };
  const flushDock = () => {
    const handle = dock.current;
    if (!handle) return;
    for (const action of dockQueue.current.splice(0)) action(handle);
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
  // A link to read an advice brings the conversation, where its run's row holds it, forward;
  // the address lets the request go, so Back or a reload does not arrive again.
  const adviceArrival = useAdviceArrivalRequest(search.advice, {
    open: bringForward,
    consume: () => frame.writeTab({ advice: undefined }, { replace: true }),
  });
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
  const selectedKind = state.selected
    ? state.selected.startsWith('run:')
      ? 'run'
      : state.selected
    : null;
  const filesFront =
    search.panel && PANEL_TAB_OF[search.panel] === 'files' ? search.panel : undefined;
  const changesFront =
    search.panel && PANEL_TAB_OF[search.panel] === 'changes' ? search.panel : undefined;
  const panelViews: Record<'files' | 'debug' | 'checks' | 'problems', () => ReactNode> = {
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
    debug: () => <DebuggerPanel sessionId={session.sessionId} projectId={session.projectId} />,
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
            requestedView={requestedView === 'checks' ? 'checks' : undefined}
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
              const view = next === 'checks' ? 'checks' : 'changes';
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
    if (view === 'terminal')
      return (
        <TerminalPanel
          terminalId={search.terminal}
          runActive={sessionRuns.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))}
          key={session.sessionId}
          sessionId={session.sessionId}
          projectId={session.projectId}
          onAttach={handleAttachment}
          revealSource={
            terminalSource?.target.sessionId === session.sessionId ? terminalSource : undefined
          }
        />
      );
    if (view === 'tools')
      return (
        <WorkbenchToolsPanel
          key={session.sessionId}
          sessionId={session.sessionId}
          projectId={session.projectId}
        />
      );
    if (view !== 'files' && view !== 'debug') return null;
    const target = sessionPanelDescriptor(session.projectId, session.sessionId, view, null);
    return (
      <div
        key={target ? panelKey(services, target) : view}
        // The folder tree fills the pane's height.
        className={`flex flex-col gap-3 p-3 ${view === 'files' ? 'h-full min-h-0' : ''}`}
      >
        {panelViews[view]()}
      </div>
    );
  };
  const renderTab = (tab: OpenTab) => {
    const selected = state.selected === tabKey(tab);
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
          terminalStatus={<TerminalActivity sessionId={session.sessionId} />}
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
    const addressed = selected && search.panel === 'run' && search.run === tab.runId;
    return (
      <RunTab
        runId={tab.runId}
        selected={selected}
        carries={runControlPlace(state, runStatus).at === 'run-tab' && selected}
        picker={selected && runPickerVisible(state)}
        addressed={addressed ? search : null}
        runs={runs}
        active={active}
        entries={session.entries}
        writeTab={frame.writeTab}
        onOpenRun={(runId) => open({ panel: 'run', run: runId })}
      />
    );
  };
  const sideWidth = workArea === null ? PANEL_MIN_WIDTH : panelWidth(workArea, rememberedWidth);

  return (
    <>
      <SessionActions
        session={session}
        corrals={corrals}
        team={team}
        // No changes chip in the bar: changes are reached by the activity bar's chip and the 변경 tab.
        changes={null}
        panel={search.panel}
        onPanel={(value) => showPanel({ panel: value })}
        panelToggle={toggleAvailable(state, ctx) ? { pressed: onScreen, onToggle: toggle } : null}
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
                resize={{
                  'aria-label': tpanel('width'),
                  min: PANEL_MIN_WIDTH,
                  max: Math.max(PANEL_MIN_WIDTH, (workArea ?? 0) - CONVERSATION_MIN_WIDTH),
                  onChange: setRememberedWidth,
                  onCommit: (px) => writePanelWidth(deviceStorage(), px),
                }}
                onEscape={() => frame.dispatch({ type: 'closeDrawer' })}
                onScrimPress={() => frame.dispatch({ type: 'closeDrawer' })}
                main={
                  <AdviceArrival.Provider
                    key={panelKey(services, {
                      kind: 'chat',
                      projectId: session.projectId,
                      sessionId: session.sessionId,
                    })}
                    value={adviceArrival}
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
                    onPlus={(item) => open(plusTarget(item, ctx), 'plus')}
                    onMaximize={() => frame.dispatch({ type: 'maximize' })}
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
  picker,
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
  picker: boolean;
  /** The address, while it names this tab. */
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
        picker={picker}
        onOpenRun={onOpenRun}
      />
    </RunHeadControlsContext.Provider>
  );
}

/** Each run of the session with its state: it changes when a run starts or ends. */
const runStates = (runs: readonly RunSummary[]) =>
  runs.map((run) => `${run.runId}:${run.status}`).join(',');
