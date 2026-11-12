import { type Presence, settle } from '@corral/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LivePresence } from './sessionList.ts';

interface Held {
  runId: string | null;
  /** The live state taken: an older value of a run already seen ended is not taken. */
  taken: Presence;
  shown: Presence;
  since: number | null;
  holdUntil: number | null;
}

interface Entry extends Omit<Held, 'taken'> {
  /** The mounted views that list this key; the entry goes when the last one stops. */
  owners: Set<object>;
}

/** Held states by key, shared by every view that shows them, and the runs seen ended. */
export interface PresenceHolds {
  entries: Map<string, Entry>;
  /** A run's ended state once any view saw it: it never shows in progress again. */
  ended: Map<string, Presence>;
}

export function createPresenceHolds(): PresenceHolds {
  return { entries: new Map(), ended: new Map() };
}

export interface PresenceClock {
  now(): number;
}

const systemClock: PresenceClock = { now: () => Date.now() };
const sharedHolds = createPresenceHolds();
/** Ended runs remembered, newest kept: far more than one screen lists. */
const ENDED_KEPT = 2000;

/** Forgets every hold and ended run the views share; tests start each case from nothing. */
export function forgetSharedPresenceHolds() {
  sharedHolds.entries.clear();
  sharedHolds.ended.clear();
}
const ENDED = new Set<Presence['kind']>(['succeeded', 'cancelled', 'failed', 'interrupted']);

/** What one key shows now, judged against what every view has committed. */
function step(holds: PresenceHolds, key: string, live: LivePresence, now: number): Held {
  const entry = holds.entries.get(key);
  const ended = live.runId === null ? undefined : holds.ended.get(live.runId);
  // A run seen ended stays ended: a later in-progress value of that run is an older list (a
  // cached one drawn first), so it neither shows nor starts a hold. Another run is news.
  const taken = ended && !ENDED.has(live.presence.kind) ? ended : live.presence;
  const result = settle(entry?.shown ?? null, taken, { since: entry?.since ?? null, now });
  return {
    runId: live.runId,
    taken,
    shown: result.presence,
    since: result.since,
    holdUntil: result.holdUntil,
  };
}

/**
 * What each keyed state shows through the exit grace (docs/specs/features/presence.md). The
 * run list has no end times, so a hold starts at the first sight of the end. Holds live in one
 * store that every mounted view (the sidebar and the project's Sessions tab) judges against, so
 * one session is held to one end everywhere, and one view judging again never clears or moves
 * a hold another view set. A run once seen ended never shows in progress again. Each view keeps
 * one timer for its earliest hold end and judges again when it rings, setting it again if the
 * hold has not ended yet. A key no mounted view lists is forgotten, so a view opened later shows
 * an end it did not see at once.
 */
export function useSettledPresence(
  live: ReadonlyMap<string, LivePresence>,
  clock: PresenceClock = systemClock,
  holds: PresenceHolds = sharedHolds,
): ReadonlyMap<string, Presence> {
  const owner = useRef({}).current;
  const [wake, setWake] = useState(0);
  const settled = useMemo(() => {
    void wake;
    const now = clock.now();
    return new Map([...live].map(([key, value]) => [key, step(holds, key, value, now)]));
  }, [live, clock, holds, wake]);
  const owned = useRef(new Set<string>());
  const timer = useRef<{ at: number; id: ReturnType<typeof setTimeout> } | null>(null);
  // Commit before paint. The store may have moved since this render (another view committed in
  // the same pass), so each key is judged again against it; a different answer draws again.
  useLayoutEffect(() => {
    const now = clock.now();
    let differs = false;
    let until: number | null = null;
    for (const [key, value] of live) {
      const held = step(holds, key, value, now);
      const owners = holds.entries.get(key)?.owners ?? new Set<object>();
      owners.add(owner);
      holds.entries.set(key, {
        runId: held.runId,
        shown: held.shown,
        since: held.since,
        holdUntil: held.holdUntil,
        owners,
      });
      if (held.runId !== null && ENDED.has(held.taken.kind) && !holds.ended.has(held.runId)) {
        holds.ended.set(held.runId, held.taken);
        if (holds.ended.size > ENDED_KEPT) {
          const oldest = holds.ended.keys().next().value;
          if (oldest !== undefined) holds.ended.delete(oldest);
        }
      }
      const drawn = settled.get(key);
      if (drawn && drawn.shown.kind !== held.shown.kind) differs = true;
      if (held.holdUntil !== null && (until === null || held.holdUntil < until))
        until = held.holdUntil;
    }
    for (const key of owned.current) if (!live.has(key)) release(holds, key, owner);
    owned.current = new Set(live.keys());
    if (!timer.current || timer.current.at !== until) {
      if (timer.current) clearTimeout(timer.current.id);
      timer.current = null;
      if (until !== null) {
        const at = until;
        timer.current = {
          at,
          id: setTimeout(
            () => {
              timer.current = null;
              setWake((count) => count + 1);
            },
            Math.max(0, at - now),
          ),
        };
      }
    }
    if (differs) setWake((count) => count + 1);
  }, [settled, live, clock, holds, owner]);
  useLayoutEffect(
    () => () => {
      for (const key of owned.current) release(holds, key, owner);
      owned.current = new Set();
    },
    [holds, owner],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current.id);
      timer.current = null;
    },
    [],
  );
  return useMemo(() => new Map([...settled].map(([key, held]) => [key, held.shown])), [settled]);
}

function release(holds: PresenceHolds, key: string, owner: object) {
  const entry = holds.entries.get(key);
  if (!entry) return;
  entry.owners.delete(owner);
  if (!entry.owners.size) holds.entries.delete(key);
}
