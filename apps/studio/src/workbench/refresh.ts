/** Read-only refreshes share one in-flight request and wake after focus/reconnection. */
export function watchRefresh(
  read: (current: () => boolean, force: boolean) => Promise<void>,
  intervalMs: number,
  events: string[] = [],
) {
  let active = true;
  let loading = false;
  // An explicit ask (focus, reconnection, a caller's refresh) made while a read is out is read
  // once more after it: the read out was asked before, so it may not answer what the asker needs.
  // Several such asks make one more read. A tick that lands during a read is dropped.
  let again = false;
  const refresh = async (force = true): Promise<void> => {
    if (!active) return;
    if (loading) {
      if (force) again = true;
      return;
    }
    loading = true;
    try {
      await read(() => active, force);
    } finally {
      loading = false;
      // Served whether that read answered or failed; never left for a later ask to double.
      if (again) {
        again = false;
        if (active) void refresh(true).catch(() => {});
      }
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
