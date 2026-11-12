import type { Page } from '@playwright/test';

// Scene probe (docs/plans/unified-flow.md §9): plain DOM measurement, no app code. While an
// interval runs, a requestAnimationFrame loop in the page records, every frame, each item's
// position inside its scroll container (rect.top - container.top + scrollTop) and on screen
// (rect.top). Items are the ones present when the interval starts, identified by DOM node.

export interface ProbeOptions {
  /** Conversation items. */
  itemSelector?: string;
  /** Sidebar session rows. */
  rowSelector?: string;
  /**
   * The scroll containers, matched with `closest()`; a selector list may name several. An
   * element outside them is measured against its nearest scrolling ancestor.
   */
  containerSelector?: string;
}

export interface ItemShift {
  /** `item` or `row`. */
  kind: 'item' | 'row';
  /** The element's identifying attribute value, or its index when it has none. */
  id: string;
  maxContainerShiftPx: number;
  maxViewportShiftPx: number;
  /** Frames in which the element was still connected. */
  frames: number;
}

export interface ShiftResult {
  name: string;
  durationMs: number;
  frames: number;
  maxContainerShiftPx: number;
  maxViewportShiftPx: number;
  items: ItemShift[];
}

export interface Probe {
  start(name: string): Promise<void>;
  stop(): Promise<ShiftResult>;
}

interface ProbeConfig {
  itemSelector: string;
  rowSelector: string;
  containerSelector: string;
}

export function createProbe(page: Page, options: ProbeOptions = {}): Probe {
  const config: ProbeConfig = {
    itemSelector: options.itemSelector ?? '[data-chat-item]',
    rowSelector: options.rowSelector ?? '[data-session-row]',
    containerSelector: options.containerSelector ?? '',
  };
  let current: string | null = null;
  return {
    async start(name) {
      if (current) throw new Error(`probe interval "${current}" is still running`);
      current = name;
      await page.evaluate((config) => {
        interface Track {
          kind: 'item' | 'row';
          id: string;
          element: Element;
          container: Element | null;
          firstContainer: number;
          firstViewport: number;
          maxContainer: number;
          maxViewport: number;
          frames: number;
        }
        const scrolling = (element: Element): Element | null => {
          if (config.containerSelector) {
            const named = element.parentElement?.closest(config.containerSelector);
            if (named) return named;
          }
          for (let node = element.parentElement; node; node = node.parentElement) {
            const { overflowY } = getComputedStyle(node);
            if (/(auto|scroll|overlay)/.test(overflowY)) return node;
          }
          return document.scrollingElement;
        };
        const place = (track: Pick<Track, 'element' | 'container'>) => {
          const top = track.element.getBoundingClientRect().top;
          const box = track.container;
          const inContainer = box
            ? top -
              (box === document.scrollingElement ? 0 : box.getBoundingClientRect().top) +
              box.scrollTop
            : top;
          return { inContainer, top };
        };
        const tracks: Track[] = [];
        const collect = (selector: string, kind: Track['kind']) => {
          // The selector's own attribute names the item when it has a value.
          const named = /\[([\w-]+)/.exec(selector)?.[1];
          [...document.querySelectorAll(selector)].forEach((element, index) => {
            const container = scrolling(element);
            const attribute = named && element.getAttribute(named) ? named : null;
            const id = attribute ? `${attribute}=${element.getAttribute(attribute)}` : `#${index}`;
            const at = place({ element, container });
            tracks.push({
              kind,
              id,
              element,
              container,
              firstContainer: at.inContainer,
              firstViewport: at.top,
              maxContainer: 0,
              maxViewport: 0,
              frames: 0,
            });
          });
        };
        collect(config.itemSelector, 'item');
        collect(config.rowSelector, 'row');
        const state = { tracks, frames: 0, startedAt: performance.now(), raf: 0 };
        const frame = () => {
          state.frames += 1;
          for (const track of tracks) {
            if (!track.element.isConnected) continue;
            const at = place(track);
            track.frames += 1;
            track.maxContainer = Math.max(
              track.maxContainer,
              Math.abs(at.inContainer - track.firstContainer),
            );
            track.maxViewport = Math.max(track.maxViewport, Math.abs(at.top - track.firstViewport));
          }
          state.raf = requestAnimationFrame(frame);
        };
        state.raf = requestAnimationFrame(frame);
        (window as unknown as { __flowProbe: typeof state }).__flowProbe = state;
      }, config);
    },
    async stop() {
      const name = current;
      if (!name) throw new Error('no probe interval is running');
      current = null;
      // Two more frames so the last layout change is read before the loop ends.
      const measured = await page.evaluate(async () => {
        const holder = window as unknown as {
          __flowProbe?: {
            tracks: {
              kind: 'item' | 'row';
              id: string;
              maxContainer: number;
              maxViewport: number;
              frames: number;
            }[];
            frames: number;
            startedAt: number;
            raf: number;
          };
        };
        const state = holder.__flowProbe;
        if (!state) throw new Error('the probe state is missing (did the page reload?)');
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        cancelAnimationFrame(state.raf);
        delete holder.__flowProbe;
        return {
          durationMs: performance.now() - state.startedAt,
          frames: state.frames,
          items: state.tracks.map((track) => ({
            kind: track.kind,
            id: track.id,
            maxContainerShiftPx: track.maxContainer,
            maxViewportShiftPx: track.maxViewport,
            frames: track.frames,
          })),
        };
      });
      const round = (value: number) => Math.round(value * 100) / 100;
      const items = measured.items.map((item) => ({
        ...item,
        maxContainerShiftPx: round(item.maxContainerShiftPx),
        maxViewportShiftPx: round(item.maxViewportShiftPx),
      }));
      return {
        name,
        durationMs: Math.round(measured.durationMs),
        frames: measured.frames,
        maxContainerShiftPx: Math.max(0, ...items.map((item) => item.maxContainerShiftPx)),
        maxViewportShiftPx: Math.max(0, ...items.map((item) => item.maxViewportShiftPx)),
        items,
      };
    },
  };
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
    composer: options.composerSelector ?? '[data-testid="chat-composer"]',
    column: options.columnSelector ?? '[data-testid="chat-timeline"] > div',
    input: options.inputSelector ?? '[data-testid="chat-composer"] textarea',
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

/** Visible elements' text content and how many times each appears. */
export function countVisibleLabels(
  page: Page,
  selector = '[data-presence-label]',
): Promise<Record<string, number>> {
  return page.evaluate((selector) => {
    const counts: Record<string, number> = {};
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const shown =
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < innerHeight &&
        box.left < innerWidth &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0;
      if (!shown) continue;
      const text = element.textContent?.trim() ?? '';
      counts[text] = (counts[text] ?? 0) + 1;
    }
    return counts;
  }, selector);
}
