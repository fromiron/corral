/** Read-only refreshes share one in-flight request and wake after focus/reconnection. */
export function watchRefresh(
  read: (current: () => boolean, force: boolean) => Promise<void>,
  intervalMs: number,
  events: string[] = [],
) {
  let active = true;
  let loading = false;
  // A refresh asked while a read is out is read once more after it: the read out was asked
  // before, so it may not answer what the asker needs. Several such asks make one more read.
  let again: boolean | null = null;
  const refresh = async (force = true): Promise<void> => {
    if (!active) return;
    if (loading) {
      again = Boolean(again) || force;
      return;
    }
    loading = true;
    try {
      await read(() => active, force);
    } finally {
      loading = false;
    }
    if (again !== null && active) {
      const forced = again;
      again = null;
      await refresh(forced);
    }
  };
  // Callers render their read errors. A failed read must not stop future refreshes.
  const wake = () => void refresh().catch(() => {});
  const visible = () => {
    if (document.visibilityState === 'visible') wake();
  };
  const names = ['focus', 'online', ...events];
  for (const event of names) window.addEventListener(event, wake);
  document.addEventListener('visibilitychange', visible);
  const timer = window.setInterval(() => void refresh(false).catch(() => {}), intervalMs);
  wake();
  return {
    refresh: wake,
    dispose() {
      active = false;
      window.clearInterval(timer);
      for (const event of names) window.removeEventListener(event, wake);
      document.removeEventListener('visibilitychange', visible);
    },
  };
}
