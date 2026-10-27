import {
  ApiError,
  type AutoCancelResult,
  type FileChangeView,
  type VoiceTranscript,
  type VoiceTranscriptReceipt,
} from '@corral/client';
import type { AutoModelChoice, TextAttachment } from '@corral/contracts';
import {
  IMAGE_MAX_COUNT,
  type ImageAttachment,
  ImageAttachments,
  PermissionMode,
  type RunReference,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
  TEXT_ATTACHMENT_MAX_COUNT,
  type TextAttachmentProvenance,
} from '@corral/contracts';
import type {
  AutoStartResult,
  CorralSummary,
  RunProjection,
  RunSummary,
  SessionEntry,
  SessionEntryAuto,
  SessionIntent,
  WorkSession,
} from '@corral/core';
import { validTextAttachments } from '@corral/core';
import { runResults, StatusBadge } from '@corral/react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  KitChatMessage,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Select,
  Switch,
  Tooltip,
} from '@corral/react/design-kit';
import {
  ArrowUp,
  AtSign,
  Ellipsis,
  FileDiff,
  FileText,
  FolderOpen,
  MessageSquare,
  PanelRight,
  Plus,
  Square,
  X,
} from '@corral/react/icons';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { type AppCommand, useRegisterCommands, useRegisteredCommands } from '../commandRegistry.ts';
import { createPendingSessionCommands } from '../pendingCommands.ts';
import { projectsChanged, setCurrentProject } from '../projects.ts';
import { sessionRoute } from '../router.tsx';
import { conversationRequest } from '../sessionActions.ts';
import {
  PANE_CATALOG,
  panelKey,
  SESSION_PANELS,
  type SessionPanel,
} from '../workbench/panels/registry.ts';
import {
  patchSessionSearch,
  resolveSessionSearch,
  type SessionSearch,
  sessionPanelDescriptor,
} from '../workbench/panels/routes.ts';
import { ComposerStats } from '../workbench/widgets/ComposerStats.tsx';

export type { SessionPanel } from '../workbench/panels/registry.ts';

import { useServices } from '../services.tsx';
import { useShortcutBindings } from '../shortcutBindings.ts';
import { sendKeyLabel, shortcutLabel } from '../shortcuts.ts';
import { ArchivedSessionNotice } from '../workbench/ArchivedSessionNotice.tsx';
import { AutoModelMenu } from '../workbench/AutoModelMenu.tsx';
import {
  autoChoiceFor,
  autoCommandSeed,
  autoNotReady,
  autoReasoningUnsupported,
  sessionRunMode,
} from '../workbench/autoChoice.ts';
import { ChatDensityMenu, ChatView } from '../workbench/ChatView.tsx';
import { ComposerInput } from '../workbench/ComposerInput.tsx';
import { ComposerSurface } from '../workbench/ComposerSurface.tsx';
import { type IntentLock, resolveIntent } from '../workbench/composerIntent.ts';
import { type MentionItem, mentionToken, pickedReferences } from '../workbench/composerMenu.ts';
import {
  type AttachmentCapture,
  type AttachmentRequest,
  appendComposerAttachment,
  COMPOSER_ATTACH,
  mergeComposerCapture,
} from '../workbench/context/bridge.ts';
import {
  SourceAttachments,
  SourceNavigationContext,
} from '../workbench/context/SourceAttachments.tsx';
import { DebuggerPanel } from '../workbench/DebuggerPanel.tsx';
import { DevelopmentMode } from '../workbench/DevelopmentMode.tsx';
import { DockDocumentPanel } from '../workbench/DockDocumentPanel.tsx';
import { DockRunControls } from '../workbench/DockRunControls.tsx';
import { DockWorkbench, type DockWorkbenchHandle } from '../workbench/docking/DockWorkbench.tsx';
import type { DockContextView } from '../workbench/docking/layout.ts';
import { documentKey, documentStore } from '../workbench/documents/store.ts';
import { editorCopyDirty, subscribeEditorCopies } from '../workbench/editorDraft.ts';
import { FilePanel, type FileReference } from '../workbench/FilePanel.tsx';
import { ImageAttachmentList, ImageAttachmentPicker } from '../workbench/ImageAttachments.tsx';
import { LiveVoice } from '../workbench/LiveVoice.tsx';
import { MeetingHandoffLinks } from '../workbench/MeetingHandoff.tsx';
import { MessageBranch } from '../workbench/MessageBranch.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { PermissionModePicker } from '../workbench/PermissionModePicker.tsx';
import { ProblemsPanel } from '../workbench/ProblemsPanel.tsx';
import { isSendKey, usePreferences } from '../workbench/preferences.ts';
import { EDIT_REQUEST, editRequest, RefusalHelp } from '../workbench/RefusalHelp.tsx';
import { RenameSessionDialog } from '../workbench/RenameSessionDialog.tsx';
import { RunChanges } from '../workbench/RunChanges.tsx';
import { RunMessage } from '../workbench/RunMessage.tsx';
import { SessionChangesPanel } from '../workbench/SessionChangesPanel.tsx';
import {
  COMPOSER_DRAFT_SENT,
  clearSentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '../workbench/sessionDraft.ts';
import { TerminalPanel } from '../workbench/TerminalPanel.tsx';
import { TextAttachmentList, TextAttachmentPicker } from '../workbench/TextAttachments.tsx';
import { TopbarActions } from '../workbench/TopbarSlot.tsx';
import { useMentionSearch } from '../workbench/useMentionSearch.ts';
import {
  type ProfileInfo,
  type RoleModel,
  useModelProfiles,
  useTeamRoles,
} from '../workbench/useModels.ts';
import { WorkbenchToolsPanel } from '../workbench/WorkbenchToolsPanel.tsx';
import { ComposerDock, ComposerPlan } from '../workbench/widgets/ChatWidgets.tsx';
import { OverviewAccess, OverviewPanel } from '../workbench/widgets/OverviewWidgets.tsx';
import { ChatWidgetProvider } from '../workbench/widgets/useChatWidgets.tsx';
import { TeamDesign } from './EditorPage.tsx';
import { useBinding, WORKSPACE_CHANGED } from './FilesViews.tsx';
import { MeetingPage } from './MeetingPage.tsx';
import { Checks } from './ReviewPage.tsx';
import { RunDetail } from './RunPage.tsx';
import { useRemembered } from './Workbench.tsx';

// A work session: what was asked, the runs it started, the queue, and
// one input box whose intent is chosen, never guessed.

const newCommandId = () => `cmd_${globalThis.crypto.randomUUID()}`;

/** The session's runs, kept current while one is working. */
function useSessionRuns(sessionId: string, selectedRunId?: string) {
  const { transport } = useServices();
  const [all, setAll] = useState<RunSummary[]>([]);
  const [tick, setTick] = useState(0);
  // Unreachable server: run states are unknown, not finished.
  const [lost, setLost] = useState(false);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    void tick;
    void sessionId;
    void selectedRunId;
    let live = true;
    transport.listRuns().then(
      (runs) => {
        if (!live) return;
        setAll(runs);
        setLost(false);
      },
      () => live && setLost(true),
    );
    return () => {
      live = false;
    };
  }, [transport, tick, sessionId, selectedRunId]);
  const runs = all
    .filter((r) => r.sessionId === sessionId)
    .reverse()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const active = runs.findLast((r) => !TERMINAL_RUN_STATUSES.has(r.status)) ?? null;
  useEffect(() => {
    if (!active && !lost) return;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [active, lost, refresh]);
  return { runs, active, refresh, lost };
}

/**
 * Context panes follow the session URL; document tabs keep their explicit workspace target.
 * Stores own editing and execution state independently of dock placement.
 */
/** a meeting has its own chat; every other session keeps the work view. */
export function SessionPage() {
  const { session } = sessionRoute.useLoaderData();
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
    const remembered = JSON.parse(viewKey);
    delete remembered.compose;
    rememberView(remembered);
  }, [viewKey, rememberView]);
  const navigate = useNavigate({ from: '/sessions/$sessionId' });
  const router = useRouter();
  const { runs, active, refresh, lost } = useSessionRuns(session.sessionId, search.run);
  useEffect(() => setCurrentProject(session.projectId), [session.projectId]);
  const team = corrals.find((c) => c.corralId === session.corralId) ?? null;
  const ts = useTranslations('Sessions');
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
    rememberView({ ...next, compose: undefined });
    void navigate({ search: () => next, replace: options?.replace });
  };
  const showPanel = (patch: Partial<typeof search>) => {
    dock.current?.openContext(patch.panel ?? 'chat');
    setSearch(patch);
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
    run: () => <RunPanel runs={runs} search={search} setSearch={setSearch} />,
  };
  const renderContext = (view: DockContextView, requestedView: DockContextView = view) => {
    if (view === 'chat')
      return (
        <div className="flex h-full min-h-0 flex-col">
          {lost ? (
            <div
              role="alert"
              className="flex items-center gap-2 bg-danger/5 px-4 py-2 text-xs text-danger"
            >
              {ts('connectionLost')}
              <Button variant="tertiary" size="compact" onClick={refresh}>
                {ts('retry')}
              </Button>
            </div>
          ) : null}
          <WorkTab
            key={panelKey(services, {
              kind: 'chat',
              projectId: session.projectId,
              sessionId: session.sessionId,
            })}
            session={session}
            team={team}
            corrals={corrals}
            runs={runs}
            active={active}
            liveRunId={liveRun?.runId ?? null}
            selectedRunId={presentationRunId}
            onChange={refresh}
            reference={reference}
            onReferenceUsed={() => setReference(null)}
            onPanel={(value, run) => showPanel({ panel: value, ...run })}
          />
        </div>
      );
    if (view === 'changes' || view === 'git') {
      const auxiliary =
        requestedView === 'checks' || requestedView === 'problems' ? requestedView : null;
      return (
        <div key={session.sessionId} className="flex h-full min-h-0 flex-col">
          <div hidden={Boolean(auxiliary)} className="min-h-0 flex-1">
            <SessionChangesPanel
              session={session}
              reviewSearch={
                search.review
                  ? { scope: search.scope, runId: search.runId, file: search.file }
                  : undefined
              }
              onReviewChange={(review) =>
                setSearch({
                  panel: 'changes',
                  review: review ? true : undefined,
                  scope: review?.scope,
                  runId: review?.runId,
                  file: review?.file,
                })
              }
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
      search.run ?? runs.at(-1)?.runId,
    );
    return (
      <div key={target ? panelKey(services, target) : view} className="flex flex-col gap-3 p-3">
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
        changes={changes}
        panel={panel}
        onPanel={(value) => showPanel({ panel: value })}
        fileViewerOpen={fileViewerOpen}
        onToggleFileViewer={toggleFileViewer}
        runs={runs}
        selectedRunId={presentationRunId}
        onSelectRun={(run) =>
          setSearch({
            run,
            view: 'run',
            execution: undefined,
            artifact: undefined,
            result: undefined,
          })
        }
        onEditTeam={(corralId) => dock.current?.openGraph(corralId) ?? false}
      />
      <ArchivedSessionNotice key={session.sessionId} session={session} />
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
            dock.current?.openContext('terminal');
          },
        }}
      >
        <ChatWidgetProvider
          sessionId={session.sessionId}
          presentationRunId={presentationRunId}
          live={Boolean(liveRun)}
          runIds={sessionRunIds}
        >
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
                selectedPanel={search.compose ? null : panel}
                fileWorkAvailable={Boolean(binding)}
                selectionKey={`${session.sessionId}:${viewKey}`}
                documentOwner={documents}
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
                controls={
                  active && panel !== 'run' ? (
                    <DockRunControls
                      key={active.runId}
                      runId={active.runId}
                      request={session.entries
                        .find((entry) => entry.runId === active.runId)
                        ?.text.slice(0, 80)}
                      viewingOther={presentationRunId !== active.runId}
                      onOpen={(run) =>
                        showPanel({
                          panel: 'run',
                          run,
                          view: 'run',
                          execution: undefined,
                          artifact: undefined,
                          result: undefined,
                        })
                      }
                    />
                  ) : null
                }
              />
            </div>
            {fileViewerOpen || fileViewerVisited ? (
              <aside
                hidden={!fileViewerOpen}
                aria-label={tdock('fileViewer')}
                className="min-h-0 w-96 max-w-full shrink-0 overflow-auto border-l border-line p-3 max-lg:w-full"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">{tdock('fileViewer')}</h2>
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
        </ChatWidgetProvider>
      </SourceNavigationContext.Provider>
    </>
  );
}

/** The session's changed files in its working copy, or null without one. */
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
  const key = runs.map((r) => `${r.runId}:${r.status}`).join(',');
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

/** The session's own actions, in the top bar: changes, the side panel, and a menu. */
function SessionActions({
  session,
  corrals,
  team,
  changes,
  panel,
  onPanel,
  fileViewerOpen,
  onToggleFileViewer,
  runs,
  selectedRunId,
  onSelectRun,
  onEditTeam,
}: {
  session: WorkSession;
  corrals: CorralSummary[];
  team: CorralSummary | null;
  /** Opens the saved team as a dock tab; false when it could not, so the route opens it. */
  onEditTeam: (corralId: string) => boolean;
  changes: FileChangeView[] | null;
  panel: SessionPanel | undefined;
  onPanel: (panel: SessionPanel | undefined) => void;
  fileViewerOpen: boolean;
  onToggleFileViewer: (open: boolean) => void;
  runs: RunSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  useShortcutBindings();
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workbench');
  const td = useTranslations('Desktop');
  const status = useTranslations('Status');
  const { repository } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const update = async (change: {
    corralId?: string | null;
    pinned?: boolean;
    archived?: boolean;
    title?: string;
  }) => {
    const result = await repository.updateSession(session.sessionId, {
      ...change,
      expectedRevision: session.revision,
    });
    if (!result.ok) {
      setError(t('failed', { message: result.message }));
      return false;
    }
    setError(null);
    projectsChanged();
    await router.invalidate();
    return true;
  };
  const tcmd = useTranslations('Commands');
  const tdock = useTranslations('Docking');
  const { workspaces } = useServices();
  const panelGroup = tcmd('groups.panel');
  const sessionGroup = tcmd('groups.session');
  useRegisterCommands('session', [
    {
      id: 'panel:toggle',
      title: tcmd('togglePanel'),
      group: panelGroup,
      shortcutId: 'view.panel',
      shortcut: shortcutLabel('view.panel'),
      run: () => onToggleFileViewer(!fileViewerOpen),
    },
    // Every pane from the one catalog: its dock name, its `/` name and the words other screens
    // use for it (#70, #86).
    ...PANE_CATALOG.map(
      (entry): AppCommand => ({
        id: `panel:${entry.view}`,
        title: tcmd('openPanel', { panel: tdock(entry.view) }),
        group: panelGroup,
        keywords: [...entry.aliases, entry.slash],
        slash: entry.slash,
        run: () => onPanel(entry.view),
      }),
    ),
    {
      id: 'git:commit',
      title: tcmd('gitCommit'),
      group: sessionGroup,
      keywords: ['git', 'commit', 'stage'],
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: () => {
        onPanel('git');
        // The commit box appears once the Git pane has read the index.
        let tries = 0;
        const focus = () => {
          const box = document.getElementById('git-commit-message');
          if (box) box.focus();
          else if (++tries < 40) window.setTimeout(focus, 50);
        };
        focus();
      },
    },
    {
      id: 'session:review',
      title: tcmd('review'),
      group: sessionGroup,
      slash: 'review',
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: () =>
        navigate({ to: '/sessions/$sessionId/review', params: { sessionId: session.sessionId } }),
    },
    {
      id: 'session:copy',
      title: tcmd('makeCopy'),
      group: sessionGroup,
      slash: 'copy',
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: async () => {
        if (!workspaces) return;
        try {
          const existing = await workspaces.worktree(session.sessionId).catch(() => null);
          if (existing && !existing.missing) return setError(tcmd('copyExists'));
          await workspaces.createWorktree(session.sessionId);
          window.dispatchEvent(new Event(WORKSPACE_CHANGED));
          onPanel('changes');
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      },
    },
    {
      id: 'session:rename',
      title: tcmd('rename'),
      group: sessionGroup,
      slash: 'rename',
      run: () => setRenaming(session.title),
    },
    {
      id: 'session:pin',
      title: session.pinned ? tcmd('unpin') : tcmd('pin'),
      group: sessionGroup,
      slash: session.pinned ? 'unpin' : 'pin',
      run: () => void update({ pinned: !session.pinned }),
    },
    {
      id: 'session:archive',
      title: session.archivedAt ? tcmd('restore') : tcmd('archive'),
      group: sessionGroup,
      slash: session.archivedAt ? 'restore' : 'archive',
      run: () => void update({ archived: !session.archivedAt }),
    },
  ]);
  return (
    <TopbarActions>
      {runs.length > 1 ? (
        <Select
          variant="chip"
          className="max-w-32 sm:max-w-60"
          label={t('selectedRun')}
          value={selectedRunId}
          onValueChange={onSelectRun}
          options={runs.map((run) => ({
            value: run.runId,
            label: (
              <span className="block max-w-[min(26rem,70vw)] truncate">
                {session.entries.find((entry) => entry.runId === run.runId)?.text.slice(0, 55) ||
                  run.runId}{' '}
                · {status(run.status)}
              </span>
            ),
          }))}
        />
      ) : null}
      {error ? (
        <p role="alert" className="max-w-64 truncate text-xs text-danger" title={error}>
          {error}
        </p>
      ) : null}
      {changes && changes.length > 0 ? (
        <Button
          variant="ghost"
          size="compact"
          aria-pressed={panel === 'changes'}
          onClick={() => onPanel(panel === 'changes' ? undefined : 'changes')}
          className="gap-1.5 text-muted-foreground"
        >
          <FileDiff />
          {tw('changeCount', { count: changes.length })}
        </Button>
      ) : null}
      <Tooltip
        content={tdock(fileViewerOpen ? 'closeFileViewer' : 'openFileViewer')}
        shortcut={shortcutLabel('view.panel')}
      >
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={tdock(fileViewerOpen ? 'closeFileViewer' : 'openFileViewer')}
          aria-pressed={fileViewerOpen}
          onClick={() => onToggleFileViewer(!fileViewerOpen)}
        >
          <PanelRight />
        </Button>
      </Tooltip>
      <Menu>
        <Tooltip content={td('sessionActions', { title: session.title })}>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={td('sessionActions', { title: session.title })}
              />
            }
          >
            <Ellipsis />
          </MenuTrigger>
        </Tooltip>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem onClick={() => setRenaming(session.title)}>{td('rename')}</MenuItem>
          <MenuSub>
            <MenuSubTrigger>
              {t('chooseTeam')}
              <span className="ml-auto max-w-28 truncate pl-3 text-xs text-muted-foreground">
                {team?.name ?? (session.corralId ? t('selectedTeamUnavailable') : t('autoTeam'))}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                value={session.corralId ?? ''}
                onValueChange={(value) => void update({ corralId: String(value) || null })}
              >
                <MenuRadioItem value="" closeOnClick>
                  {t('autoTeam')}
                </MenuRadioItem>
                {session.corralId && !team ? (
                  <MenuRadioItem value={session.corralId} disabled>
                    {t('selectedTeamUnavailable')}
                  </MenuRadioItem>
                ) : null}
                {corrals.map((c) => (
                  <MenuRadioItem key={c.corralId} value={c.corralId} closeOnClick>
                    {c.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          {team ? (
            <MenuItem
              onClick={() => {
                if (!onEditTeam(team.corralId))
                  void navigate({
                    to: '/corrals/$corralId/edit',
                    params: { corralId: team.corralId },
                    search: { fromSession: session.sessionId },
                  });
              }}
            >
              {t('editTeam')}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <ChatDensityMenu />
          <MenuSeparator />
          <MenuItem onClick={() => void update({ pinned: !session.pinned })}>
            {session.pinned ? t('unpin') : t('pin')}
          </MenuItem>
          <MenuItem onClick={() => void update({ archived: !session.archivedAt })}>
            {session.archivedAt ? t('restore') : t('archive')}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <RenameSessionDialog
        title={renaming}
        onSave={(title) => update({ title })}
        onClose={() => setRenaming(null)}
      />
    </TopbarActions>
  );
}

/** The conversation: what was asked, the runs it started, decisions waiting, and the input box. */
function WorkTab({
  session,
  team,
  corrals,
  runs,
  active,
  liveRunId,
  selectedRunId,
  onChange,
  reference,
  onReferenceUsed,
  onPanel,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  corrals: CorralSummary[];
  runs: RunSummary[];
  active: RunSummary | null;
  liveRunId: string | null;
  selectedRunId: string | null;
  onChange: () => void;
  reference: FileReference | null;
  onReferenceUsed: () => void;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  const { runFor, sessionFor, retainRun, workspaces } = useServices();
  const { binding } = useBinding(session.projectId);
  const liveSession = liveRunId ? runFor(liveRunId) : sessionFor(session.sessionId);
  const messageId = sessionRoute.useSearch().message;
  useEffect(() => {
    if (!liveRunId) return;
    const release = retainRun(liveRunId);
    void liveSession.getState().open(liveRunId);
    return release;
  }, [liveSession, liveRunId, retainRun]);
  // Entries in order; runs that no entry names (started elsewhere) are shown after them.
  const named = new Set(session.entries.flatMap((e) => (e.runId ? [e.runId] : [])));
  const loose = runs.filter((r) => !named.has(r.runId));
  const queued = session.entries.filter((e) => e.state === 'queued');
  const runChecks = useRunChecks(session.sessionId, runs);
  const td = useTranslations('Desktop');
  return (
    <RunChecks.Provider value={runChecks}>
      <ChatView
        centerEmpty
        key={session.sessionId}
        aside={<OverviewPanel />}
        sessionId={session.sessionId}
        messageId={messageId}
        header={<MeetingHandoffLinks key={session.sessionId} sessionId={session.sessionId} />}
        items={[
          ...session.entries
            .filter((e) => e.state !== 'queued' && e.state !== 'dismissed')
            .map((entry) => ({
              id: entry.entryId,
              content: (
                <EntryCard
                  sessionId={session.sessionId}
                  entry={entry}
                  runs={runs}
                  onPanel={onPanel}
                />
              ),
            })),
          ...loose.map((run) => ({
            id: run.runId,
            content: <RunCard run={run} onPanel={onPanel} />,
          })),
        ]}
        composer={
          <Composer
            key={session.sessionId}
            session={session}
            team={team}
            corrals={corrals}
            runs={runs}
            active={active}
            selectedRunId={selectedRunId}
            queued={queued}
            onChange={onChange}
            reference={reference}
            onReferenceUsed={onReferenceUsed}
          />
        }
      >
        <section aria-label={t('heading')}>
          {session.entries.length === 0 && loose.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-5 text-center">
              <MessageSquare size={28} strokeWidth={1.25} className="text-muted-foreground" />
              <h3 className="text-xl font-medium tracking-tight">{td('noRequests')}</h3>
              <p className="max-w-md text-sm text-muted-foreground">
                {session.objective
                  ? session.objective
                  : td(workspaces && binding ? 'startHintLinked' : 'startHint')}
              </p>
              {workspaces && binding === null ? (
                <Button variant="ghost" size="compact" onClick={() => onPanel('changes')}>
                  <FolderOpen />
                  {td('workFolder')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      </ChatView>
    </RunChecks.Provider>
  );
}

/** Run detail in the side panel: the chosen run (newest by default) with its own views. */
function RunPanel({
  runs,
  search,
  setSearch,
}: {
  runs: RunSummary[];
  search: SessionSearch;
  setSearch: (patch: Partial<SessionSearch>, options?: { replace?: boolean }) => void;
}) {
  const tw = useTranslations('Workbench');
  const ts = useTranslations('Status');
  const runId = search.run ?? runs.at(-1)?.runId;
  if (!runId) return <p className="p-4 text-sm text-muted-foreground">{tw('noRuns')}</p>;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line/50 px-3 py-1.5">
        <Select
          label={tw('chooseRun')}
          size="xs"
          variant="ghost"
          value={runId}
          onValueChange={(value) =>
            setSearch({
              run: value,
              atSeq: undefined,
              execution: undefined,
              artifact: undefined,
              view: undefined,
              result: undefined,
            })
          }
          options={[...runs].reverse().map((r, index) => ({
            value: r.runId,
            label: `${tw('runNumber', { number: runs.length - index })}${search.atSeq === undefined ? ` · ${ts(r.status)}` : ''}`,
            hint: r.runId,
          }))}
        />
      </div>
      <div className="min-h-0 flex-1">
        <RunDetail
          key={runId}
          sessionId={runs.find((run) => run.runId === runId)?.sessionId ?? null}
          runId={runId}
          embedded
          search={{
            atSeq: search.atSeq,
            execution: search.execution,
            artifact: search.artifact,
            view: search.view ?? (search.result ? 'results' : 'run'),
            result: search.result,
          }}
          setSearch={(patch, options) => setSearch({ run: runId, ...patch }, options)}
        />
      </div>
    </div>
  );
}

/** Results use the same final/partial classification as the conversation. */
function ArtifactsPanel({
  runs,
  onOpen,
}: {
  runs: RunSummary[];
  onOpen: (runId: string, artifactVersionId: string) => void;
}) {
  const tw = useTranslations('Workbench');
  const tr = useTranslations('Results');
  const td = useTranslations('Desktop');
  const ta = useTranslations('Artifact');
  const tk = useTranslations('Docking');
  const { transport } = useServices();
  type Item = {
    runId: string;
    id: string;
    label: string;
    kind: 'final' | 'partial' | 'intermediate';
  };
  const [items, setItems] = useState<Item[]>([]);
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const ended = [...runs].reverse().filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
  const key = ended
    .slice(0, count)
    .map((run) => run.runId)
    .join(',');
  useEffect(() => {
    void retry;
    let live = true;
    setLoading(true);
    setFailed(false);
    void (async () => {
      const found: Item[] = [];
      for (const runId of key ? key.split(',') : []) {
        const snapshot = await transport.getSnapshot(runId).catch((failure: unknown) => {
          // a run the server no longer opens (it used Ultra) has no results to list.
          if (failure instanceof ApiError && failure.code === 'TARGET_NOT_FOUND') return null;
          throw failure;
        });
        if (!live) return;
        if (!snapshot) continue;
        const results = runResults(snapshot.projection);
        for (const artifact of [
          ...results.final,
          ...results.intermediate.map((group) => group.latest),
        ]) {
          found.push({
            runId,
            id: artifact.artifactVersionId,
            label: `${artifact.name} v${artifact.version}`,
            kind: results.final.includes(artifact)
              ? 'final'
              : results.kind === 'partial'
                ? 'partial'
                : 'intermediate',
          });
        }
      }
      if (live) setItems(found);
    })()
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [transport, key, retry]);
  if (loading)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {ta('loading')}
      </p>
    );
  if (failed)
    return (
      <div role="alert" className="space-y-2 text-xs text-danger">
        <p>{td('resultUnavailable')}</p>
        <Button variant="tertiary" size="compact" onClick={() => setRetry((value) => value + 1)}>
          {td('retryResult')}
        </Button>
      </div>
    );
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tw('artifactsEmpty')}</p>
      ) : (
        <ul aria-label={tk('artifacts')} className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={`${item.runId}:${item.id}`}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-2.5 py-1.5 text-left"
                aria-label={`${tr(item.kind)} ${item.label}`}
                onClick={() => onOpen(item.runId, item.id)}
              >
                <FileText className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.label}</span>
                  <span
                    className="truncate font-mono text-2xs text-muted-foreground"
                    title={item.runId}
                  >
                    {item.runId}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{tr(item.kind)}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {ended.length > count ? (
        <Button variant="ghost" size="compact" onClick={() => setCount((value) => value + 10)}>
          {td('moreResults', { count: ended.length - count })}
        </Button>
      ) : null}
    </div>
  );
}

/** Checks: the agreed commands and their results, as on the review screen. */
function ChecksPanel({
  session,
  onAttach,
}: {
  session: WorkSession;
  onAttach: (attachment: TextAttachment, capture: AttachmentCapture) => void;
}) {
  const tw = useTranslations('Workbench');
  const { workspaces } = useServices();
  const { binding } = useBinding(session.projectId);
  if (!workspaces) return <p className="text-xs text-muted-foreground">{tw('serverOnly')}</p>;
  return (
    <>
      <Checks
        sessionId={session.sessionId}
        projectId={session.projectId}
        binding={binding ?? null}
        changed={0}
        onAttach={onAttach}
      />
      <Button
        variant="tertiary"
        size="compact"
        className="self-start"
        render={<Link to="/sessions/$sessionId/review" params={{ sessionId: session.sessionId }} />}
      >
        {tw('expandReview')}
      </Button>
    </>
  );
}

function EntryCard({
  sessionId,
  entry,
  runs,
  onPanel,
}: {
  sessionId: string;
  entry: SessionEntry;
  runs: RunSummary[];
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  const tq = useTranslations('Reasoning');
  const format = useFormatter();
  const run = entry.runId ? runs.find((r) => r.runId === entry.runId) : undefined;
  const when = format.dateTime(new Date(entry.createdAt), {
    timeStyle: 'short',
    dateStyle: 'short',
  });
  // A plain follow-up needs no label; queue, instruction and question say what they were.
  const label = entry.intent === 'next' ? null : t(`intentShort.${entry.intent}`);
  // what an auto request ran with; not a team the person chose.
  const auto = entry.auto
    ? [
        `${t(`autoTemplate.${entry.auto.template}`)}${entry.auto.source === 'fallback' ? ` (${t('autoFallback')})` : ''}`,
        entry.auto.fallback ? t(`autoFallbackReason.${entry.auto.fallback}`) : null,
        entry.auto.modelProfile,
        entry.auto.requestedReasoning?.mode === 'fixed'
          ? tq(`level.${entry.auto.requestedReasoning.level}`)
          : entry.auto.requestedReasoning?.mode === 'route'
            ? t('reasoningRoute')
            : entry.auto.requestedReasoning
              ? tq(entry.auto.requestedReasoning.mode)
              : entry.auto.modelProfile
                ? tq('legacy')
                : null,
        // the level the start model picked for this request.
        entry.auto.reasoning
          ? `${t('reasoningPicked', { level: tq(`level.${entry.auto.reasoning}`) })}${entry.auto.reasoningSource ? ` (${t(`reasoningSource.${entry.auto.reasoningSource}`)})` : ''}`
          : null,
        entry.auto.reason,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  const state =
    entry.state === 'started' || entry.state === 'sent' ? null : t(`state.${entry.state}`);
  return (
    <article data-testid={`entry-${entry.entryId}`} className="chat-turn flex flex-col gap-4">
      <KitChatMessage from="user" time={when}>
        {label || state ? (
          <p className="mb-1 text-2xs font-medium text-muted-foreground">
            {[label, state].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {auto ? (
          <Accordion>
            <AccordionItem value="run-settings" highlight="trigger">
              <AccordionTrigger>{t('runSettings')}</AccordionTrigger>
              <AccordionContent>
                <p data-testid="entry-auto">{auto}</p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        ) : null}
        <p>{entry.text}</p>
        {entry.attachments?.length ? <TextAttachmentList attachments={entry.attachments} /> : null}
        {entry.images?.length ? (
          <ImageAttachmentList sessionId={sessionId} images={entry.images} />
        ) : null}
        <span className="sr-only">
          {t('youAsked', { intent: t(`intent.${entry.intent}`) })} · {t(`state.${entry.state}`)}
        </span>
      </KitChatMessage>
      {entry.runId && run && (entry.intent === 'next' || entry.intent === 'explain') ? (
        <MessageBranch
          runId={entry.runId}
          requestStart
          disabled={!TERMINAL_RUN_STATUSES.has(run.status)}
        />
      ) : null}
      {entry.detail && entry.state === 'refused' && !entry.meetingHandoff ? (
        <RefusalHelp
          message={entry.detail}
          onEdit={() =>
            editRequest(entry.text, {
              permissionMode: entry.permissionMode,
              harness: entry.harness,
              attachments: entry.attachments,
              images: entry.images,
              taskScope: entry.taskScope,
              verificationScope: entry.verificationScope,
            })
          }
        />
      ) : entry.detail ? (
        <p role="note" className="text-xs text-danger">
          {entry.detail}
        </p>
      ) : null}
      {run && entry.intent !== 'steer' ? <RunCard run={run} nested onPanel={onPanel} /> : null}
      {entry.intent === 'steer' && entry.runId ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <DeliveryStatus
            runId={entry.runId}
            commandId={entry.commandId ?? null}
            executionId={entry.executionId ?? null}
          />
          <Button
            variant="ghost"
            size="compact"
            onClick={() =>
              onPanel('run', {
                run: entry.runId ?? undefined,
                view: 'run',
                execution: entry.executionId ?? undefined,
              })
            }
          >
            {t('openRun')}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** A run with its status and, once it has one, its final result. */
/** Each ended run's latest check of its own end state, when the session has checks. */
type RunCheck = { name: string; state: 'running' | 'passed' | 'failed' | 'error' } | null;
const RunChecks = createContext<{ known: boolean; of: (runId: string) => RunCheck }>({
  known: false,
  of: () => null,
});

/** Matches checks to runs by tree: a check counts for a run only if it ran on the run's end. */
function useRunChecks(sessionId: string, runs: RunSummary[]) {
  const { workspaces } = useServices();
  const [value, setValue] = useState<{ known: boolean; map: Map<string, RunCheck> }>({
    known: false,
    map: new Map(),
  });
  const key = runs.map((r) => `${r.runId}:${r.status}`).join(',');
  useEffect(() => {
    void key;
    if (!workspaces) return;
    let live = true;
    void (async () => {
      const copy = await workspaces.worktree(sessionId).catch(() => null);
      if (!copy) return;
      const [snapshots, checks] = await Promise.all([
        workspaces.runSnapshots(sessionId),
        workspaces.verifications(sessionId),
      ]);
      const map = new Map<string, RunCheck>();
      for (const snapshot of snapshots.filter((x) => x.phase === 'end')) {
        const check = checks.find((c) => c.tree === snapshot.tree);
        map.set(snapshot.runId, check ? { name: check.name, state: check.state } : null);
      }
      if (live) setValue({ known: true, map });
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, key]);
  return { known: value.known, of: (runId: string) => value.map.get(runId) ?? null };
}

/**
 * A run in the session: one line with its state, the agent's own words kept
 * apart from facts, and what can be done next. Details open in the side panel.
 */
function RunCard({
  run,
  nested = false,
  onPanel,
}: {
  run: RunSummary;
  nested?: boolean;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  const ts = useTranslations('Status');
  const tf = useTranslations('Files');
  const checks = useContext(RunChecks);
  const check = checks.of(run.runId);
  const ended = TERMINAL_RUN_STATUSES.has(run.status);
  return (
    <section
      aria-label={run.runId}
      data-testid={`run-card-${run.runId}`}
      className={`flex min-w-0 flex-col gap-3 ${nested ? '' : 'mb-8'}`}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {/* a working or finished turn speaks through its process and answer. */}
        {nested && (run.status === 'succeeded' || run.status === 'running') ? (
          <span className="sr-only">
            <StatusBadge status={run.status} />
          </span>
        ) : (
          <StatusBadge status={run.status} />
        )}
        <span className="sr-only">{run.runId}</span>
        {ended && checks.known ? (
          <span className="text-muted-foreground" data-testid="run-check">
            {check
              ? t('checked', { name: check.name, state: tf(`checkState.${check.state}`) })
              : t('notChecked')}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="compact"
          className="ml-auto"
          onClick={() => onPanel('run', { run: run.runId, view: 'run' })}
        >
          {/* The same mark on every link that opens beside the conversation. */}
          <PanelRight />
          {t('openRun')}
        </Button>
      </div>
      {ended && run.status !== 'succeeded' ? (
        <p role="note" className="text-xs text-warning">
          {t('didNotFinish', { status: ts(run.status) })}
        </p>
      ) : null}
      <RunMessage
        runId={run.runId}
        sessionId={run.sessionId ?? null}
        live={!ended}
        onOpenArtifact={(result) => onPanel('run', { run: run.runId, view: 'results', result })}
      />
      {/* Only a session with a working copy has changes to review (its checks are known). */}
      {ended && checks.known && run.sessionId ? (
        <RunChanges sessionId={run.sessionId} runId={run.runId} />
      ) : null}
    </section>
  );
}

/** Where an instruction is now, from the run's own record of it. */
/**
 * Whom an instruction was for, when it applies, and where it is now, from the run's
 * own record. It stays readable after the composer moves on to another execution.
 */
function DeliveryStatus({
  runId,
  commandId,
  executionId,
}: {
  runId: string;
  commandId: string | null;
  executionId: string | null;
}) {
  const t = useTranslations('Sessions');
  const ts = useTranslations('Transcript.instruction');
  const { transport } = useServices();
  const [status, setStatus] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([transport.getSnapshot(runId), transport.getRunDefinition(runId)]).then(
      ([{ projection }, definition]) => {
        const execution = executionId ? projection.executions[executionId] : undefined;
        if (!live || !execution) return;
        const node = definition?.nodes.find((n) => n.id === execution.nodeId);
        setRecipient(
          `${node?.label ?? execution.nodeId} · #${projection.executionOrder.indexOf(execution.executionId) + 1}`,
        );
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transport, runId, executionId]);
  useEffect(() => {
    if (!commandId) return;
    let live = true;
    const read = () =>
      transport.getSnapshot(runId).then(
        ({ projection }) => {
          const directive = Object.values(projection.directives).find(
            (d) => d.commandId === commandId,
          );
          if (live) setStatus(directive?.status ?? null);
          return directive?.status ?? null;
        },
        () => null,
      );
    void read();
    const timer = setInterval(() => {
      void read().then((now) => {
        if (now && !['accepted', 'queued', 'attached_to_request'].includes(now))
          clearInterval(timer);
      });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [transport, runId, commandId]);
  return (
    <>
      <span data-testid="recipient" className="font-medium text-text" title={executionId ?? ''}>
        → {recipient ?? executionId}
      </span>
      <span>{t('appliesAt')}</span>
      {status ? <span data-testid="delivery">{t('delivery', { status: ts(status) })}</span> : null}
    </>
  );
}

function finalResultId(projection: RunProjection): string | null {
  return projection.output?.artifactVersionIds[0] ?? null;
}

// Keep uncertain requests across SPA navigation, never request controllers.
const pendingSessionCommands = createPendingSessionCommands(
  typeof window !== 'undefined' && window.corralRemote ? window.localStorage : undefined,
  typeof window !== 'undefined' ? window.corralRemote?.hostId : undefined,
);

export function Composer({
  session,
  team,
  corrals,
  runs,
  active,
  selectedRunId,
  queued,
  onChange,
  reference,
  onReferenceUsed,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  corrals: CorralSummary[];
  runs: RunSummary[];
  active: RunSummary | null;
  selectedRunId: string | null;
  queued: SessionEntry[];
  onChange: () => void;
  reference: FileReference | null;
  onReferenceUsed: () => void;
}) {
  useShortcutBindings();
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const format = useFormatter();
  const contextMessages = useTranslations('Context');
  const navigation = useSettingsNavigation();
  const tr = useTranslations('Reins');
  const services = useServices();
  const { repository, transport, mode, live } = services;
  const prefs = usePreferences();
  const router = useRouter();
  const navigate = useNavigate();
  // UX-02: the draft comes back with its intent, target and exact references.
  const [restored] = useState(() => readComposerDraft(session.sessionId));
  const [text, setText] = useState(restored.text);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(
    restored.permissionMode,
  );
  const [attachments, setAttachments] = useState<TextAttachment[]>(restored.attachments ?? []);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>(restored.images ?? []);
  const [imagesBusy, setImagesBusy] = useState(false);
  const textFiles = useRef<HTMLInputElement>(null);
  const imageFiles = useRef<HTMLInputElement>(null);
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const autoSaving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [confirmedAuto, setConfirmedAuto] = useState<{
    revision: number;
    choice: AutoModelChoice;
  } | null>(null);
  const [chosen, setChosen] = useState<SessionIntent | null>(null);
  const [target, setTarget] = useState<string>('');
  // UX-01: what the request is (and for whom) is fixed once typing starts.
  const [lock, setLock] = useState<IntentLock | null>(
    restored.text && restored.intent ? { intent: restored.intent, target: restored.target } : null,
  );
  // sessions are live wherever live is possible; simulation stays in the demo and
  // the team editor.
  const runMode = sessionRunMode(mode, live);
  const [busy, setBusy] = useState(false);
  const voiceSubmitting = useRef(false);
  const voiceSubmissions = useRef(new Map<string, () => Promise<VoiceTranscriptReceipt>>());
  const [choosingAuto, setChoosingAuto] = useState(false);
  const autoRequest = useRef<{
    controller: AbortController;
    commandId: string;
    result: Promise<AutoStartResult>;
    cancellation?: Promise<AutoCancelResult>;
  } | null>(null);
  const cancelAuto = useCallback(() => {
    const request = autoRequest.current;
    if (!request || request.cancellation) return;
    const cancelCommandId = newCommandId();
    request.cancellation = services.cancelAuto
      ? services.cancelAuto({
          commandId: request.commandId,
          sessionId: session.sessionId,
          cancelCommandId,
        })
      : request.result.then(
          async (start) => ({
            start,
            cancellation: start.runId
              ? await transport.sendCommand({
                  schemaVersion: '0.1',
                  commandId: cancelCommandId,
                  runId: start.runId,
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'User cancelled the auto request' },
                })
              : null,
          }),
          () => ({ start: null, cancellation: null }),
        );
    request.controller.abort();
  }, [services, session.sessionId, transport]);
  useEffect(() => () => cancelAuto(), [cancelAuto]);
  const [error, setError] = useState<string | null>(null);
  // UX-04: why the last request did not start; the text stays in the box to send again.
  const [refusal, setRefusal] = useState<{
    message: string;
    code?: string | undefined;
    network?: boolean;
  } | null>(null);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [targetTick, setTargetTick] = useState(0);
  const [picked, setPicked] = useState<MentionItem[]>(restored.references);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Names of executions seen, so an instruction for one that ended still says whom it was for.
  const targetNames = useRef(
    new Map<string, string>(
      restored.target && restored.targetLabel ? [[restored.target, restored.targetLabel]] : [],
    ),
  );
  const [confirmStop, setConfirmStop] = useState(false);
  const stopTarget = useRef<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [autoModelOpen, setAutoModelOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  // UX-06: which model each role uses, and whether it is connected.
  const profiles = useModelProfiles();
  const autoChoice = autoChoiceFor(
    confirmedAuto && confirmedAuto.revision > session.revision
      ? confirmedAuto.choice
      : session.auto,
    profiles,
  );
  const isAuto = session.corralId === null;
  const missingTeam = !isAuto && !team;
  // without a saved Corral, the lead works alone or leads the auto roster.
  const [teamMode, setTeamMode] = useRemembered<'none' | 'auto'>(
    `corral:team-mode:${session.sessionId}`,
    'none',
  );
  const roles = useTeamRoles(team);
  const [recall, setRecall] = useState(-1);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (session.entries.length === 0) input.current?.focus();
  }, [session.entries.length]);
  const ownActive =
    runs.find((run) => run.runId === selectedRunId && !TERMINAL_RUN_STATUSES.has(run.status)) ??
    null;
  const latest = useLatestResult(runs);
  // a follow-up carries the session's turns through the newest ended run.
  const lastEnded = runs.findLast((run) => TERMINAL_RUN_STATUSES.has(run.status)) ?? null;
  const searchMentions = useMentionSearch({
    projectId: session.projectId,
    sessionId: session.sessionId,
    runs,
    team,
  });
  // One command ID per request: a retry after a lost answer reuses it, so the runtime returns
  // the first receipt instead of starting a second run.
  const pending = useRef(pendingSessionCommands.get(session.sessionId) ?? null);
  const commandFor = (key: string) => {
    if (pending.current?.key !== key) {
      pending.current = { key, commandId: newCommandId() };
      pendingSessionCommands.set(session.sessionId, pending.current);
    }
    return pending.current.commandId;
  };
  const clearPending = () => {
    if (pendingSessionCommands.get(session.sessionId) === pending.current)
      pendingSessionCommands.delete(session.sessionId);
    pending.current = null;
  };
  const [autoStart, setAutoStart] = useRemembered(`corral:auto-queue:${session.sessionId}`, false);

  // A writer keeps the working copy. Other work queues, or sends an instruction to this
  // session's current execution. An instruction needs an execution that can still take one
  // (none while a decision waits).
  const allowed: SessionIntent[] = active
    ? [...(ownActive && targets.length > 0 ? ['steer' as const] : []), 'queue']
    : // a question about an earlier answer is an ordinary message to the conversation.
      ['next'];

  // Executions that can still take an instruction, named by their node.
  useEffect(() => {
    void targetTick;
    if (!ownActive) return setTargets([]);
    let live = true;
    void Promise.all([
      transport.getSnapshot(ownActive.runId),
      transport.getRunDefinition(ownActive.runId),
    ]).then(([{ projection }, definition]) => {
      if (!live) return;
      const open = projection.executionOrder
        .map((id) => projection.executions[id])
        .filter((e) => e && !TERMINAL_EXECUTION_STATUSES.has(e.status));
      setTargets(
        open.flatMap((e) =>
          e
            ? [
                {
                  id: e.executionId,
                  label: `${definition?.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId} · #${projection.executionOrder.indexOf(e.executionId) + 1}`,
                },
              ]
            : [],
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [transport, ownActive, targetTick]);
  // An execution may end while the person types: the list follows it.
  useEffect(() => {
    if (!ownActive) return;
    const timer = setInterval(() => setTargetTick((n) => n + 1), 1500);
    return () => clearInterval(timer);
  }, [ownActive]);
  for (const x of targets) targetNames.current.set(x.id, x.label);
  const resolved = resolveIntent({
    allowed,
    chosen,
    chosenTarget: target || null,
    lock,
    targets: targets.map((x) => x.id),
    running: Boolean(ownActive),
  });
  const intent = resolved.intent;
  const steerTarget = resolved.target ?? '';
  const targetName = (id: string) => targetNames.current.get(id) ?? id;

  /** Changes the text; the first character fixes what the request is and for whom. */
  const write = (value: string | ((current: string) => string)) => {
    setText(value);
    if (value === '') setLock(null);
    else if (!lock) setLock({ intent, target: intent === 'steer' ? steerTarget || null : null });
  };
  /** An explicit choice by the person; it becomes the new fixed intent while text is typed. */
  const chooseIntent = (value: SessionIntent) => {
    setChosen(value);
    if (text)
      setLock({
        intent: value,
        target: value === 'steer' ? (lock?.target ?? steerTarget) || targets[0]?.id || null : null,
      });
  };
  const chooseTarget = (value: string) => {
    setTarget(value);
    if (text) setLock({ intent: 'steer', target: value });
  };
  const composerDraft = useMemo(
    () => ({
      text,
      intent: lock?.intent ?? null,
      target: lock?.target ?? null,
      targetLabel: lock?.target ? (targetNames.current.get(lock.target) ?? null) : null,
      references: picked.filter((item) => pickedReferences(text, [item]).length > 0),
      ...(attachments.length ? { attachments } : {}),
      ...(images.length ? { images } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    }),
    [text, lock, picked, attachments, images, permissionMode],
  );
  const draftRevision = useRef(0);
  const currentDraft = useRef({ draft: composerDraft, busy: false });
  currentDraft.current = {
    draft: composerDraft,
    busy: busy || attachmentsBusy || imagesBusy,
  };
  useEffect(() => {
    const attach = (event: Event) => {
      const request = (event as CustomEvent<AttachmentRequest>).detail;
      const destination = request.capture.target;
      if (
        destination.hostId !== services.workspaceId ||
        destination.projectId !== session.projectId ||
        destination.sessionId !== session.sessionId
      )
        return;
      if (currentDraft.current.busy) {
        request.result = { ok: false, reason: 'busy' };
        return;
      }
      const draft = mergeComposerCapture(currentDraft.current.draft, request);
      if ('ok' in draft) {
        request.result = draft;
        return;
      }
      currentDraft.current.draft = draft;
      draftRevision.current = writeComposerDraft(session.sessionId, draft);
      setAttachments(draft.attachments ?? []);
      if (request.image !== undefined) setImages(draft.images ?? []);
      request.result = { ok: true };
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(COMPOSER_ATTACH, attach);
    return () => window.removeEventListener(COMPOSER_ATTACH, attach);
  }, [services.workspaceId, session.projectId, session.sessionId]);
  useEffect(() => {
    draftRevision.current = writeComposerDraft(session.sessionId, composerDraft);
  }, [session.sessionId, composerDraft]);
  useEffect(() => {
    const sent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId: string;
          revision: number;
          preserveAttachments?: boolean;
          preserveImages?: boolean;
        }>
      ).detail;
      if (detail.sessionId !== session.sessionId || detail.revision !== draftRevision.current)
        return;
      setPicked([]);
      if (!detail.preserveAttachments) setAttachments([]);
      if (!detail.preserveImages) setImages([]);
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      setPermissionMode(undefined);
      setChosen(null);
      setLock(null);
      setText('');
    };
    window.addEventListener(COMPOSER_DRAFT_SENT, sent);
    return () => window.removeEventListener(COMPOSER_DRAFT_SENT, sent);
  }, [session.sessionId]);

  // References restored from a draft are checked once: a result version, run or role that is
  // gone is marked, never swapped for another with the same name.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the restored references
  useEffect(() => {
    if (!restored.references.length) return;
    let live = true;
    void (async () => {
      const gone = new Set<string>();
      const roles = team
        ? ((await repository.get(team.corralId))?.definition.roles.map((r) => r.id) ?? [])
        : [];
      for (const item of restored.references) {
        const ref = item.reference;
        try {
          if (ref.kind === 'result') {
            const { projection } = await transport.getSnapshot(ref.runId);
            if (!projection.artifacts[ref.artifactVersionId]) gone.add(item.id);
          } else if (ref.kind === 'run') await transport.getSnapshot(ref.runId);
          else if (ref.kind === 'role' && !roles.includes(ref.roleId)) gone.add(item.id);
        } catch {
          gone.add(item.id);
        }
      }
      if (live) setMissing(gone);
    })();
    return () => {
      live = false;
    };
  }, []);

  // A line range chosen in the file panel arrives as a reference at the caret.
  const used = useRef<FileReference | null>(null);
  useEffect(() => {
    if (!reference || used.current === reference) return;
    used.current = reference;
    const item: MentionItem = {
      id: `file:${reference.path}:${reference.start}-${reference.end}`,
      kind: 'file',
      label: reference.path,
      lines: { start: reference.start, end: reference.end },
      reference: {
        kind: 'file',
        path: reference.path,
        lines: { start: reference.start, end: reference.end },
      },
    };
    setPicked((list) => [...list, item]);
    const box = input.current;
    const at = box?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const token = mentionToken(item);
    const next = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${token} ${text.slice(at)}`;
    write(next);
    onReferenceUsed();
    requestAnimationFrame(() => box?.focus());
  });

  const references = pickedReferences(text, picked);
  const chips = picked.filter(
    (item, index) =>
      picked.findIndex((x) => x.id === item.id) === index &&
      pickedReferences(text, [item]).length > 0,
  );
  const missingChips = chips.filter((item) => missing.has(item.id));

  const record = async (entry: Parameters<typeof repository.addSessionEntry>[1]) => {
    const saved = await repository.addSessionEntry(session.sessionId, entry);
    if (!saved.ok) throw new Error(t('failed', { message: saved.message }));
    if (saved.session.title !== session.title) projectsChanged();
  };

  /** Starts a follow-up with the team; returns the run or why not. */
  const startNext = async (
    brief: string,
    commandId: string = newCommandId(),
    refs: RunReference[] = [],
    requestPermissionMode?: PermissionMode,
  ): Promise<{
    runId: string | null;
    detail: string | null;
    code?: string | undefined;
    auto?: SessionEntryAuto | null;
    cancelled?: boolean;
    cancelError?: string;
  }> => {
    // every chat turn is the conversation lead; a saved Corral lends it its roles.
    // A deleted Corral is never replaced by another way of working.
    if (missingTeam) return { runId: null, detail: t('selectedTeamMissing') };
    return startAuto(brief, commandId, refs, requestPermissionMode);
  };

  /** with no team chosen, the runtime picks a template for this request. */
  const startAuto = async (
    brief: string,
    commandId: string,
    refs: RunReference[],
    requestPermissionMode?: PermissionMode,
  ) => {
    const controller = new AbortController();
    const proposed = conversationRequest(services, session, {
      ...(requestPermissionMode ? { permissionMode: requestPermissionMode } : {}),
      commandId,
      brief,
      choice: autoChoice,
      team: teamMode,
      ...(lastEnded ? { throughRunId: lastEnded.runId } : {}),
      ...(refs.length ? { references: refs } : {}),
    });
    const command = pending.current;
    // A completed run may change `lastEnded` before its lost start receipt is recovered.
    let body = proposed;
    if (command?.commandId === commandId) {
      command.autoRequest ??= structuredClone(proposed);
      pendingSessionCommands.set(session.sessionId, command);
      body = command.autoRequest;
    }
    const request: NonNullable<typeof autoRequest.current> = {
      controller,
      commandId,
      result: services.startAuto(body, controller.signal),
    };
    autoRequest.current = request;
    setChoosingAuto(true);
    try {
      let result: AutoStartResult;
      try {
        result = await request.result;
      } catch (failure) {
        if (!request.cancellation) throw failure;
        const cancelled = await request.cancellation;
        if (!cancelled.start) throw new DOMException('Cancelled', 'AbortError');
        result = cancelled.start;
      }
      const cancellation = request.cancellation ? await request.cancellation : null;
      // A dropped HTTP response can hide a committed run; keep its original receipt.
      if (cancellation?.start) result = cancellation.start;
      return {
        runId: result.runId,
        detail: result.receipt.error?.message ?? null,
        code: result.receipt.error?.code,
        cancelled: cancellation !== null,
        ...(cancellation?.cancellation?.error
          ? { cancelError: cancellation.cancellation.error.message }
          : {}),
        auto: result.autoRoute
          ? {
              template: result.autoRoute.template,
              ...(result.autoRoute.harness ? { harness: result.autoRoute.harness } : {}),
              source: result.autoRoute.source,
              reason: result.autoRoute.reason,
              modelProfile: result.autoRoute.modelProfile,
              ...(result.autoRoute.fallback ? { fallback: result.autoRoute.fallback } : {}),
              ...(result.autoRoute.reasoning
                ? { requestedReasoning: result.autoRoute.reasoning }
                : {}),
              ...(result.autoRoute.reasoningChoice
                ? {
                    reasoning: result.autoRoute.reasoningChoice.level,
                    reasoningSource: result.autoRoute.reasoningChoice.source,
                  }
                : {}),
            }
          : null,
      };
    } finally {
      if (autoRequest.current === request) {
        autoRequest.current = null;
        setChoosingAuto(false);
      }
    }
  };

  /** Saves the auto model and reasoning with the session. */
  const updateAuto = async (auto: AutoModelChoice) => {
    if (autoSaving.current || busy) return;
    autoSaving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await repository.updateSession(session.sessionId, {
        auto,
        expectedRevision: Math.max(session.revision, confirmedAuto?.revision ?? 0),
      });
      if (!mounted.current) return;
      if (!result.ok) throw new Error(result.message);
      setConfirmedAuto({ revision: result.session.revision, choice: auto });
      await router.invalidate();
    } catch (failure) {
      if (mounted.current)
        setError(
          t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
        );
    } finally {
      autoSaving.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /** A refused request keeps its text, intent and references so it can be fixed and resent. */
  const refused = async (message: string, code?: string) => {
    // A refusal is final for that command; the next attempt is a new command.
    clearPending();
    setRefusal({ message, code });
    await router.invalidate();
    onChange();
  };

  const performVoice = async (utterance: VoiceTranscript): Promise<VoiceTranscriptReceipt> => {
    if (
      utterance.target.hostId !== window.location.origin ||
      utterance.target.sessionId !== session.sessionId
    )
      return {
        status: 'rejected',
        message: 'The voice destination changed. Reconnect explicitly.',
      };
    if (voiceSubmitting.current || autoSaving.current)
      return {
        status: 'rejected',
        message: 'Another request is being submitted. Retry this same utterance.',
      };
    if (
      !utterance.delivery &&
      utterance.target.runId &&
      (ownActive?.runId !== utterance.target.runId ||
        !utterance.target.executionId ||
        !targets.some((item) => item.id === utterance.target.executionId))
    )
      return {
        status: 'rejected',
        message:
          'The pinned execution cannot receive an instruction (it ended or is waiting for a decision). Choose queue or next request explicitly.',
        alternatives: ['queue', 'next'],
      };
    if (!utterance.delivery && !utterance.target.runId && ownActive)
      return {
        status: 'rejected',
        message:
          'A run started after this call was connected. Queue this utterance or reconnect to select its execution.',
        alternatives: ['queue'],
      };
    voiceSubmitting.current = true;
    setBusy(true);
    try {
      if (utterance.delivery === 'queue') {
        await record({
          intent: 'queue',
          text: utterance.text,
          state: 'queued',
          commandId: utterance.commandId,
          ...(permissionMode ? { permissionMode } : {}),
        });
        onChange();
        return { status: 'queued' };
      }
      if (!utterance.delivery && utterance.target.runId && utterance.target.executionId) {
        const receipt = await transport.sendCommand({
          schemaVersion: '0.1',
          commandId: utterance.commandId,
          runId: utterance.target.runId,
          type: 'steer',
          payload: {
            targetExecutionId: utterance.target.executionId,
            text: utterance.text,
            delivery: 'next_request',
          },
        });
        await record({
          intent: 'steer',
          text: utterance.text,
          state: receipt.error ? 'refused' : 'sent',
          runId: utterance.target.runId,
          executionId: utterance.target.executionId,
          detail: receipt.error?.message ?? null,
          commandId: utterance.commandId,
        });
        onChange();
        return receipt.error
          ? { status: 'rejected', message: receipt.error.message }
          : {
              status: 'accepted',
              message: 'Accepted for the next request boundary; not yet delivered.',
            };
      }
      const result = await startNext(utterance.text, utterance.commandId, [], permissionMode);
      await record({
        ...(permissionMode ? { permissionMode } : {}),
        intent: 'next',
        text: utterance.text,
        state: result.runId ? 'started' : 'refused',
        runId: result.runId,
        detail: result.detail,
        commandId: utterance.commandId,
        ...(result.auto ? { auto: result.auto } : {}),
      });
      await router.invalidate();
      onChange();
      return result.runId
        ? { status: 'accepted' }
        : { status: 'rejected', message: result.detail ?? 'The request was not accepted.' };
    } finally {
      voiceSubmitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const submitVoice = (utterance: VoiceTranscript): Promise<VoiceTranscriptReceipt> => {
    if (
      utterance.target.hostId !== window.location.origin ||
      utterance.target.sessionId !== session.sessionId
    )
      return Promise.resolve({
        status: 'rejected',
        message: 'The voice destination changed. Reconnect explicitly.',
      });
    if (busy || autoSaving.current)
      return Promise.resolve({
        status: 'rejected',
        message: 'Another request is being submitted. Retry this same utterance.',
      });
    // Keep the original request closure (model, policy, execution and startFrom) across a
    // lost receipt. New renders may already show the run started by this very command.
    let submit = voiceSubmissions.current.get(utterance.commandId);
    if (!submit) {
      submit = () => performVoice(utterance);
      voiceSubmissions.current.set(utterance.commandId, submit);
    }
    return submit();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy || autoSaving.current || unavailable) return;
    const submittedRevision = writeComposerDraft(session.sessionId, composerDraft);
    draftRevision.current = submittedRevision;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      if (intent === 'next') {
        const refs: RunReference[] = [...references, ...attachments, ...images];
        // The team is part of the request: changing it after a lost answer is a new request.
        const commandId = commandFor(
          autoCommandSeed(body, refs, autoChoice, team ? `corral:${team.corralId}` : teamMode) +
            (permissionMode ? `\u0000permission:${permissionMode}` : ''),
        );
        const { runId, detail, code, auto, cancelled, cancelError } = await startNext(
          body,
          commandId,
          refs,
          permissionMode,
        );
        await record({
          ...(permissionMode ? { permissionMode } : {}),
          intent,
          text: body,
          state: runId ? 'started' : 'refused',
          runId,
          detail,
          commandId,
          ...(auto ? { auto } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(images.length ? { images } : {}),
        });
        if (cancelled) {
          clearPending();
          if (cancelError) setError(cancelError);
          await router.invalidate();
          onChange();
          return;
        }
        if (!runId) return await refused(detail ?? t('failed', { message: '' }), code);
      } else if (intent === 'queue') {
        await record({
          intent,
          text: body,
          state: 'queued',
          ...(attachments.length ? { attachments } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        });
      } else if (intent === 'steer' && ownActive && steerTarget) {
        const commandId = commandFor(`steer\u0000${steerTarget}\u0000${body}`);
        const receipt = await transport.sendCommand({
          schemaVersion: '0.1',
          commandId,
          runId: ownActive.runId,
          type: 'steer',
          payload: { targetExecutionId: steerTarget, text: body, delivery: 'next_request' },
        });
        await record({
          intent,
          text: body,
          state: receipt.error ? 'refused' : 'sent',
          runId: ownActive.runId,
          executionId: steerTarget,
          detail: receipt.error?.message ?? null,
          commandId,
        });
        if (receipt.error) return await refused(receipt.error.message, receipt.error.code);
      } else if (intent === 'explain') {
        const corral = team ? await repository.get(team.corralId) : null;
        // An auto session asks with its own model.
        const profile = team
          ? (corral?.definition.roles[0]?.modelProfile ?? 'model-a')
          : autoChoice.modelProfile;
        if (!latest) {
          setError(t('noResult'));
          return;
        }
        const result = await services.startExplain({
          commandId: commandFor(`explain\u0000${body}`),
          sessionId: session.sessionId,
          question: body,
          modelProfile: profile,
          mode: runMode,
          startFrom: { runId: latest.runId, artifactVersionId: latest.id },
        });
        await record({
          intent,
          text: body,
          state: result.runId ? 'started' : 'refused',
          runId: result.runId,
          detail: result.receipt.error?.message ?? null,
        });
        if (!result.runId)
          return await refused(
            result.receipt.error?.message ?? t('noResult'),
            result.receipt.error?.code,
          );
      } else {
        return;
      }
      clearPending();
      clearSentComposerDraft(
        session.sessionId,
        submittedRevision,
        intent !== 'next' && intent !== 'queue',
        intent !== 'next',
      );
      await router.invalidate();
      onChange();
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') {
        clearPending();
        return;
      }
      // The answer was lost: the request may or may not have arrived. The text stays, and a
      // retry reuses the same command ID, so the runtime returns the first receipt.
      setRefusal({
        message: failure instanceof Error ? failure.message : String(failure),
        network: true,
      });
    } finally {
      setBusy(false);
    }
  };

  // "Edit the request again" on a refused turn brings its text back here.
  useEffect(() => {
    const take = (event: Event) => {
      const value = (
        event as CustomEvent<
          | string
          | {
              text: string;
              permissionMode?: PermissionMode;
              attachments?: TextAttachment[];
              images?: ImageAttachment[];
            }
        >
      ).detail;
      if (
        typeof value !== 'string' &&
        (typeof value !== 'object' ||
          !value ||
          typeof value.text !== 'string' ||
          (value.permissionMode !== undefined &&
            !PermissionMode.safeParse(value.permissionMode).success) ||
          (value.attachments !== undefined && !validTextAttachments(value.attachments)) ||
          (value.images !== undefined && !ImageAttachments.safeParse(value.images).success))
      )
        return;
      setText(typeof value === 'string' ? value : value.text);
      setPermissionMode(typeof value === 'string' ? undefined : value.permissionMode);
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      setAttachments(typeof value === 'string' ? [] : (value.attachments ?? []));
      setImages(typeof value === 'string' ? [] : (value.images ?? []));
      setLock(null);
      setRefusal(null);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(EDIT_REQUEST, take);
    return () => window.removeEventListener(EDIT_REQUEST, take);
  }, []);

  const requestStop = () => {
    stopTarget.current = ownActive?.runId ?? null;
    setConfirmStop(stopTarget.current !== null);
  };
  const runCommand = async (type: 'pause' | 'resume' | 'cancel', runId = ownActive?.runId) => {
    if (!runId) return;
    const receipt = await transport
      .sendCommand(
        type === 'cancel'
          ? {
              schemaVersion: '0.1',
              commandId: newCommandId(),
              runId,
              type,
              payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
            }
          : {
              schemaVersion: '0.1',
              commandId: newCommandId(),
              runId,
              type,
              payload: { scope: 'run' },
            },
      )
      .catch((failure: unknown) => ({
        error: { message: failure instanceof Error ? failure.message : String(failure) },
      }));
    if (receipt.error) setError(receipt.error.message);
    onChange();
  };

  const startQueued = async (entry: SessionEntry) => {
    setBusy(true);
    const queuedReferences = entry.attachments ?? [];
    try {
      const commandId = commandFor(
        `queue\u0000${entry.entryId}\u0000${autoCommandSeed(entry.text, queuedReferences, autoChoice, team ? `corral:${team.corralId}` : teamMode)}\u0000${entry.permissionMode ?? ''}`,
      );
      const { runId, detail, auto, cancelError } = await startNext(
        entry.text,
        commandId,
        queuedReferences,
        entry.permissionMode,
      );
      const saved = await repository.updateSessionEntry(session.sessionId, entry.entryId, {
        state: runId ? 'started' : 'refused',
        runId,
        detail,
        ...(auto ? { auto } : {}),
      });
      if (!saved.ok) throw new Error(t('failed', { message: saved.message }));
      clearPending();
      if (cancelError) setError(cancelError);
      await router.invalidate();
      onChange();
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') clearPending();
      else
        setError(
          t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
        );
    } finally {
      setBusy(false);
    }
  };
  const removeQueued = async (entry: SessionEntry) => {
    await repository.updateSessionEntry(session.sessionId, entry.entryId, { state: 'dismissed' });
    await router.invalidate();
  };
  /** Editing a queued task takes it back into the box; sending again records a new version. */
  const editQueued = async (entry: SessionEntry) => {
    setAttachmentEpoch((epoch) => epoch + 1);
    setAttachmentsBusy(false);
    setImagesBusy(false);
    setText(entry.text);
    setPermissionMode(entry.permissionMode);
    setAttachments(entry.attachments ?? []);
    setImages(entry.images ?? []);
    setChosen('queue');
    setLock({ intent: 'queue', target: null });
    await repository.updateSessionEntry(session.sessionId, entry.entryId, {
      state: 'dismissed',
      detail: 'edited',
    });
    await router.invalidate();
  };

  // Auto-start, when switched on: only on a run's end seen by this page, never on load.
  const wasActive = useRef(Boolean(active));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the run ending only
  useEffect(() => {
    const ended = wasActive.current && !active;
    wasActive.current = Boolean(active);
    const next = queued[0];
    if (ended && autoStart && next) void startQueued(next);
  }, [active, ownActive]);

  const updateTeam = async (corralId: string) => {
    const result = await repository.updateSession(session.sessionId, {
      corralId: corralId || null,
      expectedRevision: session.revision,
    });
    if (!result.ok) setError(t('failed', { message: result.message }));
    else await router.invalidate();
  };

  // Earlier requests, newest first, for ↑ in an empty box.
  const history = session.entries
    .map((e) => e.text)
    .filter((value, index, all) => value.trim() && all.lastIndexOf(value) === index)
    .reverse();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME composition's Enter confirms the text; it never sends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (isSendKey(event, prefs.sendKey)) {
      event.preventDefault();
      void send();
      return;
    }
    const box = event.currentTarget;
    const recalled = recall >= 0 && text === history[recall];
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      (text === '' || recalled) &&
      box.selectionStart === box.selectionEnd
    ) {
      const next = event.key === 'ArrowUp' ? recall + 1 : recall - 1;
      if (next < -1 || next >= history.length) return;
      event.preventDefault();
      setRecall(next);
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      write(next === -1 ? '' : (history[next] ?? ''));
      const recalledEntry =
        next === -1 ? undefined : session.entries.findLast((entry) => entry.text === history[next]);
      setAttachments(recalledEntry?.attachments ?? []);
      setPermissionMode(recalledEntry?.permissionMode);
      setImages(recalledEntry?.images ?? []);
    }
  };

  // UX-04: with live models chosen, a role whose model is not connected stops the request
  // before it is sent, with the way to connect it.
  const notReady =
    runMode === 'live' && (intent === 'next' || intent === 'explain') && profiles
      ? roles.filter((r) => !profiles.some((p) => p.profileId === r.profileId && p.available))
      : [];
  // an auto request on a disconnected model is stopped, never simulated instead.
  const autoBlocked =
    isAuto &&
    (intent === 'next' || intent === 'explain') &&
    profiles !== null &&
    autoNotReady(autoChoice, profiles, runMode);
  const autoProfile = profiles?.find((p) => p.profileId === autoChoice.modelProfile);
  const reasoningBlocked =
    isAuto && intent === 'next' && autoReasoningUnsupported(autoChoice, profiles, runMode);
  const liveUnavailable =
    runMode === 'live' && !live && (intent === 'next' || intent === 'explain');
  const unavailable =
    liveUnavailable ||
    attachmentsBusy ||
    imagesBusy ||
    (attachments.length > 0 && intent !== 'next' && intent !== 'queue') ||
    autoBlocked ||
    reasoningBlocked ||
    notReady.length > 0 ||
    resolved.blocked !== null ||
    missingChips.length > 0 ||
    (missingTeam && (intent === 'next' || intent === 'explain')) ||
    (intent === 'explain' && !latest) ||
    (intent === 'steer' && !steerTarget);
  const stopping = Boolean(ownActive) && !text.trim();
  // What Send does now, said where it is pressed (#89).
  const sendMeaning = intent === 'next' ? t('send') : `${t('send')} · ${t(`intent.${intent}`)}`;
  // Items this intent does not carry share one notice and one wording (#89).
  const heldForNew = [
    ...(chips.length && intent !== 'next' ? (['references'] as const) : []),
    ...(images.length > 0 && intent !== 'next' ? (['images'] as const) : []),
    ...(attachments.length > 0 && intent !== 'next' && intent !== 'queue'
      ? (['attachments'] as const)
      : []),
  ];
  const why = (allowedHere: boolean) => (allowedHere ? undefined : tc('notNow'));

  useRegisterCommands('composer', [
    ...(['next', 'queue', 'steer'] as SessionIntent[]).map(
      (value): AppCommand => ({
        id: `intent:${value}`,
        title: t(`intent.${value}`),
        group: tc('groupRequest'),
        slash: value,
        keywords: [t(`intentShort.${value}`)],
        disabled: !allowed.includes(value),
        ...(allowed.includes(value) ? {} : { hint: tc('notNow') }),
        run: () => {
          chooseIntent(value);
          input.current?.focus();
        },
      }),
    ),
    {
      id: 'run:pause',
      title: tr('pause'),
      group: tc('groupRun'),
      slash: 'pause',
      disabled: ownActive?.status !== 'running',
      hint: why(ownActive?.status === 'running'),
      run: () => void runCommand('pause'),
    },
    {
      id: 'run:resume',
      title: tr('resume'),
      group: tc('groupRun'),
      slash: 'resume',
      disabled: ownActive?.status !== 'paused',
      hint: why(ownActive?.status === 'paused'),
      run: () => void runCommand('resume'),
    },
    {
      id: 'run:stop',
      title: tr('cancelRun'),
      group: tc('groupRun'),
      slash: 'stop',
      shortcutId: 'run.stop',
      shortcut: shortcutLabel('run.stop'),
      disabled: !ownActive,
      hint: why(Boolean(ownActive)),
      run: requestStop,
    },
    {
      id: 'composer:team',
      title: t('chooseTeam'),
      group: tc('groupRequest'),
      slash: 'team',
      keywords: [t('autoTeam'), ...corrals.map((c) => c.name)],
      run: () => setTeamOpen(true),
    },
    {
      id: 'composer:models',
      title: tc('models.title'),
      group: tc('groupRequest'),
      slash: 'model',
      run: () => setModelsOpen(true),
    },
    {
      id: 'composer:focus',
      title: tc('focus'),
      group: tc('groupRequest'),
      shortcutId: 'composer.focus',
      shortcut: shortcutLabel('composer.focus'),
      run: () => input.current?.focus(),
    },
  ]);
  const commands = useRegisteredCommands();
  return (
    <ComposerSurface.Shell>
      {queued.length > 0 ? (
        <section aria-label={t('queueHeading')} className="mx-3 rounded-t-xl bg-raised px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t('queueHeading')} · {queued.length}
            </h3>
            <Switch
              label={t('autoStart')}
              title={t('autoStartHint')}
              checked={autoStart}
              onToggle={() => setAutoStart(!autoStart)}
            />
          </div>
          <ul className="mt-1 flex flex-col">
            {queued.map((entry) => (
              <li key={entry.entryId} className="group/queued flex items-center gap-1 text-ui">
                <div className="min-w-0 flex-1">
                  <p className="truncate" title={entry.text}>
                    {entry.text}
                  </p>
                  {entry.attachments?.length ? (
                    <TextAttachmentList attachments={entry.attachments} />
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={Boolean(active) || busy || missingTeam}
                  onClick={() => void startQueued(entry)}
                >
                  {t('startNow')}
                </Button>
                <Button variant="ghost" size="compact" onClick={() => void editQueued(entry)}>
                  {t('editQueued')}
                </Button>
                <Button variant="ghost" size="compact" onClick={() => void removeQueued(entry)}>
                  {t('remove')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ComposerDock summary={<OverviewAccess />} />
      <ComposerSurface.Host>
        <ComposerPlan />
        <section aria-label={t('requestLabel')} className="flex flex-col gap-1 p-2">
          {resolved.blocked ? (
            <Banner data-testid="intent-blocked" status="warning" contrast="high" size="compact">
              <BannerTitle>
                {resolved.blocked === 'target'
                  ? tc('blocked.target', { name: targetName(steerTarget) })
                  : resolved.blocked === 'run'
                    ? tc('blocked.run')
                    : tc('blocked.intent', { intent: t(`intentShort.${intent}`) })}
              </BannerTitle>
              <BannerActions>
                {allowed
                  .filter((value) => value !== intent)
                  .map((value) => (
                    <Button
                      key={value}
                      variant="secondary"
                      size="compact"
                      onClick={() => chooseIntent(value)}
                    >
                      {tc(`switchTo.${value}`)}
                    </Button>
                  ))}
              </BannerActions>
            </Banner>
          ) : null}
          {notReady.length ? (
            <Banner data-testid="models-not-ready" status="warning" contrast="high" size="compact">
              <BannerTitle>
                {tc('models.notReady', {
                  roles: notReady.map((r) => `${r.name} (${r.profileId})`).join(', '),
                })}
              </BannerTitle>
              <BannerActions>
                <Button size="compact" render={<Link {...navigation.link('models')} />}>
                  {tc('models.connect')}
                </Button>
              </BannerActions>
            </Banner>
          ) : null}
          {autoBlocked ? (
            <Banner data-testid="models-not-ready" status="warning" contrast="high" size="compact">
              <BannerTitle>
                {t('autoNotReady', { model: autoProfile?.label ?? autoChoice.modelProfile })}
              </BannerTitle>
              <BannerActions>
                <Button size="compact" render={<Link {...navigation.link('models')} />}>
                  {tc('models.connect')}
                </Button>
              </BannerActions>
            </Banner>
          ) : null}
          {missingTeam && (intent === 'next' || intent === 'explain') ? (
            <p role="alert" data-testid="selected-team-missing" className="text-xs text-warning">
              {t('selectedTeamMissing')}
            </p>
          ) : null}
          {refusal ? (
            <RefusalHelp
              message={refusal.message}
              code={refusal.code}
              network={refusal.network}
              onRetry={() => void send()}
              onQueue={() => {
                setRefusal(null);
                chooseIntent('queue');
              }}
            />
          ) : null}
          {missingChips.length ? (
            <p role="alert" className="text-xs text-danger">
              {tc('missingReferences', { count: missingChips.length })}
            </p>
          ) : null}
          {refusal?.code === 'RUN_ALREADY_ACTIVE' ? (
            <DevelopmentMode sessionId={session.sessionId} onlyActive />
          ) : null}
          {chips.length ? (
            <ul aria-label={tc('references')} className="flex flex-wrap gap-1">
              {chips.map((item) => (
                <li
                  key={item.id}
                  data-missing={missing.has(item.id) || undefined}
                  className={`flex max-w-full items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 text-xs ${missing.has(item.id) ? 'bg-danger/10 text-danger line-through' : 'bg-subtle'}`}
                >
                  <span className="truncate font-mono" title={item.label}>
                    {mentionToken(item).slice(1)}
                  </span>
                  {missing.has(item.id) ? (
                    <span className="sr-only">{tc('referenceGone')}</span>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-tiny"
                    aria-label={tc('removeReference', { label: item.label })}
                    onClick={() => {
                      write(text.split(mentionToken(item)).join('').replace(/ {2,}/g, ' '));
                      setPicked((list) => list.filter((x) => x.id !== item.id));
                    }}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <ImageAttachmentPicker
            key={`images:${attachmentEpoch}`}
            inputRef={imageFiles}
            enabled={intent === 'next'}
            sessionId={session.sessionId}
            value={images}
            onChange={setImages}
            onBusyChange={setImagesBusy}
            disabled={busy}
          />
          <TextAttachmentPicker
            key={`text:${attachmentEpoch}`}
            inputRef={textFiles}
            value={attachments}
            onChange={setAttachments}
            onLoading={setAttachmentsBusy}
            disabled={busy}
            enabled={intent === 'next' || intent === 'queue'}
            hideList
          />
          <SourceAttachments
            value={attachments}
            onChange={setAttachments}
            disabled={busy || attachmentsBusy}
          />
          {attachments.length > 0 && intent !== 'next' && intent !== 'queue' ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            >
              <span>{contextMessages('nextOrQueue')}</span>
              {allowed
                .filter((value) => value === 'next' || value === 'queue')
                .map((value) => (
                  <Button
                    key={value}
                    variant="tertiary"
                    size="compact"
                    onClick={() => chooseIntent(value)}
                  >
                    {tc(`switchTo.${value}`)}
                  </Button>
                ))}
            </div>
          ) : null}
          <ComposerInput
            inputRef={input}
            label={t('requestLabel')}
            placeholder={tc('placeholder')}
            value={text}
            onChange={(value) => {
              setRecall(-1);
              write(value);
            }}
            onKeyDown={onKeyDown}
            commands={commands}
            searchMentions={searchMentions}
            onMention={(item) => setPicked((list) => [...list, item])}
          />
          <div className="flex flex-wrap items-center gap-0.5">
            <Tooltip content={tc('addReference')}>
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={tc('addReference')}
                onClick={() => {
                  const box = input.current;
                  const at = box?.selectionStart ?? text.length;
                  const before = text.slice(0, at);
                  const head = `${before}${before && !/\s$/.test(before) ? ' ' : ''}@`;
                  write(`${head}${text.slice(at)}`);
                  requestAnimationFrame(() => {
                    box?.focus();
                    box?.setSelectionRange(head.length, head.length);
                  });
                }}
              >
                <AtSign />
              </Button>
            </Tooltip>
            <Menu>
              <Tooltip content={tc('attachmentActions')}>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={tc('attachmentActions')}
                      disabled={
                        busy ||
                        attachmentsBusy ||
                        imagesBusy ||
                        (intent !== 'next' && intent !== 'queue')
                      }
                    />
                  }
                >
                  <Plus />
                </MenuTrigger>
              </Tooltip>
              <MenuPopup align="start">
                {mode === 'server' ? (
                  <MenuItem
                    disabled={intent !== 'next' || images.length >= IMAGE_MAX_COUNT}
                    onClick={() => imageFiles.current?.click()}
                  >
                    {tc('attachImages')}
                  </MenuItem>
                ) : null}
                <MenuItem
                  disabled={attachments.length >= TEXT_ATTACHMENT_MAX_COUNT}
                  onClick={() => textFiles.current?.click()}
                >
                  {tc('attachText')}
                </MenuItem>
              </MenuPopup>
            </Menu>

            {allowed.length > 1 && !resolved.blocked ? (
              <Select
                variant="chip"
                label={t('intentLabel')}
                value={intent}
                onValueChange={chooseIntent}
                options={allowed.map((value) => ({
                  value,
                  label: t(`intentShort.${value}`),
                  hint: t(`intentHint.${value}`),
                }))}
              />
            ) : intent !== 'next' || resolved.blocked ? (
              <span className="px-2 text-ui text-muted-foreground">
                {t(`intentShort.${intent}`)}
              </span>
            ) : null}
            {intent === 'steer' ? (
              <Select
                variant="chip"
                label={t('target')}
                value={steerTarget || null}
                placeholder={t('noTarget')}
                onValueChange={chooseTarget}
                options={[
                  ...(steerTarget && !targets.some((x) => x.id === steerTarget)
                    ? [
                        {
                          value: steerTarget,
                          label: tc('ended', { name: targetName(steerTarget) }),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...targets.map((x) => ({ value: x.id, label: x.label })),
                ]}
                disabled={targets.length === 0}
              />
            ) : null}
            {intent === 'next' && !resolved.blocked ? (
              <Select
                variant="chip"
                label={tc('teamLabel')}
                value={team ? `corral:${team.corralId}` : teamMode}
                disabled={busy}
                open={teamOpen}
                onOpenChange={setTeamOpen}
                onValueChange={(value) => {
                  const choice = String(value);
                  if (choice === 'manage')
                    void navigate({
                      to: '/projects/$projectId',
                      params: { projectId: session.projectId },
                      hash: 'corrals',
                    });
                  else if (choice.startsWith('corral:')) void updateTeam(choice.slice(7));
                  else {
                    setTeamMode(choice === 'auto' ? 'auto' : 'none');
                    if (!isAuto) void updateTeam('');
                  }
                }}
                options={[
                  { value: 'none', label: tc('teamNone'), hint: tc('teamNoneHint') },
                  // Corral: the automatic team first, then each saved Corral.
                  {
                    value: 'auto',
                    label: tc('teamAuto'),
                    hint: tc('teamAutoHint'),
                    group: tc('teamCorralGroup'),
                  },
                  ...corrals.map((corral) => ({
                    value: `corral:${corral.corralId}`,
                    label: corral.name,
                    hint: tc('teamCorralHint'),
                    group: tc('teamCorralGroup'),
                  })),
                  // Creating or editing a Corral happens on the project page.
                  { value: 'manage', label: tc('manageCorrals'), group: tc('teamCorralGroup') },
                ]}
              />
            ) : null}
            {(isAuto || team) && (intent === 'next' || intent === 'explain') && profiles ? (
              <AutoModelMenu
                value={autoChoice}
                profiles={profiles}
                showReasoning={intent === 'next'}
                disabled={busy}
                open={autoModelOpen}
                onOpenChange={setAutoModelOpen}
                onChange={(value) => void updateAuto(value)}
              />
            ) : null}
            {intent === 'next' || intent === 'queue' ? (
              <PermissionModePicker
                value={permissionMode}
                onChange={setPermissionMode}
                disabled={busy}
              />
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <LiveVoice
                api={services.voice ?? null}
                target={{
                  hostId: window.location.origin,
                  sessionId: session.sessionId,
                  ...(ownActive ? { runId: ownActive.runId } : {}),
                  ...(ownActive && steerTarget ? { executionId: steerTarget } : {}),
                }}
                targetLabel={session.title}
                onTranscript={submitVoice}
              />
              {choosingAuto ? (
                <Tooltip content={t('cancelAutoChoice')}>
                  <Button
                    variant="tertiary"
                    size="icon-compact"
                    aria-label={t('cancelAutoChoice')}
                    onClick={cancelAuto}
                  >
                    <Square className="fill-current" />
                  </Button>
                </Tooltip>
              ) : stopping ? (
                <Tooltip content={tr('cancelRun')} shortcut={shortcutLabel('run.stop')}>
                  <Button
                    variant="tertiary"
                    size="icon-compact"
                    aria-label={tr('cancelRun')}
                    onClick={requestStop}
                  >
                    <Square className="fill-current" />
                  </Button>
                </Tooltip>
              ) : (
                <Tooltip content={sendMeaning} shortcut={sendKeyLabel(prefs.sendKey)}>
                  <Button
                    size="icon-compact"
                    aria-label={t('send')}
                    aria-description={sendMeaning}
                    disabled={busy || !text.trim() || unavailable}
                    onClick={() => void send()}
                  >
                    <ArrowUp />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        </section>
      </ComposerSurface.Host>
      <div className="flex min-h-5 flex-wrap items-center gap-x-2 px-4 pt-1.5 text-2xs text-muted-foreground">
        <ComposerStats runs={runs} />
        {(intent === 'next' || intent === 'explain') && isAuto ? (
          <AutoPreRunSummary session={session} mode={runMode} intent={intent} />
        ) : null}
        {intent === 'explain' && !latest ? (
          <span className="text-warning">{t('noResult')}</span>
        ) : null}
        {liveUnavailable ? <p role="alert">{tc('liveUnavailable')}</p> : null}
        {heldForNew.length ? (
          <div role="status" className="flex flex-wrap items-center gap-2 text-warning">
            <span>
              {tc('heldForNew', {
                items: format.list(heldForNew.map((item) => tc(`held.${item}`))),
              })}
            </span>
          </div>
        ) : null}
        {reasoningBlocked ? (
          <p role="status" data-testid="reasoning-not-supported" className="text-warning">
            {tc('reasoningUnsupportedHint')}
          </p>
        ) : null}
        {(intent === 'next' || intent === 'explain') && team ? (
          <PreRunSummary session={session} team={team} mode={runMode} intent={intent} />
        ) : null}
        {intent === 'next' && lastEnded ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('continuesConversation')}</span>
          </>
        ) : null}
        {intent === 'explain' && latest ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('fromResult', { label: latest.label })}</span>
          </>
        ) : null}
        {intent === 'steer' ? <span>{t('intentHint.steer')}</span> : null}
        {intent === 'queue' ? <span>{t('intentHint.queue')}</span> : null}
      </div>
      {error ? (
        <p role="alert" className="px-4 pt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Dialog open={modelsOpen} onOpenChange={setModelsOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tc('models.title')}</DialogTitle>
            <DialogDescription>
              {runMode === 'live' ? tc('models.liveNote') : tc('models.mockNote')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {team ? (
              <ModelAssignments roles={roles} profiles={profiles} />
            ) : (
              <p
                className="text-sm text-muted-foreground"
                data-testid={isAuto ? 'auto-model' : undefined}
              >
                {missingTeam
                  ? t('selectedTeamMissing')
                  : `${t('autoHint')} ${autoProfile?.label ?? autoChoice.modelProfile}`}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {team ? (
              <Button
                variant="tertiary"
                render={
                  <Link
                    to="/corrals/$corralId/edit"
                    params={{ corralId: team.corralId }}
                    search={{ fromSession: session.sessionId }}
                  />
                }
              >
                {t('editTeam')}
              </Button>
            ) : null}
            {mode === 'server' ? (
              <Button render={<Link {...navigation.link('models')} />}>
                {tc('models.settings')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr('cancelRun')}</DialogTitle>
            <DialogDescription>{tr('cancelRunExplain')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="tertiary" onClick={() => setConfirmStop(false)}>
              {tr('keepRunning')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmStop(false);
                if (stopTarget.current) void runCommand('cancel', stopTarget.current);
              }}
            >
              {tr('confirmCancelRun')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </ComposerSurface.Shell>
  );
}

/** The newest final result among the session's ended runs. */
function useLatestResult(runs: RunSummary[]) {
  const { transport } = useServices();
  const [latest, setLatest] = useState<{ runId: string; id: string; label: string } | null>(null);
  // Newest first; a joined key so the lookup reruns only when the ended runs change.
  const key = runs
    .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
    .map((r) => r.runId)
    .reverse()
    .join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const runId of key ? key.split(',') : []) {
        const { projection } = await transport.getSnapshot(runId);
        const id = finalResultId(projection);
        const artifact = id ? projection.artifacts[id] : undefined;
        if (id && artifact) {
          if (live) setLatest({ runId, id, label: `${artifact.name} v${artifact.version}` });
          return;
        }
      }
      if (live) setLatest(null);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [transport, key]);
  return latest;
}

/**
 * What the next run would start with: team, models, file work, limits and
 * mode, read from the saved team and the working copy, never guessed.
 */
function PreRunSummary({
  session,
  team,
  mode,
  intent,
}: {
  session: WorkSession;
  team: CorralSummary;
  mode: 'mock' | 'live';
  intent: 'next' | 'explain';
}) {
  const t = useTranslations('Sessions');
  const { repository, workspaces } = useServices();
  const [text, setText] = useState<string | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  useEffect(() => {
    const changed = () => setWorkspaceRevision((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  // A new team revision changes what the next run would use.
  const revision = team.definitionRevision;
  useEffect(() => {
    void revision;
    void workspaceRevision;
    let live = true;
    void (async () => {
      const record = await repository.get(team.corralId);
      if (!record) return;
      const copy = workspaces
        ? await workspaces.worktree(session.sessionId).catch(() => null)
        : null;
      const roles =
        intent === 'explain' ? record.definition.roles.slice(0, 1) : record.definition.roles;
      const fileTools =
        intent === 'next' && roles.some((r) => r.allowedWorkTools.includes('write_file'));
      const budget = record.definition.executionPolicy?.budget;
      if (!live) return;
      setText(
        t('preRun', {
          team: `${record.name} r${record.definitionRevision}`,
          profiles: [...new Set(roles.map((r) => r.modelProfile))].join(', '),
          files: fileTools ? (copy ? t('filesCopy') : t('filesNoCopy')) : t('filesNone'),
          calls: budget?.maxModelCalls ?? t('unlimited'),
          minutes:
            budget?.runDeadlineMs === undefined
              ? t('unlimited')
              : Math.round(budget.runDeadlineMs / 60_000),
          mode: mode === 'live' ? t('modeLive') : t('modeMock'),
        }),
      );
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [
    repository,
    workspaces,
    session.sessionId,
    team.corralId,
    revision,
    workspaceRevision,
    mode,
    intent,
    t,
  ]);
  return text ? <span data-testid="pre-run">{text}</span> : null;
}

/** Mode and file work for the next auto request. The team control says Auto, and the model menu says the model when one can be chosen. */
function AutoPreRunSummary({
  session,
  mode,
  intent,
}: {
  session: WorkSession;
  mode: 'mock' | 'live';
  intent: 'next' | 'explain';
}) {
  const t = useTranslations('Sessions');
  const { workspaces } = useServices();
  const [copy, setCopy] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  useEffect(() => {
    const changed = () => setWorkspaceRevision((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  useEffect(() => {
    void workspaceRevision;
    let live = true;
    void (workspaces?.worktree(session.sessionId) ?? Promise.resolve(null))
      .catch(() => null)
      .then((found) => live && setCopy(Boolean(found)));
    return () => {
      live = false;
    };
  }, [workspaces, session.sessionId, workspaceRevision]);
  const modeLabel = mode === 'live' ? t('modeLive') : t('modeMock');
  // Auto roles get file tools only with a working copy.
  const files = intent === 'next' && copy ? t('filesCopy') : null;
  return <span data-testid="pre-run">{[files, modeLabel].filter(Boolean).join(' · ')}</span>;
}

/** Each role of the team, the model profile it uses, and whether that model is ready. */
function ModelAssignments({
  roles,
  profiles,
}: {
  roles: RoleModel[];
  profiles: ProfileInfo[] | null;
}) {
  const tc = useTranslations('Composer');
  if (!roles.length) return <p className="text-sm text-muted-foreground">{tc('models.noTeam')}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line/60 text-sm" data-testid="model-assignments">
      {roles.map((role) => {
        const profile = profiles?.find((p) => p.profileId === role.profileId);
        const state = !profiles
          ? 'simulated'
          : !profile
            ? 'missing'
            : profile.available
              ? 'ready'
              : 'signin';
        return (
          <li key={role.roleId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span className="font-medium">{role.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{role.profileId}</span>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {profile?.label ?? ''}
            </span>
            <span
              className={`text-xs ${state === 'ready' ? 'text-success' : state === 'simulated' ? 'text-muted-foreground' : 'text-warning'}`}
            >
              {tc(`models.state.${state}`)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
