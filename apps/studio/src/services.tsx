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
  probeServer,
  RestCorralRepository,
  RunModesApi,
  TerminalsApi,
  VaultApi,
  VoiceApi,
  WorkspacesApi,
} from '@corral/client';
import type { Clock } from '@corral/contracts';
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
  resolveUltraSelection,
  SIMULATED_MODELS,
  type StartRunResult,
} from '@corral/core';
import { createRunRecovery, type RunSessionStore } from '@corral/react';
import { createContext, type ReactNode, useContext } from 'react';
import { createDemoWorkspaces, type WorkspacesClient } from './demo/workspaces-client.ts';
import type {} from './desktop.tsx';
import { createRunSessions } from './runSessions.ts';
import { createDemoRuntime } from './runtime.ts';

// App-wide services. Studio served by the local server talks to it (saved Corrals, persistent
// runs); opened any other way it runs the in-browser runtime with simulated agents (ADR-016).
// Run pages and team editors keep separate views; the Coordinator owns active runs.

export interface StudioServices {
  mode: 'server' | 'browser';
  serverVersion?: string;
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
  /** The server can run real models (C-058); null in the in-browser runtime. */
  models: ModelsApi | null;
  harnesses: HarnessApi | null;
  live: boolean;
  /** A sandboxed address for HTML result previews (CR-009); the browser runtime has none. */
  previewUrl?: (runId: string, artifactVersionId: string) => string;
  /** A question about a result, as its own run in a session (CR-011). */
  startExplain: (request: ExplainStart) => Promise<StartRunResult>;
  /** A request in an auto session (CR-024): the runtime picks the template and starts it. */
  startAuto: (request: AutoRunStart, signal?: AbortSignal) => Promise<AutoStartResult>;
  /** Server cancellation also reconciles a start whose HTTP response was lost. */
  cancelAuto?: (request: AutoCancelRequest) => Promise<AutoCancelResult>;
  /** Work folders and file changes (CR-012); the browser demo has an in-memory one. */
  workspaces: WorkspacesClient | null;
  /** CR-049 meeting rounds; the in-browser runtime runs the same service locally. */
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

/** Takes `#bootstrap=<token>` off the address so it is neither reused nor shared. */
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
  const http = { baseUrl: '' };
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
    return {
      mode: 'server',
      serverVersion: health.version,
      workspaceId: 'workspaceId' in choices ? choices.workspaceId : undefined,
      repository: new RestCorralRepository(http),
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
    // The demo has no candidate copies, so a version 2 tournament runs as collaboration (CR-048).
    resolveUltra: (selection, primary, mode, _models, context) =>
      resolveUltraSelection(
        selection,
        primary,
        mode,
        SIMULATED_MODELS,
        selection.version === 2 ? (context?.fileTools ? 'no_isolation' : 'no_working_copy') : null,
      ),
  });
  const repository = createKeyValueCorralRepository(store, {
    clock: systemClock,
    newCorralId: () => `corral_${crypto.randomUUID().slice(0, 8)}`,
  });
  const workspaces = createDemoWorkspaces(workspace, repository, transport);
  const meetings = new MeetingService({
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
    // An in-memory example folder in the demo worker (02-UX-Spec §10).
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
      return autoStarter.start(request, {
        fileTools: Boolean(copy),
        ...(signal ? { signal } : {}),
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
