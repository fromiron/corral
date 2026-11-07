'use client';

import { useEffect, useState } from 'react';

/**
 * The current time in ms, re-rendering every `intervalMs` while `enabled`.
 * Live counters (elapsed clocks, "17s ago", remaining-time bars) derive from
 * it instead of running their own timers. Ticks stop while the tab is hidden
 * and catch up on return.
 *
 *   const now = useNow(1000, status === "running");
 *   formatClock(now - startedAt)
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      setNow(Date.now());
      id = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled]);

  return now;
}
