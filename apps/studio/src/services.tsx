import type { Clock } from '@corral/contracts';
import {
  type CorralRepository,
  createKeyValueCorralRepository,
  type KeyValueStore,
} from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { createContext, type ReactNode, useContext } from 'react';
import { createDemoTransport } from './runtime.ts';

// App-wide services. One run session per page: a workspace has at most one active run.

export interface StudioServices {
  repository: CorralRepository;
  session: RunSessionStore;
  /** False when the browser refuses localStorage; Corrals then last for this tab only. */
  persistent: boolean;
}

const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

function browserStore(): { store: KeyValueStore; persistent: boolean } {
  try {
    const store = window.localStorage;
    const probe = 'corral:probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return { store, persistent: true };
  } catch {
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
}

export function createStudioServices(): StudioServices {
  const { store, persistent } = browserStore();
  return {
    persistent,
    repository: createKeyValueCorralRepository(store, {
      clock: systemClock,
      newCorralId: () => `corral_${crypto.randomUUID().slice(0, 8)}`,
    }),
    session: createRunSession(createDemoTransport()),
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
