/** Read-only refreshes share one in-flight request and wake after focus/reconnection. */
export function watchRefresh(
  read: (current: () => boolean, force: boolean) => Promise<void>,
  intervalMs: number,
  events: string[] = [],
) {
  let active = true;
  let loading = false;
  const refresh = async (force = true) => {
    if (!active || loading) return;
    loading = true;
    try {
      await read(() => active, force);
    } finally {
      loading = false;
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
