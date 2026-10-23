'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { spring } from '../lib/springs.ts';
import type { ItemRect } from './use-fluid-hover.ts';

// Layout effect on the client so a merge/split shows on the first frame.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Critically damped, so converging edges meet exactly instead of overshooting.
// On a merge the inner corners trail by `cornerDelay`.
const mergeSpring = spring.moderate;
const cornerDelay = 0.07;
// Boundaries resolve on a timer, not onAnimationComplete: Motion skips that
// callback when the target equals the current value (rapid toggling), which
// would strand a half. The +80ms buffer errs late, where it's invisible.
const convergeMs = (mergeSpring.duration + cornerDelay) * 1000 + 80;
const splitMs = mergeSpring.duration * 1000 + 80;

// A selected-background block for one render. A run is normally one block; mid
// merge/split it is drawn as two abutting halves with sharp inner corners.
type Rect = { top: number; left: number; width: number; height: number };
export interface SelBlock extends Rect {
  key: string;
  radii: [number, number, number, number]; // tl, tr, br, bl
  instant: boolean; // skip the spring (the zero-shift swap, the split snap-in)
  exitInstant: boolean; // drop without the fade (absorbed half at the swap)
  delayCorners: boolean; // trail the corner straightening (merge converge)
  cornerDelay?: number; // optional per-block delay override
  opacity?: number; // override the hover-derived opacity (commit ghost = 0)
  // Mount state for a fresh block, so it springs into place instead of
  // snapping. Continuous blocks ignore it.
  enterFrom?: { top: number; height: number; radii: [number, number, number, number] };
}

// A contiguous run of selected/checked rows, with a stable id so Motion
// can morph it across renders rather than exit+re-enter.
export type Run = { start: number; end: number; id: number };

interface RunIds {
  runs: Run[];
  /** Row index → the id of the run it belongs to. */
  byRow: Map<number, number>;
  lastId: number;
}

/**
 * Groups sorted row indices into contiguous runs and ids them against the
 * previous grouping: a run reuses the id of the first of its rows that had
 * one, unless an earlier run already took it (after a split the upper run
 * keeps the id and the lower run gets a new one).
 */
function assignRunIds(
  sorted: readonly number[],
  prev: ReadonlyMap<number, number>,
  lastId: number,
): RunIds {
  const spans: { start: number; end: number }[] = [];
  for (const idx of sorted) {
    const last = spans[spans.length - 1];
    if (last && idx === last.end + 1) last.end = idx;
    else spans.push({ start: idx, end: idx });
  }

  const usedIds = new Set<number>();
  const byRow = new Map<number, number>();
  const runs = spans.map((span) => {
    let stableId: number | null = null;
    for (let i = span.start; i <= span.end; i++) {
      const prevId = prev.get(i);
      if (prevId !== undefined && !usedIds.has(prevId)) {
        stableId = prevId;
        break;
      }
    }
    const id = stableId ?? ++lastId;
    usedIds.add(id);
    for (let i = span.start; i <= span.end; i++) byRow.set(i, id);
    return { ...span, id };
  });
  return { runs, byRow, lastId };
}

/**
 * Groups checked row indices into contiguous runs with ids that survive
 * re-renders: a run keeps its id while any of its rows was in a run last
 * render, so framer morphs a growing/shrinking block instead of swapping it.
 * Feed the result to useMergeSplitBlocks.
 */
export function useSelectionRuns(checkedIndices: readonly number[]): Run[] {
  const sorted = [...checkedIndices].sort((a, b) => a - b);
  const key = sorted.join(',');
  // State updated during render (not a ref) so rendering stays side-effect free.
  const [ids, setIds] = useState(() => ({ key, ...assignRunIds(sorted, new Map(), 0) }));
  if (ids.key === key) return ids.runs;
  const next = { key, ...assignRunIds(sorted, ids.byRow, ids.lastId) };
  setIds(next);
  return next.runs;
}

// One in-flight merge or split; geometry is recomputed from the live runs each
// render so rapid toggles redirect instead of freezing.
interface Boundary {
  tid: number;
  kind: 'merge' | 'split';
  survivorId: number; // persisting run (merged run / split's upper run)
  otherId: number; // merge: absorbed run; split: new lower run
  gapIndex: number; // bridging/deselected row — where the halves meet
  phase: 'converge' | 'commit' | 'splitIn' | 'diverge';
}

// Two runs within `outer` separated by exactly one row: the only shape a
// single click can merge or split.
function bridgePair(outer: Run, runs: Run[]) {
  const inside = runs
    .filter((r) => r.start >= outer.start && r.end <= outer.end)
    .sort((a, b) => a.start - b.start);
  if (inside.length !== 2) return null;
  const [up, lo] = inside as [Run, Run];
  return lo.start === up.end + 2 ? { up, lo, gap: up.end + 1 } : null;
}

// ── Merge / split boundary animation ─────────────────────────────
// Selecting a bridging row glides both inner edges to its midpoint, then swaps
// to one block invisibly; deselecting a middle row snaps into two halves that
// glide apart. Returns the blocks to paint with <SelectionBackgrounds>.
export function useMergeSplitBlocks(runs: Run[], itemRects: ItemRect[], R: number): SelBlock[] {
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);
  // State, not a ref: the render reads it too (the split safety net below).
  const [prevRuns, setPrevRuns] = useState<Run[]>([]);
  const tidRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const runsSig = runs.map((g) => `${g.id}:${g.start}-${g.end}`).join('|');

  // Detect merges/splits before paint and drop boundaries the latest selection
  // invalidated (the bridge row toggled again mid-flight).
  useIsoLayoutEffect(() => {
    const prev = prevRuns;
    const cur = runs;
    const found: Boundary[] = [];
    for (const c of cur) {
      const p = bridgePair(c, prev); // two prev runs collapsed into one
      if (p && (c.id === p.up.id || c.id === p.lo.id))
        found.push({
          tid: ++tidRef.current,
          kind: 'merge',
          survivorId: c.id,
          otherId: c.id === p.up.id ? p.lo.id : p.up.id,
          gapIndex: p.gap,
          phase: 'converge',
        });
    }
    for (const p of prev) {
      const c = bridgePair(p, cur); // one prev run split into two
      if (c)
        found.push({
          tid: ++tidRef.current,
          kind: 'split',
          survivorId: c.up.id,
          otherId: c.lo.id,
          gapIndex: c.gap,
          phase: 'splitIn',
        });
    }
    setPrevRuns(cur.map((r) => ({ ...r })));
    // Merge → commit phase; split → dropped.
    for (const b of found) {
      timersRef.current.set(
        b.tid,
        setTimeout(
          () => {
            timersRef.current.delete(b.tid);
            setBoundaries((bs) =>
              bs.some((x) => x.tid === b.tid)
                ? bs.flatMap((x) =>
                    x.tid !== b.tid
                      ? [x]
                      : x.kind === 'merge'
                        ? [{ ...x, phase: 'commit' as const }]
                        : [],
                  )
                : bs,
            );
          },
          b.kind === 'merge' ? convergeMs : splitMs,
        ),
      );
    }
    const stillValid = (b: Boundary) =>
      b.kind === 'merge'
        ? cur.some((c) => c.id === b.survivorId && b.gapIndex > c.start && b.gapIndex < c.end)
        : cur.some((c) => c.id === b.survivorId && c.end === b.gapIndex - 1) &&
          cur.some((c) => c.id === b.otherId && c.start === b.gapIndex + 1);
    setBoundaries((active) => {
      // Idempotent, so a double-invoked updater is harmless.
      for (const b of active) {
        if (stillValid(b)) continue;
        const timer = timersRef.current.get(b.tid);
        if (timer !== undefined) {
          clearTimeout(timer);
          timersRef.current.delete(b.tid);
        }
      }
      return [...active.filter(stillValid), ...found];
    });
  }, [runsSig]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Follow-up frame: a fresh split holds its abutting frame once then
  // diverges; a committed merge is dropped.
  useEffect(() => {
    if (!boundaries.some((b) => b.phase === 'splitIn' || b.phase === 'commit')) return;
    const frame = requestAnimationFrame(() =>
      setBoundaries((bs) =>
        bs.flatMap((b) =>
          b.phase === 'commit'
            ? []
            : [{ ...b, phase: b.phase === 'splitIn' ? 'diverge' : b.phase }],
        ),
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [boundaries]);

  const rectOf = (start: number, end: number): Rect | null => {
    const s = itemRects[start];
    const e = itemRects[end];
    if (!s || !e) return null;
    return {
      top: s.top,
      left: Math.min(s.left, e.left),
      width: Math.max(s.width, e.width),
      height: e.top + e.height - s.top,
    };
  };
  const blocks: SelBlock[] = [];
  for (const run of runs) {
    const r = rectOf(run.start, run.end);
    if (r)
      blocks.push({
        key: `sel-${run.id}`,
        ...r,
        radii: [R, R, R, R],
        instant: false,
        exitInstant: false,
        delayCorners: false,
      });
  }
  const byId = new Map(blocks.map((b) => [b.key, b]));
  for (const b of boundaries) {
    const gap = itemRects[b.gapIndex];
    const sv = byId.get(`sel-${b.survivorId}`);
    if (!gap || !sv) continue;
    const midY = gap.top + gap.height / 2;
    if (b.kind === 'merge') {
      if (b.phase === 'commit') {
        // Zero-shift swap to the full union. The absorbed half lingers one
        // render at opacity 0 so its removal can't flash an overlap.
        sv.instant = true;
        blocks.push({
          key: `sel-${b.otherId}`,
          top: midY,
          left: sv.left,
          width: sv.width,
          height: sv.top + sv.height - midY,
          radii: [0, 0, R, R],
          instant: true,
          exitInstant: true,
          delayCorners: false,
          opacity: 0,
        });
        continue;
      }
      // converge: survivor → top half, absorbed run → bottom half. Lower
      // merges trail slightly, capped.
      const mergeCornerDelay = Math.min(
        cornerDelay + 0.03,
        Math.max(cornerDelay, cornerDelay + (midY / Math.max(gap.height, 1)) * 0.002),
      );
      const bottom = sv.top + sv.height;
      sv.height = midY - sv.top;
      sv.radii = [R, R, 0, 0];
      sv.delayCorners = true;
      sv.cornerDelay = mergeCornerDelay;
      blocks.push({
        key: `sel-${b.otherId}`,
        top: midY,
        left: sv.left,
        width: sv.width,
        height: bottom - midY,
        radii: [0, 0, R, R],
        // A fresh ghost still animates its corners straightening.
        enterFrom: { top: midY, height: bottom - midY, radii: [R, R, R, R] },
        instant: false,
        exitInstant: true,
        delayCorners: true,
        cornerDelay: mergeCornerDelay,
      });
    } else if (b.phase === 'splitIn') {
      const lo = byId.get(`sel-${b.otherId}`);
      if (!lo) continue;
      // Pin both halves at the seam; the diverge phase springs them apart.
      const bottom = lo.top + lo.height;
      sv.height = midY - sv.top;
      sv.radii = [R, R, 0, 0];
      sv.instant = true;
      lo.top = midY;
      lo.height = bottom - midY;
      lo.radii = [0, 0, R, R];
      lo.instant = true;
      lo.enterFrom = { top: midY, height: bottom - midY, radii: [0, 0, R, R] };
    }
    // diverge: nothing to override; blocks spring to their real rects.
  }

  // Split safety net: the split boundary is created in a layout effect after
  // this render, so detect it here too, or the new lower half would mount at
  // its final rect and snap.
  for (const p of prevRuns) {
    const c = bridgePair(p, runs);
    const gap = c && itemRects[c.gap];
    if (!c || !gap) continue;
    const midY = gap.top + gap.height / 2;
    const up = byId.get(`sel-${c.up.id}`);
    const lo = byId.get(`sel-${c.lo.id}`);
    if (!up || !lo) continue;
    const bottom = lo.top + lo.height;
    up.height = midY - up.top;
    up.radii = [R, R, 0, 0];
    up.instant = true;
    lo.top = midY;
    lo.height = bottom - midY;
    lo.radii = [0, 0, R, R];
    lo.instant = true;
    lo.enterFrom = { top: midY, height: bottom - midY, radii: [0, 0, R, R] };
  }

  return blocks;
}

// Renders the blocks from useMergeSplitBlocks; corners animate individually so
// merge/split can straighten and re-round them.
export function SelectionBackgrounds({ blocks }: { blocks: SelBlock[] }) {
  return (
    <AnimatePresence>
      {blocks.map((b) => {
        const corner = b.delayCorners
          ? { ...mergeSpring, delay: b.cornerDelay ?? cornerDelay }
          : mergeSpring;
        const opacity = b.opacity ?? 1;
        return (
          <motion.div
            key={b.key}
            aria-hidden
            className="absolute bg-active pointer-events-none"
            initial={
              b.enterFrom
                ? {
                    opacity,
                    top: b.enterFrom.top,
                    left: b.left,
                    width: b.width,
                    height: b.enterFrom.height,
                    borderTopLeftRadius: b.enterFrom.radii[0],
                    borderTopRightRadius: b.enterFrom.radii[1],
                    borderBottomRightRadius: b.enterFrom.radii[2],
                    borderBottomLeftRadius: b.enterFrom.radii[3],
                  }
                : false
            }
            animate={{
              top: b.top,
              left: b.left,
              width: b.width,
              height: b.height,
              borderTopLeftRadius: b.radii[0],
              borderTopRightRadius: b.radii[1],
              borderBottomRightRadius: b.radii[2],
              borderBottomLeftRadius: b.radii[3],
              opacity,
            }}
            exit={{ opacity: 0, transition: b.exitInstant ? { duration: 0 } : mergeSpring.exit }}
            transition={
              b.instant
                ? { duration: 0 }
                : {
                    ...mergeSpring,
                    borderTopLeftRadius: corner,
                    borderTopRightRadius: corner,
                    borderBottomRightRadius: corner,
                    borderBottomLeftRadius: corner,
                    opacity: { duration: 0.08 },
                  }
            }
          />
        );
      })}
    </AnimatePresence>
  );
}
