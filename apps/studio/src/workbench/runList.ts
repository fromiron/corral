import type { RunSummary, RuntimeTransport } from '@corral/core';
import { watchRefresh } from './refresh.ts';

type RunListResult = { runs: RunSummary[] } | { error: unknown };
/**
 * `repeated`: the answer to a listing asked before this consumer joined (the latest one, given
 * on joining so it has something to show, or one already on its way); it is not an answer asked
 * for since.
 */
type Reader = (
  result: RunListResult,
  current: () => boolean,
  force: boolean,
  repeated: boolean,
) => Promise<void>;
type Transport = Pick<RuntimeTransport, 'listRuns'>;
type Listener = (result: RunListResult, force: boolean, asked: number) => void;

function createSource(transport: Transport) {
  const listeners = new Set<Listener>();
  let latest: RunListResult | null = null;
  // Listings are numbered as they are asked for: a consumer tells one asked before it joined.
  let asked = 0;
  const watcher = watchRefresh(async (current, force) => {
    asked += 1;
    const number = asked;
    let result: RunListResult;
    try {
      result = { runs: await transport.listRuns() };
    } catch (error) {
      result = { error };
    }
    if (!current()) return;
    latest = result;
    for (const listener of listeners) listener(result, force, number);
  }, 1500);
  return { listeners, watcher, latest: () => latest, asked: () => asked };
}

const sources = new WeakMap<Transport, ReturnType<typeof createSource>>();

/** One discovery cadence per server connection; consumers retain their own read fences. */
export function watchRunList(transport: Transport, read: Reader) {
  let source = sources.get(transport);
  // A listing asked before this consumer joined answers it as a repeated one; a new source's
  // first listing is asked for it.
  const joined = source?.asked() ?? 0;
  if (!source) {
    source = createSource(transport);
    sources.set(transport, source);
  }
  const owner = source;
  let active = true;
  let loading = false;
  let pending: { result: RunListResult; force: boolean; repeated: boolean } | undefined;
  const drain = async () => {
    loading = true;
    while (active && pending) {
      const next = pending;
      pending = undefined;
      try {
        await read(next.result, () => active, next.force, next.repeated);
      } catch {
        // Consumers render their errors; one reader cannot stop discovery or another reader.
      }
    }
    loading = false;
  };
  const receive = (result: RunListResult, force: boolean, asked: number) => {
    if (!active) return;
    const repeated = asked <= joined;
    // A slow consumer needs the latest snapshot, not a queue of obsolete full histories.
    pending = { result, force: force || pending?.force === true, repeated };
    if (!loading) void drain();
  };
  owner.listeners.add(receive);
  const latest = owner.latest();
  if (latest) receive(latest, true, joined);
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
