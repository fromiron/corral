import {
  HttpSseTransport,
  hasSession,
  ModelsApi,
  openSession,
  probeServer,
  RestCorralRepository,
} from '@corral/client';
import type { Clock } from '@corral/contracts';
import {
  type CorralRepository,
  createKeyValueCorralRepository,
  type KeyValueStore,
  type RuntimeTransport,
} from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { createContext, type ReactNode, useContext } from 'react';
import { createDemoTransport } from './runtime.ts';

// App-wide services. Studio served by the local server talks to it (saved Corrals, persistent
// runs); opened any other way it runs the in-browser runtime with simulated agents (ADR-016).
// One run session per page: a workspace has at most one active run.

export interface StudioServices {
  mode: 'server' | 'browser';
  repository: CorralRepository;
  transport: RuntimeTransport;
  session: RunSessionStore;
  /** False when Corrals do not outlive this tab (browser storage refused). */
  persistent: boolean;
  /** Server mode without a valid session: the bootstrap link must be opened again. */
  sessionMissing: boolean;
  /** The server can run real models (C-058); null in the in-browser runtime. */
  models: ModelsApi | null;
  live: boolean;
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
    return {
      mode: 'server',
      repository: new RestCorralRepository(http),
      transport,
      session: createRunSession(transport),
      persistent: true,
      sessionMissing: !(await hasSession(http)),
      models: new ModelsApi(http),
      live: health.live,
    };
  }
  const { store, persistent } = browserStore(window.location.pathname === '/demo');
  const transport = createDemoTransport();
  return {
    mode: 'browser',
    persistent,
    sessionMissing: false,
    models: null,
    live: false,
    repository: createKeyValueCorralRepository(store, {
      clock: systemClock,
      newCorralId: () => `corral_${crypto.randomUUID().slice(0, 8)}`,
    }),
    transport,
    session: createRunSession(transport),
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
