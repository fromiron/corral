import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  FULL_TOPBAR,
  measureTopbar,
  stepTopbarTier,
  type TopbarLayout,
  topbarLayout,
} from './topbarTier.ts';

// The top bar is the open page's one header row: its location path (crumbs), its view switch
// (views) and its own actions. A page portals into these instead of adding rows of its own.

export interface TopbarSlots {
  actions: HTMLElement | null;
  views: HTMLElement | null;
  crumbs: HTMLElement | null;
}

export const TopbarSlotContext = createContext<TopbarSlots>({
  actions: null,
  views: null,
  crumbs: null,
});

export function TopbarActions({ children }: { children: ReactNode }) {
  const { actions } = useContext(TopbarSlotContext);
  return actions ? createPortal(children, actions) : null;
}

/** A further path segment after the page title. Without a top bar there is no path to extend. */
export function TopbarCrumb({ children }: { children: ReactNode }) {
  const { crumbs } = useContext(TopbarSlotContext);
  return crumbs ? createPortal(children, crumbs) : null;
}

/** The page's view switch; rendered in place where no top bar hosts it. */
export function TopbarViews({ children }: { children: ReactNode }) {
  const { views } = useContext(TopbarSlotContext);
  return views ? createPortal(children, views) : children;
}

/** Whether a top bar hosts the page's view switch. */
export function useTopbarHostsViews() {
  return Boolean(useContext(TopbarSlotContext).views);
}

// ---------------------------------------------------------------- fitting the bar to its width

const TopbarFitContext = createContext<{
  layout: TopbarLayout;
  attach: (bar: HTMLElement | null) => void;
}>({ layout: FULL_TOPBAR, attach: () => {} });

/** What the bar shows at its width (topbarTier.ts). Outside a fitted bar, everything. */
export function useTopbarLayout() {
  return useContext(TopbarFitContext).layout;
}

/**
 * Fits the bar to its own width. What a tier asks for is measured where it is laid out, so
 * the fit follows the content on screen (a run, more tabs, another language) and the sidebar's
 * width rather than fixed breakpoints. Steps continue before paint until the bar rests.
 */
export function TopbarFit({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState(0);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const needs = useRef<(number | undefined)[]>([]);
  const shown = useRef(index);
  shown.current = index;
  const fit = useCallback(() => {
    if (!bar) return;
    const available = bar.clientWidth;
    // Nothing is laid out (a hidden bar, or a test without layout): keep everything.
    if (!available) return;
    const current = shown.current;
    const need = measureTopbar(bar, topbarLayout(current));
    const known = needs.current[current];
    // The same tier asking for a different width means its content changed: what the other
    // tiers asked for no longer holds.
    if (known !== undefined && Math.abs(known - need) > 1) needs.current = [];
    needs.current[current] = need;
    const next = stepTopbarTier(current, available, needs.current);
    if (next !== current) setIndex(next);
  }, [bar]);
  // After each step, before paint: the next tier is measured and stepped again if needed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a committed tier is measured again
  useLayoutEffect(fit, [fit, index]);
  useEffect(() => {
    if (!bar) return;
    // Content arrives through portals. The observer runs in a microtask after it commits,
    // which is still before paint, so the first step is flushed there too.
    const content = new MutationObserver(() => flushSync(fit));
    content.observe(bar, { childList: true, characterData: true, subtree: true });
    // Width alone (the window, the sidebar, a density change) is followed a frame later.
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    size?.observe(bar);
    for (const part of bar.querySelectorAll(':scope > [data-topbar-part]')) size?.observe(part);
    return () => {
      content.disconnect();
      size?.disconnect();
    };
  }, [bar, fit]);
  const value = useMemo(() => ({ layout: topbarLayout(index), attach: setBar }), [index]);
  return <TopbarFitContext.Provider value={value}>{children}</TopbarFitContext.Provider>;
}

/** The bar itself: it names its tier for styles and tests. */
export function TopbarBar({ children, ...props }: ComponentProps<'header'>) {
  const { layout, attach } = useContext(TopbarFitContext);
  return (
    <header ref={attach} data-topbar-tier={layout.tier} data-topbar-rows={layout.rows} {...props}>
      {children}
    </header>
  );
}
