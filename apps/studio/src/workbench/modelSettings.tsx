import type { ModelsApi } from '@corral/client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { modelsChanged } from './useModels.ts';

export const ModelSettingsRefresh = createContext<() => Promise<void>>(async () => {});
export const useModelSettingsRefresh = () => useContext(ModelSettingsRefresh);

async function readModels(api: ModelsApi | null) {
  if (!api) return { profiles: [], providers: [], catalog: [], config: null };
  const [profiles, providers, catalog, config] = await Promise.all([
    api.profiles(),
    api.auth(),
    api.catalog(),
    api.config().catch(() => null),
  ]);
  return { profiles, providers, catalog, config };
}

/** Refresh only settings data, never the work route behind the settings dialog. */
export function useModelSettings(api: ModelsApi | null) {
  const [data, setData] = useState<Awaited<ReturnType<typeof readModels>>>({
    profiles: [],
    providers: [],
    catalog: [],
    config: null,
  });
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  // The lists were read once: screens that announce changes start from them.
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const value = await readModels(api);
      if (generation.current === request) {
        // A config that failed to read this time keeps the last one read, so open editors and
        // their drafts stay; the other lists are replaced.
        setData((before) => ({ ...value, config: value.config ?? before.config }));
        modelsChanged();
        setError(false);
        setLoaded(true);
      }
    } catch (error) {
      if (generation.current === request) setError(true);
      throw error;
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    setLoading(true);
    void refresh().catch(() => {});
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const pending = data.providers.some((p) => p.login && p.login.state !== 'failed');
  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh().catch(() => {});
      if (active) timer = setTimeout(() => void poll(), 1500);
    };
    // Schedule after settlement so a slow response cannot be invalidated by the next poll.
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, refresh]);
  return { ...data, refresh, error, loading, loaded };
}
