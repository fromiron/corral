import type { RunSummary, RuntimeTransport } from '@corral/core';
import { watchRefresh } from './refresh.ts';

type RunListResult = { runs: RunSummary[] } | { error: unknown };
type Reader = (result: RunListResult, current: () => boolean, force: boolean) => Promise<void>;
type Transport = Pick<RuntimeTransport, 'listRuns'>;
type Listener = (result: RunListResult, force: boolean) => void;

function createSource(transport: Transport) {
  const listeners = new Set<Listener>();
  let latest: RunListResult | null = null;
  const watcher = watchRefresh(async (current, force) => {
    let result: RunListResult;
    try {
      result = { runs: await transport.listRuns() };
    } catch (error) {
      result = { error };
    }
    if (!current()) return;
    latest = result;
    for (const listener of listeners) listener(result, force);
  }, 1500);
  return { listeners, watcher, latest: () => latest };
}

const sources = new WeakMap<Transport, ReturnType<typeof createSource>>();

/** One discovery cadence per server connection; consumers retain their own read fences. */
export function watchRunList(transport: Transport, read: Reader) {
  let source = sources.get(transport);
  if (!source) {
    source = createSource(transport);
    sources.set(transport, source);
  }
  const owner = source;
  let active = true;
  let loading = false;
  let pending: { result: RunListResult; force: boolean } | undefined;
  const drain = async () => {
    loading = true;
    while (active && pending) {
      const next = pending;
      pending = undefined;
      try {
        await read(next.result, () => active, next.force);
      } catch {
        // Consumers render their errors; one reader cannot stop discovery or another reader.
      }
    }
    loading = false;
  };
  const receive: Listener = (result, force) => {
    if (!active) return;
    // A slow consumer needs the latest snapshot, not a queue of obsolete full histories.
    pending = { result, force: force || pending?.force === true };
    if (!loading) void drain();
  };
  owner.listeners.add(receive);
  const latest = owner.latest();
  if (latest) receive(latest, true);
  return {
    refresh() {
      if (active) owner.watcher.refresh();
    },
    dispose() {
      if (!active) return;
      active = false;
      pending = undefined;
      owner.listeners.delete(receive);
      if (owner.listeners.size === 0) {
        owner.watcher.dispose();
        sources.delete(transport);
      }
    },
  };
}
