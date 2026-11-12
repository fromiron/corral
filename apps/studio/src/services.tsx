import {
  type AutoCancelRequest,
  type AutoCancelResult,
  type AutoRunStart,
  createStartRecovery,
  HarnessApi,
  HttpSseTransport,
  hasSession,
  MeetingHandoffsApi,
  MeetingsApi,
  type MeetingsClient,
  ModelsApi,
  openSession,
  type PathEngineStatus,
  probeServer,
  RestCorralRepository,
  RunModesApi,
  SessionCompactionApi,
  type SessionDeletionRequest,
  type SessionDeletionSummary,
  TerminalsApi,
  VaultApi,
  VoiceApi,
  WorkspacesApi,
} from '@corral/client';
import type {
  CancelSessionCompactionCommand,
  Clock,
  CompactSessionCommand,
  Receipt,
} from '@corral/contracts';
import {
  type AutoStartResult,
  type CorralRepository,
  createAutoStarter,
  createKeyValueCorralRepository,
  explainDefinition,
  type KeyValueStore,
  MeetingDecisionsService,
  MeetingService,
  type RunArchive,
  type RuntimeTransport,
  type StartRunResult,
} from '@corral/core';
import { createRunRecovery, type RunSessionStore } from '@corral/react';
import { createContext, type ReactNode, useContext } from 'react';
import { createDemoWorkspaces, type WorkspacesClient } from './demo/workspaces-client.ts';
import type {} from './desktop.tsx';
import { createRunSessions } from './runSessions.ts';
import { createDemoRuntime } from './runtime.ts';
import { sessionFetch } from './sessionConnection.ts';
import { SessionSummaryStore } from './workbench/sessionSummaryStore.ts';

// App-wide services. Studio served by the local server talks to it (saved Corrals, persistent
// runs); opened any other way it runs the in-browser runtime with simulated agents.
// Run pages and team editors keep separate views; the Coordinator owns active runs.

export interface StudioServices {
  mode: 'server' | 'browser';
  serverVersion?: string;
  /** The server's path search engine now; the browser demo has only the built-in one. */
  pathEngine?: () => Promise<PathEngineStatus>;
  workspaceId?: string;
  repository: CorralRepository;
  transport: RuntimeTransport;
  readHistory: (runId: string) => Promise<RunArchive>;
  runFor: (runId: string) => RunSessionStore;
  sessionFor: (sessionId: string) => RunSessionStore;
  retainRun: (runId: string) => () => void;
  disposeRuns: () => void;
  editorSessions: Map<string, RunSessionStore>;
  runModes: Record<string, 'mock' | 'live'>;
  saveRunMode: (key: string, mode: 'mock' | 'live') => Promise<void>;
  /** False when Corrals do not outlive this tab (browser storage refused). */
  persistent: boolean;
  /** Server mode without a valid session: the bootstrap link must be opened again. */
  sessionMissing: boolean;
  /** The server can run real models; null in the in-browser runtime. */
  models: ModelsApi | null;
  harnesses: HarnessApi | null;
  live: boolean;
  /** A sandboxed address for HTML result previews; the browser runtime has none. */
  previewUrl?: (runId: string, artifactVersionId: string) => string;
  /** A question about a result, as its own run in a session. */
  startExplain: (request: ExplainStart) => Promise<StartRunResult>;
  /** A request in an auto session: the runtime picks the template and starts it. */
  startAuto: (request: AutoRunStart, signal?: AbortSignal) => Promise<AutoStartResult>;
  /** Server cancellation also reconciles a start whose HTTP response was lost. */
  cancelAuto?: (request: AutoCancelRequest) => Promise<AutoCancelResult>;
  /** Idle session compaction. Absent in the browser runtime, which has no model call. */
  compactSession?: (command: CompactSessionCommand) => Promise<Receipt>;
  cancelSessionCompaction?: (command: CancelSessionCompactionCommand) => Promise<Receipt>;
  /** The kept session summary and the outcome of an accepted compaction, shared by every view. */
  sessionSummaries?: SessionSummaryStore;
  /** Work folders and file changes; the browser demo has an in-memory one. */
  workspaces: WorkspacesClient | null;
  /** Session deletion exists on the local server. The browser demo has no delete. */
  sessionDeletion: {
    preview(sessionId: string): Promise<SessionDeletionSummary>;
    delete(sessionId: string, body: SessionDeletionRequest): Promise<void>;
  } | null;
  /** meeting rounds; the in-browser runtime runs the same service locally. */
  meetings: MeetingsClient;
  meetingHandoffs?: MeetingHandoffsApi;
  /** User PTYs exist only on the authenticated host, never in the browser demo. */
  terminals?: TerminalsApi | null;
  voice?: import('@corral/client').VoiceClient | null;
  vault?: import('@corral/client').VaultClient | null;
}

export interface ExplainStart {
  commandId: string;
  sessionId: string;
  question: string;
  modelProfile: string;
  mode: 'mock' | 'live';
  startFrom?: { runId: string; artifactVersionId: string };
}

const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

function browserStore(memoryOnly = false): { store: KeyValueStore; persistent: boolean } {
  if (!memoryOnly) {
    try {
      const store = window.localStorage;
      const probe = 'corral:probe';
      store.setItem(probe, '1');
      store.removeItem(probe);
      return { store, persistent: true };
    } catch {
      // Storage can be refused in private browsing; keep the editor usable in memory.
    }
  }
  const memory = new Map<string, string>();
  return {
    persistent: false,
    store: {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
      removeItem: (key) => void memory.delete(key),
    },
  };
}

/** Removes `#bootstrap=<token>` from the address to avoid sharing it accidentally. */
function takeBootstrapToken(): string | null {
  const match = /^#bootstrap=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return match[1] ?? null;
}

/** Set by the local server on the page it serves; the demo build has no such tag. */
function servedByLocalServer(): boolean {
  return (
    document.querySelector('meta[name="corral-runtime"]')?.getAttribute('content') === 'server'
  );
}

export async function createStudioServices(): Promise<StudioServices> {
  const http = { baseUrl: '', fetch: sessionFetch };
  const needsServer = window.location.pathname !== '/demo' && servedByLocalServer();
  const health = needsServer ? await probeServer(http) : null;
  // A failed local or remote connection cannot change the host or persistence contract.
  // Leave the bootstrap token intact so retry can authenticate against the same server.
  if (needsServer && !health) throw new Error('SERVER_UNAVAILABLE');
  if (health) {
    const token = takeBootstrapToken();
    if (token) await openSession(http, token);
    const recovery = window.corralRemote
      ? createRunRecovery(window.localStorage, window.corralRemote.hostId)
      : undefined;
    const sessionCompaction = new SessionCompactionApi(http);
    const transport = new HttpSseTransport(
      http,
      recovery && window.corralRemote
        ? {
            commands: recovery,
            starts: createStartRecovery(window.localStorage, window.corralRemote.hostId),
          }
        : undefined,
    );
    const modesApi = new RunModesApi(http);
    const choices = await modesApi.read().catch(() => ({ modes: {} }));
    let modeWrite: Promise<void> = Promise.resolve();
    const runs = createRunSessions(transport, recovery);
    const repository = new RestCorralRepository(http);
    return {
      mode: 'server',
      serverVersion: health.version,
      pathEngine: async () => {
        const current = await probeServer(http);
        if (!current) throw new Error('SERVER_UNAVAILABLE');
        return current.pathEngine;
      },
      workspaceId: 'workspaceId' in choices ? choices.workspaceId : undefined,
      repository,
      sessionDeletion: {
        preview: (sessionId) => repository.deletionPreview(sessionId),
        delete: (sessionId, body) => repository.deleteSession(sessionId, body),
      },
      transport,
      readHistory: (runId) => transport.exportRun(runId, { privateTranscript: true }),
      runFor: runs.runFor,
      sessionFor: runs.sessionFor,
      retainRun: runs.retainRun,
      disposeRuns: runs.dispose,
      editorSessions: new Map(),
      runModes: choices.modes,
      saveRunMode: (key, mode) => {
        modeWrite = modeWrite.catch(() => {}).then(() => modesApi.set(key, mode));
        return modeWrite;
      },
      persistent: true,
      sessionMissing: !(await hasSession(http)),
      models: new ModelsApi(http),
      harnesses: new HarnessApi(http),
      live: health.live,
      previewUrl: (runId, artifactVersionId) => transport.previewUrl(runId, artifactVersionId),
      startExplain: (request) => transport.startExplain(request),
      startAuto: (request, signal) => transport.startAuto(request, signal),
      cancelAuto: (request) => transport.cancelAuto(request),
      compactSession: (command) => sessionCompaction.compact(command),
      cancelSessionCompaction: (command) => sessionCompaction.cancel(command),
      sessionSummaries: new SessionSummaryStore((sessionId, commandId) =>
        sessionCompaction.read(sessionId, commandId),
      ),
      workspaces: new WorkspacesApi(http),
      meetings: new MeetingsApi(http),
      meetingHandoffs: new MeetingHandoffsApi(http),
      terminals: new TerminalsApi(http),
      voice: new VoiceApi(http),
      vault: new VaultApi(http),
    };
  }
  const { store, persistent } = browserStore(window.location.pathname === '/demo');
  const { transport, workspace, readHistory } = createDemoRuntime();
  const runs = createRunSessions(transport);
  // The demo's agents are simulated, so the local rule chooses and no model is called.
  const autoStarter = createAutoStarter({
    startRun: (request) => transport.startRun(request),
    // a saved Corral lends its roles to the conversation lead.
    corral: (corralId) => repository.get(corralId),
  });
  const repository = createKeyValueCorralRepository(store, {
    clock: systemClock,
    newCorralId: () => `corral_${crypto.randomUUID().slice(0, 8)}`,
  });
  const workspaces = createDemoWorkspaces(workspace, repository, transport);
  const meetings = new MeetingService({
    random: Math.random,
    repository,
    transport,
    clock: systemClock,
    newRoundId: () => `round_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
  });
  const meetingDecisions = new MeetingDecisionsService({
    repository,
    clock: systemClock,
    newDecisionId: () => `decision_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  return {
    mode: 'browser',
    terminals: null,
    sessionDeletion: null,
    persistent,
    sessionMissing: false,
    models: null,
    harnesses: null,
    live: false,
    repository,
    transport,
    readHistory,
    runFor: runs.runFor,
    sessionFor: runs.sessionFor,
    retainRun: runs.retainRun,
    disposeRuns: runs.dispose,
    editorSessions: new Map(),
    runModes: {},
    saveRunMode: async () => {},
    // An in-memory example folder in the demo worker.
    workspaces,
    meetings: {
      view: (id) => meetings.view(id),
      send: (id, request) => meetings.send(id, request),
      stop: (id, roundId) => meetings.stop(id, roundId),
      sendQueued: (id) => meetings.sendQueued(id),
      dropQueued: (id) => meetings.dropQueued(id),
      editQueued: (id, request) => meetings.editQueued(id, request),
      adopt: (id, request) => meetingDecisions.adopt(id, request),
      withdraw: (id, request) => meetingDecisions.withdraw(id, request),
    },
    startAuto: async (request, signal) => {
      const copy = await workspaces.worktree(request.sessionId).catch(() => null);
      // As on the server: the stored session's criteria, read when the request is admitted.
      const sessionCriteria = (await repository.getSession(request.sessionId))?.criteria;
      return autoStarter.start(request, {
        fileTools: Boolean(copy),
        ...(signal ? { signal } : {}),
        ...(sessionCriteria?.length ? { sessionCriteria } : {}),
      });
    },
    // The in-browser runtime runs inline definitions itself.
    startExplain: ({ question, modelProfile, sessionId, startFrom, ...rest }) =>
      transport.startRun({
        schemaVersion: '0.1',
        ...rest,
        sessionId,
        definition: explainDefinition({
          id: `explain_${sessionId.replace(/^session_/, '')}`,
          question,
          modelProfile,
        }),
        ...(startFrom ? { startFrom } : {}),
      }),
  };
}

const ServicesContext = createContext<StudioServices | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: StudioServices;
  children: ReactNode;
}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): StudioServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside ServicesProvider');
  return services;
}
