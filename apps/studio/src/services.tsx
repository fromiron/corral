import {
  type AutoRunStart,
  HarnessApi,
  HttpSseTransport,
  hasSession,
  ModelsApi,
  openSession,
  probeServer,
  RestCorralRepository,
  RunModesApi,
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
  type RunArchive,
  type RuntimeTransport,
  type StartRunResult,
} from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { createContext, type ReactNode, useContext } from 'react';
import { createDemoWorkspaces, type WorkspacesClient } from './demo/workspaces-client.ts';
import { createDemoRuntime } from './runtime.ts';

// App-wide services. Studio served by the local server talks to it (saved Corrals, persistent
// runs); opened any other way it runs the in-browser runtime with simulated agents (ADR-016).
// Run pages and team editors keep separate views; the Coordinator owns active runs.

export interface StudioServices {
  mode: 'server' | 'browser';
  repository: CorralRepository;
  transport: RuntimeTransport;
  readHistory: (runId: string) => Promise<RunArchive>;
  session: RunSessionStore;
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
  startAuto: (request: AutoRunStart) => Promise<AutoStartResult>;
  /** Work folders and file changes (CR-012); the browser demo has an in-memory one. */
  workspaces: WorkspacesClient | null;
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
  const health =
    window.location.pathname !== '/demo' && servedByLocalServer() ? await probeServer(http) : null;
  if (health) {
    const token = takeBootstrapToken();
    if (token) await openSession(http, token);
    const transport = new HttpSseTransport(http);
    const modesApi = new RunModesApi(http);
    const choices = await modesApi.read().catch(() => ({ modes: {} }));
    let modeWrite: Promise<void> = Promise.resolve();
    return {
      mode: 'server',
      repository: new RestCorralRepository(http),
      transport,
      readHistory: (runId) => transport.exportRun(runId, { privateTranscript: true }),
      session: createRunSession(transport),
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
      startAuto: (request) => transport.startAuto(request),
      workspaces: new WorkspacesApi(http),
    };
  }
  const { store, persistent } = browserStore(window.location.pathname === '/demo');
  const { transport, workspace, readHistory } = createDemoRuntime();
  // The demo's agents are simulated, so the local rule chooses and no model is called.
  const autoStarter = createAutoStarter({ startRun: (request) => transport.startRun(request) });
  const repository = createKeyValueCorralRepository(store, {
    clock: systemClock,
    newCorralId: () => `corral_${crypto.randomUUID().slice(0, 8)}`,
  });
  const workspaces = createDemoWorkspaces(workspace, repository, transport);
  return {
    mode: 'browser',
    persistent,
    sessionMissing: false,
    models: null,
    harnesses: null,
    live: false,
    repository,
    transport,
    readHistory,
    session: createRunSession(transport),
    editorSessions: new Map(),
    runModes: {},
    saveRunMode: async () => {},
    // An in-memory example folder in the demo worker (02-UX-Spec §10).
    workspaces,
    startAuto: async (request) => {
      const copy = await workspaces.worktree(request.sessionId).catch(() => null);
      return autoStarter.start(request, { fileTools: Boolean(copy) });
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
