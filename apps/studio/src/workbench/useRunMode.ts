import { useRef, useState } from 'react';
import { useServices } from '../services.tsx';

/** Only a person's selection is saved; opening a view never starts or replays work. */
export function useRunMode(projectId: string, kind: 'session' | 'corral', id: string) {
  const services = useServices();
  const key = JSON.stringify([projectId, kind, id]);
  const [choice, setChoice] = useState<{ key: string; mode: 'mock' | 'live' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const scope = useRef(key);
  scope.current = key;
  const mode = choice?.key === key ? choice.mode : (services.runModes[key] ?? 'mock');
  const select = (mode: 'mock' | 'live') => {
    setChoice({ key, mode });
    services.runModes[key] = mode;
    const version = ++latest.current;
    setError(null);
    void services.saveRunMode(key, mode).catch(() => {
      if (latest.current === version && scope.current === key) setError(key);
    });
  };
  return { mode, select, error: error === key };
}
