import type { Page } from '@playwright/test';

// Scene probe (docs/plans/unified-flow.md §9): plain DOM measurement, no app code.
//
// createProbe(page).start(name) reads a first sample synchronously, then a requestAnimationFrame
// loop in the page reads one sample per frame until stop(). Only one loop may run per page.
// - Tracked elements: conversation items (`[data-chat-item]`), sidebar rows
//   (`[data-session-row]`) and parts inside items (`[data-chat-part]`) present at start(). They
//   are followed by identifying value (a part by its item's value + its own), so a new node with
//   the same value continues the track; values missing at the end are listed in `lost`.
//   Per element, vertical (Y, top) and horizontal (X, left) shifts on two bases:
//   container — rect - container rect + scroll offset (§9 "기존 항목 이동", pass ≤ 1px);
//   viewport — rect on screen (§9 "따라가기" while scrolled up, pass ≤ 1px).
//   maxContainerShiftPx / maxViewportShiftPx: the largest of both axes over all tracked
//   elements; null when nothing was tracked.
// - maxTailGapChangePx: max − min of (composer top − bottom of the current last item, looked up
//   again every frame) (§9 "따라가기" at the end, pass ≤ 1px).
// - maxInputBottomChangePx: max − min of the input box's bottom edge on screen (§9 "입력 줄",
//   pass 0px).
//   Both are null with fewer than two samples. `samples` gives frame, tail, input and per-kind
//   tracked counts.
// measureChrome() reads the fixed areas once (§9 "고정 영역": top bar + idle composer, column
// width). countVisibleLabels() counts the texts of `[data-presence-label]` elements actually
// visible, clipped by scroll containers and the viewport (§9 "상태 이름": a text counted twice
// fails). waitForStill() waits until layout stops changing, for intervals and screenshots.
// The probe sets no pass marks itself.

const DEFAULT_COMPOSER = '[data-testid="chat-composer"]';
const DEFAULT_INPUT = '[data-testid="chat-composer"] textarea';
const DEFAULT_TIMELINE = '[data-testid="chat-timeline"]';

export interface ProbeOptions {
  /** Conversation items; the selector's first attribute is their identifying value. */
  itemSelector?: string;
  /** Sidebar session rows; the selector's first attribute is their identifying value. */
  rowSelector?: string;
  /** Parts inside conversation items; identified by their item's value and their own. */
  partSelector?: string;
  /** The composer, whose top edge the tail gap is measured to. */
  composerSelector?: string;
  /** The input box, whose bottom edge must not move. */
  inputSelector?: string;
  /**
   * The scroll containers, matched with `closest()`; a selector list may name several. An
   * element outside them is measured against its nearest scrolling ancestor.
   */
  containerSelector?: string;
}

export type TrackedKind = 'item' | 'row' | 'part';

export interface ItemShift {
  kind: TrackedKind;
  /** The identifying value (`attribute=value`), or `#index` when the element has none. */
  id: string;
  maxContainerShiftYPx: number;
  maxContainerShiftXPx: number;
  maxViewportShiftYPx: number;
  maxViewportShiftXPx: number;
  /** Frames in which an element with this value was on the page. */
  frames: number;
}

export interface ShiftResult {
  name: string;
  durationMs: number;
  maxContainerShiftPx: number | null;
  maxViewportShiftPx: number | null;
  maxTailGapChangePx: number | null;
  maxInputBottomChangePx: number | null;
  samples: {
    frames: number;
    tail: number;
    input: number;
    tracked: Record<TrackedKind, number>;
  };
  /** Tracked values no element carried at the end of the interval. */
  lost: string[];
  items: ItemShift[];
}

export interface Probe {
  start(name: string): Promise<void>;
  stop(): Promise<ShiftResult>;
}

const STATE = '__flowProbe';

export function createProbe(page: Page, options: ProbeOptions = {}): Probe {
  const config = {
    state: STATE,
    itemSelector: options.itemSelector ?? '[data-chat-item]',
    rowSelector: options.rowSelector ?? '[data-session-row]',
    partSelector: options.partSelector ?? '[data-chat-part]',
    composerSelector: options.composerSelector ?? DEFAULT_COMPOSER,
    inputSelector: options.inputSelector ?? DEFAULT_INPUT,
    containerSelector: options.containerSelector ?? '',
  };
  let current: string | null = null;
  return {
    async start(name) {
      if (current) throw new Error(`probe interval "${current}" is still running`);
      await page.evaluate((config) => {
        type Kind = 'item' | 'row' | 'part';
        interface Place {
          cy: number;
          cx: number;
          vy: number;
          vx: number;
        }
        interface Track {
          kind: Kind;
          id: string;
          first: Place;
          max: Place;
          frames: number;
          present: boolean;
        }
        const holder = window as unknown as Record<string, unknown>;
        if (holder[config.state])
          throw new Error('a probe interval is already running on this page');
        const attributeOf = (selector: string) => /\[([\w-]+)/.exec(selector)?.[1];
        const selectors: Record<Kind, string> = {
          item: config.itemSelector,
          row: config.rowSelector,
          part: config.partSelector,
        };
        const itemAttribute = attributeOf(config.itemSelector);
        const keyOf = (kind: Kind, element: Element, index: number) => {
          const attribute = attributeOf(selectors[kind]);
          const value = attribute ? element.getAttribute(attribute) : null;
          const own = value ? `${attribute}=${value}` : `#${index}`;
          if (kind !== 'part') return own;
          const item = element.closest(config.itemSelector);
          const parent = item && itemAttribute ? item.getAttribute(itemAttribute) : null;
          return `${itemAttribute}=${parent ?? '?'}/${own}`;
        };
        /** Elements of each kind by identifying value; the first element of a value wins. */
        const find = () => {
          const found = new Map<string, Element>();
          for (const kind of ['item', 'row', 'part'] as const) {
            document.querySelectorAll(selectors[kind]).forEach((element, index) => {
              const key = `${kind} ${keyOf(kind, element, index)}`;
              if (!found.has(key)) found.set(key, element);
            });
          }
          return found;
        };
        const scrolling = (element: Element): Element | null => {
          if (config.containerSelector) {
            const named = element.parentElement?.closest(config.containerSelector);
            if (named) return named;
          }
          for (let node = element.parentElement; node; node = node.parentElement) {
            const { overflowY, overflowX } = getComputedStyle(node);
            if (/(auto|scroll|overlay)/.test(overflowY + overflowX)) return node;
          }
          return document.scrollingElement;
        };
        const place = (element: Element): Place => {
          const rect = element.getBoundingClientRect();
          const box = scrolling(element);
          const origin =
            box && box !== document.scrollingElement
              ? box.getBoundingClientRect()
              : { top: 0, left: 0 };
          return {
            cy: rect.top - origin.top + (box?.scrollTop ?? 0),
            cx: rect.left - origin.left + (box?.scrollLeft ?? 0),
            vy: rect.top,
            vx: rect.left,
          };
        };
        const range = () => ({
          min: Number.POSITIVE_INFINITY,
          max: Number.NEGATIVE_INFINITY,
          n: 0,
        });
        const widen = (into: { min: number; max: number; n: number }, value: number) => {
          into.min = Math.min(into.min, value);
          into.max = Math.max(into.max, value);
          into.n += 1;
        };
        const tracks = new Map<string, Track>();
        for (const [key, element] of find()) {
          const at = place(element);
          tracks.set(key, {
            kind: key.slice(0, key.indexOf(' ')) as Kind,
            id: key.slice(key.indexOf(' ') + 1),
            first: at,
            max: { cy: 0, cx: 0, vy: 0, vx: 0 },
            frames: 0,
            present: true,
          });
        }
        const state = {
          tracks: [...tracks.values()],
          frames: 0,
          startedAt: performance.now(),
          raf: 0,
          tail: range(),
          input: range(),
          sample: () => {},
        };
        /** Tail gap and input edge; read now (the first sample) and on every frame. */
        const sampleEdges = () => {
          const items = document.querySelectorAll(config.itemSelector);
          const last = items[items.length - 1];
          const composer = document.querySelector(config.composerSelector);
          if (last && composer)
            widen(
              state.tail,
              composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
            );
          const input = document.querySelector(config.inputSelector);
          if (input) widen(state.input, input.getBoundingClientRect().bottom);
        };
        state.sample = () => {
          state.frames += 1;
          sampleEdges();
          const found = find();
          for (const [key, track] of tracks) {
            const element = found.get(key);
            track.present = Boolean(element);
            if (!element) continue;
            const at = place(element);
            track.frames += 1;
            for (const axis of ['cy', 'cx', 'vy', 'vx'] as const)
              track.max[axis] = Math.max(track.max[axis], Math.abs(at[axis] - track.first[axis]));
          }
        };
        sampleEdges();
        const frame = () => {
          state.sample();
          state.raf = requestAnimationFrame(frame);
        };
        state.raf = requestAnimationFrame(frame);
        holder[config.state] = state;
      }, config);
      current = name;
    },
    async stop() {
      const name = current;
      if (!name) throw new Error('no probe interval is running');
      current = null;
      const measured = await page.evaluate(async (key) => {
        const holder = window as unknown as Record<string, unknown>;
        const state = holder[key] as
          | {
              tracks: {
                kind: 'item' | 'row' | 'part';
                id: string;
                max: { cy: number; cx: number; vy: number; vx: number };
                frames: number;
                present: boolean;
              }[];
              frames: number;
              startedAt: number;
              raf: number;
              tail: { min: number; max: number; n: number };
              input: { min: number; max: number; n: number };
              sample: () => void;
            }
          | undefined;
        if (!state) throw new Error('the probe state is missing (did the page reload?)');
        // Two more frames so the last layout change is read, then one final sample.
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        cancelAnimationFrame(state.raf);
        state.sample();
        delete holder[key];
        const spread = (r: { min: number; max: number; n: number }) =>
          r.n >= 2 ? r.max - r.min : null;
        return {
          durationMs: performance.now() - state.startedAt,
          frames: state.frames,
          tail: spread(state.tail),
          tailSamples: state.tail.n,
          input: spread(state.input),
          inputSamples: state.input.n,
          tracks: state.tracks,
        };
      }, STATE);
      const round = (value: number) => Math.round(value * 100) / 100;
      const items: ItemShift[] = measured.tracks.map((track) => ({
        kind: track.kind,
        id: track.id,
        maxContainerShiftYPx: round(track.max.cy),
        maxContainerShiftXPx: round(track.max.cx),
        maxViewportShiftYPx: round(track.max.vy),
        maxViewportShiftXPx: round(track.max.vx),
        frames: track.frames,
      }));
      const largest = (values: number[]) => (values.length ? Math.max(...values) : null);
      const count = (kind: TrackedKind) => items.filter((item) => item.kind === kind).length;
      return {
        name,
        durationMs: Math.round(measured.durationMs),
        maxContainerShiftPx: largest(
          items.flatMap((item) => [item.maxContainerShiftYPx, item.maxContainerShiftXPx]),
        ),
        maxViewportShiftPx: largest(
          items.flatMap((item) => [item.maxViewportShiftYPx, item.maxViewportShiftXPx]),
        ),
        maxTailGapChangePx: measured.tail === null ? null : round(measured.tail),
        maxInputBottomChangePx: measured.input === null ? null : round(measured.input),
        samples: {
          frames: measured.frames,
          tail: measured.tailSamples,
          input: measured.inputSamples,
          tracked: { item: count('item'), row: count('row'), part: count('part') },
        },
        lost: measured.tracks
          .filter((track) => !track.present)
          .map((track) => `${track.kind} ${track.id}`),
        items,
      };
    },
  };
}

export interface StillOptions {
  /** Elements whose boxes must hold still; scroll offsets of scrolling ones count too. */
  selectors?: string[];
  /**
   * How long nothing may change. The default outlasts Studio's 1.5 s run-list poll, so a change
   * the next poll brings lands inside the wait instead of after it.
   */
  stillMs?: number;
  timeoutMs?: number;
}

/** Waits until the given elements' boxes and scroll offsets stop changing. */
export async function waitForStill(page: Page, options: StillOptions = {}): Promise<void> {
  const settings = {
    selectors: options.selectors ?? [
      DEFAULT_TIMELINE,
      `${DEFAULT_TIMELINE} [data-chat-item]`,
      DEFAULT_COMPOSER,
      DEFAULT_INPUT,
      '[data-slot="scroll-area-viewport"]',
    ],
    stillMs: options.stillMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 10_000,
  };
  await page.evaluate(
    (settings) =>
      new Promise<void>((done, fail) => {
        const signature = () =>
          settings.selectors
            .flatMap((selector) =>
              [...document.querySelectorAll(selector)].map((element) => {
                const r = element.getBoundingClientRect();
                return [r.top, r.left, r.width, r.height, element.scrollTop, element.scrollHeight]
                  .map((value) => Math.round(value * 10))
                  .join(',');
              }),
            )
            .join(';');
        const until = performance.now() + settings.timeoutMs;
        let last = signature();
        let since = performance.now();
        const frame = () => {
          const now = signature();
          if (now !== last) since = performance.now();
          last = now;
          if (performance.now() - since >= settings.stillMs) return done();
          if (performance.now() > until) return fail(new Error('layout did not settle'));
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    settings,
  );
}

export interface ChromeOptions {
  topBarSelector?: string;
  composerSelector?: string;
  columnSelector?: string;
  inputSelector?: string;
}

export interface ChromeMeasure {
  /** Missing elements read as null. */
  topBarHeightPx: number | null;
  composerHeightPx: number | null;
  columnWidthPx: number | null;
  /** The input box's bottom edge on screen. */
  inputBottomPx: number | null;
}

export function measureChrome(page: Page, options: ChromeOptions = {}): Promise<ChromeMeasure> {
  const selectors = {
    topBar: options.topBarSelector ?? '[role="banner"], header',
    composer: options.composerSelector ?? DEFAULT_COMPOSER,
    column: options.columnSelector ?? `${DEFAULT_TIMELINE} > div`,
    input: options.inputSelector ?? DEFAULT_INPUT,
  };
  return page.evaluate((selectors) => {
    const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const round = (value: number | undefined) =>
      value === undefined ? null : Math.round(value * 100) / 100;
    return {
      topBarHeightPx: round(rect(selectors.topBar)?.height),
      composerHeightPx: round(rect(selectors.composer)?.height),
      columnWidthPx: round(rect(selectors.column)?.width),
      inputBottomPx: round(rect(selectors.input)?.bottom),
    };
  }, selectors);
}

/**
 * Texts of the visible matching elements and how many times each appears. An element counts
 * when its box, cut by the viewport and by every ancestor that clips overflow, keeps an area,
 * and it is not hidden by display, visibility or opacity.
 */
export function countVisibleLabels(
  page: Page,
  selector = '[data-presence-label]',
): Promise<Record<string, number>> {
  return page.evaluate((selector) => {
    const counts: Record<string, number> = {};
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const box = element.getBoundingClientRect();
      let top = Math.max(box.top, 0);
      let left = Math.max(box.left, 0);
      let bottom = Math.min(box.bottom, innerHeight);
      let right = Math.min(box.right, innerWidth);
      for (let node = element.parentElement; node; node = node.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(node);
        if (overflowX === 'visible' && overflowY === 'visible') continue;
        const clip = node.getBoundingClientRect();
        if (overflowY !== 'visible') {
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        if (overflowX !== 'visible') {
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
      }
      if (bottom - top <= 0 || right - left <= 0) continue;
      const text = element.textContent?.trim() ?? '';
      counts[text] = (counts[text] ?? 0) + 1;
    }
    return counts;
  }, selector);
}
