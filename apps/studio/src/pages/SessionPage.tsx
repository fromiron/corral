import type { FileChangeView } from '@corral/client';
import type { TextAttachment } from '@corral/contracts';
import { TERMINAL_RUN_STATUSES, type TextAttachmentProvenance } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { Button, fontWeights } from '@corral/react/design-kit';
import { X } from '@corral/react/icons';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { setCurrentProject } from '../projects.ts';
import { sessionRoute } from '../router.tsx';
import { panelKey, SESSION_PANELS, type SessionPanel } from '../workbench/panels/registry.ts';

import {
  patchSessionSearch,
  rememberedSessionView,
  resolveSessionSearch,
  type SessionSearch,
  sessionPanelDescriptor,
} from '../workbench/panels/routes.ts';

export type { SessionPanel } from '../workbench/panels/registry.ts';
export { Composer } from '../workbench/session/Composer.tsx';

import { useServices } from '../services.tsx';
import { ArchivedSessionNotice } from '../workbench/ArchivedSessionNotice.tsx';
import { AdviceArrival, useAdviceArrivalRequest } from '../workbench/adviceArrival.ts';
import { type AttachmentCapture, appendComposerAttachment } from '../workbench/context/bridge.ts';
import { SourceNavigationContext } from '../workbench/context/SourceAttachments.tsx';
import { DebuggerPanel } from '../workbench/DebuggerPanel.tsx';
import { DockDocumentPanel } from '../workbench/DockDocumentPanel.tsx';
import { DockWorkbench, type DockWorkbenchHandle } from '../workbench/docking/DockWorkbench.tsx';
import type { DockContextView } from '../workbench/docking/layout.ts';
import { documentKey, documentStore } from '../workbench/documents/store.ts';
import { editorCopyDirty, subscribeEditorCopies } from '../workbench/editorDraft.ts';
import { FilePanel, type FileReference } from '../workbench/FilePanel.tsx';
import { ProblemsPanel } from '../workbench/ProblemsPanel.tsx';
import { panelRunId } from '../workbench/panelRun.ts';
import { QuickOpen, requestFileReveal } from '../workbench/QuickOpen.tsx';
import { SessionChangesPanel } from '../workbench/SessionChangesPanel.tsx';
import {
  createPendingTrayStore,
  PendingTrayContext,
  revealPendingTray,
} from '../workbench/session/PendingTray.tsx';
import { SessionActions } from '../workbench/session/SessionActions.tsx';
import { SessionChat } from '../workbench/session/SessionChat.tsx';
import { ArtifactsPanel, ChecksPanel, RunPanel } from '../workbench/session/SessionPanels.tsx';
import { TerminalActivity, TerminalPanel } from '../workbench/TerminalPanel.tsx';
import { useSessionRuns } from '../workbench/useSessionRuns.ts';
import { WorkbenchToolsPanel } from '../workbench/WorkbenchToolsPanel.tsx';
import { ChatWidgetProvider } from '../workbench/widgets/useChatWidgets.tsx';
import { TeamDesign } from './EditorPage.tsx';
import { useBinding, WORKSPACE_CHANGED } from './FilesViews.tsx';
import { MeetingPage } from './MeetingPage.tsx';
import { useRemembered } from './Workbench.tsx';

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
  const dock = useRef<DockWorkbenchHandle>(null);
  const documents =
    services.mode === 'server' && services.workspaces
      ? documentStore(services.workspaces)
      : undefined;
  const { session, corrals } = sessionRoute.useLoaderData();
  const urlSearch = sessionRoute.useSearch();
  const [savedView, rememberView] = useRemembered<Record<string, unknown>>(
    `corral:session-view:v1:${session.sessionId}`,
    {},
  );
  const search = resolveSessionSearch(urlSearch, savedView);
  const viewKey = JSON.stringify(search);
  useEffect(() => {
    // Responding, or arriving to read an advice, is not a view to come back to.
    rememberView({ ...rememberedSessionView(JSON.parse(viewKey)) });
  }, [viewKey, rememberView]);
  const navigate = useNavigate({ from: '/sessions/$sessionId' });
  const urlViewKey = JSON.stringify(urlSearch);
  useEffect(() => {
    if (urlViewKey !== '{}') return;
    const current = JSON.parse(viewKey) as SessionSearch;
    // Give Back an explicit destination before remembered state changes with a result link.
    void navigate({
      search: () => (Object.keys(current).length ? current : { compose: true }),
      replace: true,
    });
  }, [urlViewKey, viewKey, navigate]);
  const router = useRouter();
  const { runs, active, refresh, lost, listed, sessionReads } = useSessionRuns(
    session.sessionId,
    search.run,
    session.revision,
    session.entries,
  );
  useEffect(() => setCurrentProject(session.projectId), [session.projectId]);
  const team = corrals.find((c) => c.corralId === session.corralId) ?? null;
  const panel = search.panel;
  const { binding } = useBinding(session.projectId);
  const [fileViewerOpen, rememberFileViewer] = useRemembered<boolean>(
    `corral:file-viewer:${session.projectId}`,
    false,
  );
  const [fileViewerVisited, setFileViewerVisited] = useState(false);
  const toggleFileViewer = (open: boolean) => {
    setFileViewerVisited(true);
    rememberFileViewer(open);
  };
  const [pendingReference, setReference] = useState<{
    sessionId: string;
    value: FileReference;
  } | null>(null);
  const reference =
    pendingReference?.sessionId === session.sessionId ? pendingReference.value : null;
  const setSearch = (patch: Partial<typeof search>, options?: { replace?: boolean }) => {
    const next = patchSessionSearch(search, patch);
    rememberView({ ...rememberedSessionView(next) });
    void navigate({ search: () => next, replace: options?.replace });
  };
  const showPanel = (patch: Partial<typeof search>) => {
    dock.current?.openContext(patch.panel ?? 'chat');
    setSearch(patch);
  };
  // The conversation's needed-now tray is the one place this session's waiting requests are
  // answered (workbench.md). A link marked to respond opens the conversation and brings the tray
  // into view with focus, once; the run record's Respond does the same.
  const [tray] = useState(createPendingTrayStore);
  const traySession = session.sessionId;
  const trayContext = useMemo(
    () => ({
      store: tray,
      respond: () => {
        dock.current?.openContext('chat', true);
        revealPendingTray(tray, traySession);
      },
    }),
    [tray, traySession],
  );
  const respondRequested = search.respond === true;
  // setSearch is rebuilt every render; the request is read once, when it arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on the request's arrival only
  useEffect(() => {
    if (!respondRequested) return;
    dock.current?.openContext('chat');
    revealPendingTray(tray, session.sessionId);
    setSearch({ panel: undefined, respond: undefined }, { replace: true });
  }, [respondRequested, tray]);
  // A link to read an advice brings the conversation, where its run's row holds it, to the front;
  // the address lets the request go, so Back or a reload does not arrive again.
  const adviceArrival = useAdviceArrivalRequest(search.advice, {
    open: () => dock.current?.openContext('chat'),
    consume: () => setSearch({ advice: undefined }, { replace: true }),
  });
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
      showPanel({ panel: undefined });
  };
  const handleReference = (value: FileReference) => {
    setReference({ sessionId: session.sessionId, value });
    showPanel({ panel: undefined });
  };
  const changes = useSessionChanges(session.sessionId, runs);
  const linkedRunIds = session.entries.flatMap((entry) => (entry.runId ? [entry.runId] : []));
  const sessionRuns = runs.filter(
    (run) => run.sessionId === session.sessionId || linkedRunIds.includes(run.runId),
  );
  const sessionRunIds = sessionRuns.map((run) => run.runId);
  const presentedRun =
    sessionRuns.find((run) => run.runId === search.run) ??
    sessionRuns.findLast((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ??
    sessionRuns.at(-1) ??
    null;
  const liveRun =
    presentedRun && !TERMINAL_RUN_STATUSES.has(presentedRun.status) ? presentedRun : null;
  const presentationRunId = presentedRun?.runId ?? linkedRunIds.at(-1) ?? null;
  const panelViews: Record<
    Exclude<SessionPanel, 'terminal' | 'tools' | 'changes' | 'git'>,
    () => ReactNode
  > = {
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
    artifacts: () => (
      <ArtifactsPanel
        runs={runs}
        onOpen={(runId, result) => showPanel({ panel: 'run', run: runId, view: 'results', result })}
      />
    ),
    checks: () => <ChecksPanel session={session} onAttach={handleAttachment} />,
    problems: () => <ProblemsPanel sessionId={session.sessionId} />,
    run: () => (
      <RunPanel
        runs={runs}
        listed={listed}
        entries={session.entries}
        search={search}
        setSearch={setSearch}
      />
    ),
  };
  const renderContext = (view: DockContextView, requestedView: DockContextView = view) => {
    if (view === 'chat')
      return (
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
            liveRunId={liveRun?.runId ?? null}
            selectedRunId={presentationRunId}
            onChange={refresh}
            sessionReads={sessionReads}
            runsListed={listed}
            reference={reference}
            onReferenceUsed={() => setReference(null)}
            onPanel={(value, run) => showPanel({ panel: value, ...run })}
            // The conversation's place only: no history entry, no other view.
            onPlace={(message) => setSearch({ message }, { replace: true })}
          />
        </AdviceArrival.Provider>
      );
    if (view === 'changes' || view === 'git') {
      // Checks are a sub-view of Changes; Problems still opens beside it.
      const auxiliary = requestedView === 'problems' ? requestedView : null;
      return (
        <div key={session.sessionId} className="flex h-full min-h-0 flex-col">
          <div hidden={Boolean(auxiliary)} className="min-h-0 flex-1">
            <SessionChangesPanel
              session={session}
              visible={panel === 'changes' || panel === 'git' || panel === 'checks'}
              copyChanged={runStates(runs)}
              reviewSearch={
                search.review
                  ? { scope: search.scope, runId: search.runId, file: search.file }
                  : undefined
              }
              requestedView={requestedView === 'checks' ? 'checks' : undefined}
              onReviewChange={(review) =>
                setSearch({
                  panel: 'changes',
                  review: review ? true : undefined,
                  scope: review?.scope,
                  runId: review?.runId,
                  file: review?.file,
                })
              }
              onViewChange={(next) =>
                setSearch({
                  panel: next === 'checks' ? 'checks' : 'changes',
                  review: undefined,
                  scope: undefined,
                  runId: undefined,
                  file: undefined,
                })
              }
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
    }
    if (view === 'run') {
      const results = requestedView === 'artifacts';
      return (
        <div key={session.sessionId} className="flex h-full min-h-0 flex-col">
          <div hidden={results} className="min-h-0 flex-1">
            {panelViews.run()}
          </div>
          {results ? (
            <div className="min-h-0 flex-1 overflow-auto p-3">{panelViews.artifacts()}</div>
          ) : null}
        </div>
      );
    }
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
    const target = sessionPanelDescriptor(
      session.projectId,
      session.sessionId,
      view,
      panelRunId(runs, search.run, listed),
    );
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

  return (
    <>
      <SessionActions
        session={session}
        corrals={corrals}
        team={team}
        // The Changes tab carries the count (DockTopBar); the bar does not repeat it as a chip.
        changes={null}
        panel={panel}
        onPanel={(value) => showPanel({ panel: value })}
        fileViewerOpen={fileViewerOpen}
        onToggleFileViewer={toggleFileViewer}
        onEditTeam={(corralId) => dock.current?.openGraph(corralId) ?? false}
      />
      <ArchivedSessionNotice key={session.sessionId} session={session} />
      <QuickOpen
        key={`${session.projectId}:${session.sessionId}`}
        projectId={session.projectId}
        sessionId={session.sessionId}
        openDocument={(document) => dock.current?.openDocument(document) ?? false}
        showInFiles={(request) => {
          requestFileReveal(request);
          dock.current?.openContext('files', true);
        }}
      />
      <SourceNavigationContext.Provider
        value={{
          openDocument: (target, path, range) =>
            dock.current?.openDocument(
              { target, path, documentKey: documentKey(target, path) },
              range,
            ) ?? false,
          openTerminal: (source) => {
            if (
              source.target.sessionId !== session.sessionId ||
              source.target.projectId !== session.projectId
            )
              throw new Error(contextMessages('unavailable'));
            setTerminalSource(source);
            showPanel({ panel: 'terminal', terminal: source.terminalId });
          },
        }}
      >
        <ChatWidgetProvider
          sessionId={session.sessionId}
          presentationRunId={presentationRunId}
          live={Boolean(liveRun)}
          runIds={sessionRunIds}
        >
          <PendingTrayContext.Provider value={trayContext}>
            <div className="flex h-full min-h-0 min-w-0 flex-1">
              <div
                className={`flex min-h-0 min-w-0 flex-1 flex-col ${fileViewerOpen ? 'max-lg:hidden' : ''}`}
              >
                <DockWorkbench
                  key={`${services.workspaceId ?? services.mode}:${session.projectId}`}
                  ref={dock}
                  hostId={services.workspaceId}
                  projectId={session.projectId}
                  sessionId={session.sessionId}
                  selectedPanel={panel ?? null}
                  fileWorkAvailable={Boolean(binding)}
                  changeCount={changes?.length ?? 0}
                  selectionKey={`${session.sessionId}:${viewKey}`}
                  documentOwner={documents}
                  terminalStatus={<TerminalActivity sessionId={session.sessionId} />}
                  renderContext={renderContext}
                  renderDocument={(descriptor, _panelId, selection) =>
                    documents ? (
                      <DockDocumentPanel
                        owner={documents}
                        target={descriptor.target}
                        path={descriptor.path}
                        viewId={descriptor.viewId}
                        revealSelection={selection}
                        onAttach={
                          descriptor.target.sessionId === session.sessionId
                            ? handleAttachment
                            : undefined
                        }
                        onReference={
                          descriptor.target.sessionId === session.sessionId
                            ? handleReference
                            : undefined
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
                    const next =
                      view === 'chat' ? undefined : SESSION_PANELS.find((value) => value === view);
                    if ((view === 'chat' || next) && next !== panel) setSearch({ panel: next });
                  }}
                />
              </div>
              {fileViewerOpen || fileViewerVisited ? (
                <aside
                  hidden={!fileViewerOpen}
                  aria-label={tdock('fileViewer')}
                  className="min-h-0 w-96 max-w-full shrink-0 overflow-auto border-l border-line p-3 max-lg:w-full"
                >
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2
                      className="text-subtitle"
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {tdock('fileViewer')}
                    </h2>
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={tdock('closeFileViewer')}
                      onClick={() => toggleFileViewer(false)}
                    >
                      <X />
                    </Button>
                  </div>
                  <FilePanel
                    key={`${session.projectId}:${session.sessionId}:viewer`}
                    projectId={session.projectId}
                    sessionId={session.sessionId}
                    readOnly
                    onReference={handleReference}
                    onAttach={handleAttachment}
                  />
                </aside>
              ) : null}
            </div>
          </PendingTrayContext.Provider>
        </ChatWidgetProvider>
      </SourceNavigationContext.Provider>
    </>
  );
}

/** The session's changed files in its working copy, or null without one. */
/** Each run of the session with its state: it changes when a run starts or ends. */
const runStates = (runs: readonly RunSummary[]) =>
  runs.map((run) => `${run.runId}:${run.status}`).join(',');

function useSessionChanges(sessionId: string, runs: RunSummary[]) {
  const { workspaces } = useServices();
  const [files, setFiles] = useState<FileChangeView[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((n) => n + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  // Refresh when a run of the session starts or ends.
  const key = runStates(runs);
  useEffect(() => {
    void key;
    void tick;
    if (!workspaces) return;
    let live = true;
    // Without a working copy there is nothing to compare; asking would only be refused.
    void (async () => {
      const copy = await workspaces.worktree(sessionId).catch(() => null);
      if (!copy || copy.missing) return live && setFiles(null);
      const changes = await workspaces.changes(sessionId, { kind: 'session' });
      if (live) setFiles(changes.files);
    })().catch(() => live && setFiles(null));
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, key, tick]);
  return files;
}
