import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import { placeChatRow } from './ChatView.tsx';

// Arriving to read an advice (features/inbox.md `advice`): the address asks once, the
// conversation comes to the front and the address lets the request go; the run's row opens its
// advice and brings the words where the person sees them, above a floating composer.

/** A person came to read the advice of a run: each request is its own `key`. */
export interface AdviceArrivalValue {
  runId: string;
  key: number;
  /** The row took it (or there is none to take it): the arrival ends. */
  done: () => void;
}

/** The arrival the conversation's rows hear; null when nobody came to read an advice. */
export const AdviceArrival = createContext<AdviceArrivalValue | null>(null);

/** One time an address asked to read a run's advice: `n` tells two asks for the same run apart. */
export interface AdviceRequest {
  runId: string;
  n: number;
}

/**
 * The arrival an address's `advice` asks for. The session frame brings the conversation to the
 * front and lets the request go from the address in the same write that says what the panel
 * shows (features/session-panel.md 대화를 앞으로 가져오기), so Back, a reload or a remembered view
 * never arrives again; the frame hands each request over as it consumes it, and this keeps the
 * arrival until its row takes it.
 */
export function useAdviceArrivalRequest(request: AdviceRequest | null): AdviceArrivalValue | null {
  const [arrival, setArrival] = useState<{ runId: string; key: number } | null>(null);
  const count = useRef(0);
  useEffect(() => {
    if (!request) return;
    count.current += 1;
    setArrival({ runId: request.runId, key: count.current });
  }, [request]);
  return useMemo(
    () =>
      arrival
        ? {
            ...arrival,
            // An older arrival's end leaves a newer one.
            done: () => setArrival((current) => (current?.key === arrival.key ? null : current)),
          }
        : null,
    [arrival],
  );
}

/** Room left between the words and the view's edges. */
const MARGIN = 16;

/**
 * Where the row whose advice's words run from `wordsTop` to `wordsBottom` goes, as an offset from
 * the top of the view (`top` to `bottom`, the composer's top when it floats over the view): the
 * words' end just above the composer, their first line kept in view when they are taller than the
 * room. Null when they are in view already.
 */
export function adviceOffset(input: {
  top: number;
  bottom: number;
  margin?: number;
  rowTop: number;
  wordsTop: number;
  wordsBottom: number;
}): number | null {
  const margin = input.margin ?? MARGIN;
  const first = input.top + margin;
  let shift = 0;
  if (input.wordsBottom > input.bottom - margin)
    shift = Math.min(input.wordsBottom - (input.bottom - margin), input.wordsTop - first);
  if (input.wordsTop - shift < first) shift = input.wordsTop - first;
  if (Math.abs(shift) < 0.5) return null;
  return input.rowTop - input.top - shift;
}

/** How long the row is kept placed while what it holds settles (the words opening, the row's
 * other parts measured), unless the person moves first. */
const SETTLE_MS = 1500;

/**
 * Brings an opened advice's words into view: in a conversation, by holding its row where the
 * words end above the composer (the conversation's own placing, so nothing else moves it), placed
 * again while the row, the words or the composer settle; in a record outside one, by scrolling
 * them into view. Returns what stops the settling.
 */
export function bringAdviceIntoView(words: HTMLElement, sessionId: string | null): () => void {
  const row = words.closest<HTMLElement>('[data-chat-item]');
  const view = words.closest<HTMLElement>('[data-chat-view]');
  const timeline = view?.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  const composer = view?.querySelector<HTMLElement>('[data-testid="chat-composer"]');
  const id = row?.getAttribute('data-chat-item');
  if (!sessionId || !row || !timeline || !id) {
    words.scrollIntoView?.({ block: 'nearest' });
    return () => {};
  }
  const offset = () => {
    const frame = timeline.getBoundingClientRect();
    const covered =
      composer?.dataset.composerSurface === 'floating'
        ? Math.min(frame.bottom, composer.getBoundingClientRect().top)
        : frame.bottom;
    const shown = words.getBoundingClientRect();
    return adviceOffset({
      top: frame.top,
      bottom: covered,
      rowTop: row.getBoundingClientRect().top,
      wordsTop: shown.top,
      wordsBottom: shown.bottom,
    });
  };
  const first = offset();
  if (first === null) return () => {};
  let placed = placeChatRow(sessionId, id, first);
  if (!placed) {
    words.scrollIntoView?.({ block: 'nearest' });
    return () => {};
  }
  if (typeof ResizeObserver === 'undefined') return () => {};
  const settle = new ResizeObserver(() => {
    // The person moved the conversation: the place is theirs.
    if (!placed?.held()) return stop();
    const next = offset();
    if (next !== null) placed = placeChatRow(sessionId, id, next) ?? placed;
  });
  for (const element of [row, words, composer]) if (element) settle.observe(element);
  const timer = setTimeout(() => stop(), SETTLE_MS);
  function stop() {
    settle.disconnect();
    clearTimeout(timer);
  }
  return stop;
}
