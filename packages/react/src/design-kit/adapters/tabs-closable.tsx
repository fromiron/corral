'use client';

import { Tabs } from '@base-ui/react/tabs';
import {
  AnimatePresence,
  type AnimationPlaybackControls,
  animate,
  motion,
  useReducedMotion,
} from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type ItemRect, useFluidHover } from '../hooks/use-fluid-hover.ts';
import { fontWeights } from '../lib/font-weight.ts';
import { type IconComponent, useIcon } from '../lib/icon-context.tsx';
import { useShape } from '../lib/shape-context.tsx';
import { useSize } from '../lib/size-context.tsx';
import { spring, tween } from '../lib/springs.ts';
import { Tooltip } from './tooltip.tsx';
import { cn } from './utils.ts';

// -----------------------------------------------------------------------------
// A strip of tabs that open and close one by one, for a panel head. The
// supplied kit's TabsSubtle has fixed tabs that only scroll; this keeps its
// look and motion (compact text tabs, the selected and hover pills springing
// between tabs, the moving focus ring, manual activation: arrows move the
// focus, Enter and Space select) and adds:
//
// - a close control: after the selected tab's name, always; in the icon's
//   place on an unselected tab that shows text (its name or a short label),
//   on hover or focus; none on a tab shrunk to its icon, which a press selects.
//   A tab may not hold another control, so the close buttons live in a layer
//   beside the tablist, over each tab, out of the tab order. Delete closes
//   the focused tab and a middle click the one under the pointer, any tab.
// - overflow by stages, from the strip's own width: unselected names shrink,
//   then unselected tabs keep only their icon (and a short label), then the
//   strip scrolls, fading at its cut edges, with the selected tab in view. A
//   name not on screen shows in the kit's tooltip.
// - a trailing slot right after the last tab (a "+", as a browser's new-tab
//   button) and an end slot at the far right (maximize); neither scrolls away.
//
// The host owns the tabs, the selection and what a close selects next.
// -----------------------------------------------------------------------------

export interface TabsClosableTab {
  id: string;
  label: string;
  /** Kept beside the icon when unselected tabs shrink to their icon ("#3"). */
  shortLabel?: string;
  icon: IconComponent;
}

export interface TabsClosableHandle {
  /** Moves the focus to that tab and scrolls it into view; false when there is none. */
  focusTab: (id: string) => boolean;
}

export interface TabsClosableProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect' | 'children' | 'aria-label'> {
  /** A new array with the same tabs each render is fine: the strip compares their ids and
   *  labels, not the array. */
  tabs: readonly TabsClosableTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** The close control's accessible name (and tooltip), which carries the tab's name. */
  closeLabel: (tab: TabsClosableTab) => string;
  /** The tablist's accessible name. */
  'aria-label': string;
  /** Prefix of the tab and panel ids; see `tabsClosableIds`. */
  idPrefix: string;
  /** Host controls right after the last tab ("+"). Once the strip scrolls they stand right
   *  after it, clear of its fade. */
  trailing?: ReactNode;
  /** Host controls at the strip's far right (maximize), after a flexible gap. */
  end?: ReactNode;
}

/** The ids a tab and its panel carry, for a host that renders its own panels. */
export function tabsClosableIds(idPrefix: string, tabId: string) {
  return { tab: `${idPrefix}-tab-${tabId}`, panel: `${idPrefix}-panel-${tabId}` };
}

// The compact step (28px tabs), as TabsSubtle at its compact size.
const PAD = 10;
const ICON = 14;
const GAP = 6;
/** The close control's hit box, and its glyph. */
const CLOSE = 24;
const CLOSE_GLYPH = 12;
/** After the selected tab's name: a little air, the close control, and the tab's end, so the
 *  glyph sits as far from the end as the icon from the start. */
const CLOSE_GAP = 2;
const SELECTED_END = PAD - (CLOSE - CLOSE_GLYPH) / 2;
/** A tab's width less its name: unselected, and selected with its close control. */
const CHROME = PAD * 2 + ICON + GAP;
const SELECTED_CHROME = PAD + ICON + GAP + CLOSE_GAP + CLOSE + SELECTED_END;
/** The least an unselected name shrinks to before the tabs drop their names. */
const MIN_LABEL = 40;
/** The scroller's padding, which gives the 2px-outset focus ring room. */
const SCROLLER_PAD = 4;
/** The cut edges' fade. */
const FADE = 24;
/** How far from the edges a selected or focused tab is scrolled: past the fade, ring included. */
const REVEAL = FADE + 4;
/** How long after a selection, hover or focus change its layer travels; a rect that changes
 *  later (a resize, a remeasure) is followed at once. */
const TRAVEL_MS = 250;

const semibold = { fontVariationSettings: fontWeights.semibold };
const instant = { duration: 0 };

/** The strip's own focus events (a resync), which its focus handler ignores. */
const resyncEvents = new WeakSet<Event>();

/** Whether `key` changed in the last `ms`, read during render. */
function useRecentChange(key: unknown, ms: number) {
  const last = useRef({ key, at: Number.NEGATIVE_INFINITY });
  if (!Object.is(last.current.key, key)) last.current = { key, at: performance.now() };
  return performance.now() - last.current.at < ms;
}

export const TabsClosable = forwardRef<TabsClosableHandle, TabsClosableProps>(
  (
    {
      tabs,
      selectedId,
      onSelect,
      onClose,
      closeLabel,
      'aria-label': ariaLabel,
      idPrefix,
      trailing,
      end,
      className,
      ...props
    },
    ref,
  ) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const trailingRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const measurers = useRef(new Map<string, HTMLSpanElement>());
    const shape = useShape();
    const size = useSize('compact');
    const reduce = useReducedMotion() ?? false;
    const CloseIcon = useIcon('x');

    // What the tabs are, apart from the array that carries them.
    const idList = tabs.map((tab) => tab.id).join('\u001e');
    const signature = tabs
      .map((tab) => `${tab.id}\u001f${tab.label}\u001f${tab.shortLabel ?? ''}`)
      .join('\u001e');
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const selectedRef = useRef(selectedId);
    selectedRef.current = selectedId;
    const tabElement = useCallback(
      (id: string) => {
        const element = rootRef.current?.ownerDocument.getElementById(
          tabsClosableIds(idPrefix, id).tab,
        );
        return element && rootRef.current?.contains(element) ? element : null;
      },
      [idPrefix],
    );

    // --- Scrolling ---------------------------------------------------------------
    const scrollMotion = useRef<AnimationPlaybackControls | null>(null);
    const scrollTo = useCallback(
      (left: number) => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        scrollMotion.current?.stop();
        if (reduce) {
          scroller.scrollLeft = left;
          return;
        }
        scrollMotion.current = animate(scroller.scrollLeft, left, {
          ...spring.moderate,
          onUpdate: (value) => {
            scroller.scrollLeft = value;
          },
        });
      },
      [reduce],
    );
    // Clear of the faded edges, so a tab and its focus ring are never cut at the scroller's edge.
    const reveal = useCallback(
      (tab: HTMLElement, { instantly = false } = {}) => {
        const scroller = scrollerRef.current;
        const container = containerRef.current;
        if (!scroller || !container || scroller.scrollWidth <= scroller.clientWidth) return;
        const left = container.offsetLeft + tab.offsetLeft;
        const right = left + tab.offsetWidth;
        const start = scroller.scrollLeft;
        const end = start + scroller.clientWidth;
        let next: number | null = null;
        if (left - REVEAL < start) next = Math.max(0, left - REVEAL);
        else if (right + REVEAL > end) next = right + REVEAL - scroller.clientWidth;
        if (next === null) return;
        if (instantly) {
          scrollMotion.current?.stop();
          scroller.scrollLeft = next;
        } else scrollTo(next);
      },
      [scrollTo],
    );
    // A focus moved by the arrows scrolls natively first; the strip puts the scroll back and
    // brings the tab in on the kit's timing.
    const scrollBeforeKey = useRef<number | null>(null);

    // A wheel without a sideways delta scrolls the strip sideways.
    useEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const onWheel = (event: WheelEvent) => {
        if (event.deltaX !== 0 || event.deltaY === 0) return;
        const room = scroller.scrollWidth - scroller.clientWidth;
        if (room <= 0) return;
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        const next = Math.max(0, Math.min(room, scroller.scrollLeft + delta));
        if (next === scroller.scrollLeft) return;
        event.preventDefault();
        scrollMotion.current?.stop();
        scroller.scrollLeft = next;
      };
      scroller.addEventListener('wheel', onWheel, { passive: false });
      return () => scroller.removeEventListener('wheel', onWheel);
    }, []);

    // --- Focus --------------------------------------------------------------------
    // Base UI's roving focus learns a tab's place when the tab takes the focus, and renumbers
    // the tabs a render after the list changes. A tab focused in between (the host's focus after
    // a close) would keep its old place, so the arrows would start from there. Once the
    // renumbering has run, the focused tab tells the list its place again.
    const resyncFocus = useCallback(() => {
      queueMicrotask(() => {
        const focused = rootRef.current?.ownerDocument.activeElement;
        if (!(focused instanceof HTMLElement) || focused.getAttribute('role') !== 'tab') return;
        if (!rootRef.current?.contains(focused)) return;
        const event = new FocusEvent('focusin', { bubbles: true });
        resyncEvents.add(event);
        focused.dispatchEvent(event);
      });
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        focusTab: (id) => {
          const tab = tabElement(id);
          if (!tab) return false;
          tab.focus({ preventScroll: true });
          reveal(tab);
          resyncFocus();
          return true;
        },
      }),
      [tabElement, reveal, resyncFocus],
    );

    // --- Overflow stage --------------------------------------------------------
    // Decided from what the stage does not change: the strip's width, each name's natural width
    // and the selection. Names shrink in CSS; past their least width the tabs go compact.
    const [compact, setCompact] = useState(false);
    const [labelWidths, setLabelWidths] = useState<Record<string, number>>({});
    const [scrolls, setScrolls] = useState(false);
    // The clearance a scrolling strip adds to the slot after it. The stage and the scroll state
    // are read as if it were not there: counted, they would hold themselves in place.
    const clearance = useCallback(() => {
      const slot = trailingRef.current ?? endRef.current;
      if (!slot) return 0;
      const base = slot === trailingRef.current ? 0 : 8;
      return Math.max(0, Number.parseFloat(getComputedStyle(slot).paddingLeft) - base);
    }, []);
    // From the tabs' own width, not the scroll width: a pill or close control still moving from
    // the last stage's places would count as overflow.
    const readScrolls = useCallback(() => {
      const scroller = scrollerRef.current;
      const container = containerRef.current;
      if (!scroller || !container) return;
      const room = scroller.clientWidth - SCROLLER_PAD * 2;
      setScrolls(container.offsetWidth > room + clearance() + 1);
    }, [clearance]);

    const lastWidth = useRef(0);
    const measure = useCallback(() => {
      const root = rootRef.current;
      const scroller = scrollerRef.current;
      if (!root || !scroller) return;
      // The room the slots leave. The scroller's negative margins and its padding cancel out.
      const width =
        root.clientWidth -
        (trailingRef.current?.offsetWidth ?? 0) -
        (endRef.current?.offsetWidth ?? 0) +
        clearance();
      // Unlaid-out (hidden, or no layout engine): keep the last stage.
      if (width <= 0) return;
      // A CSS variable, not state: the strip does not render again for every pixel of a resize.
      scroller.style.setProperty('--tabs-available', `${width}px`);
      // The scroller's own width: the clearance that comes and goes with scrolling moves it too.
      const resized = scroller.clientWidth !== lastWidth.current;
      lastWidth.current = scroller.clientWidth;
      const widths: Record<string, number> = {};
      let need = 0;
      for (const tab of tabsRef.current) {
        const element = measurers.current.get(tab.id);
        const label = element ? Math.ceil(element.getBoundingClientRect().width) : 0;
        widths[tab.id] = label;
        need +=
          tab.id === selectedRef.current
            ? SELECTED_CHROME + label
            : CHROME + Math.min(label, MIN_LABEL);
      }
      setCompact(need > width);
      setLabelWidths((previous) => {
        const keys = Object.keys(widths);
        const same =
          keys.length === Object.keys(previous).length &&
          keys.every((key) => previous[key] === widths[key]);
        return same ? previous : widths;
      });
      // A resize within one stage renders nothing else: whether the strip scrolls, and the
      // selected tab's place in view, follow it here, at once.
      readScrolls();
      const selected = selectedRef.current ? tabElement(selectedRef.current) : null;
      if (resized && selected) reveal(selected, { instantly: true });
    }, [tabElement, reveal, readScrolls, clearance]);

    // --- Hover, selection and focus layers (TabsSubtle's) ---------------------
    const isMouseInside = useRef(false);
    const [mouseInside, setMouseInside] = useState(false);
    const {
      activeIndex: hoveredIndex,
      setActiveIndex: setHoveredIndex,
      itemRects,
      handlers,
      registerItem,
      measureItems,
    } = useFluidHover(containerRef, { axis: 'x', gapClick: false });
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const [focusVisible, setFocusVisible] = useState(false);
    // The tab whose name is cut short where the pointer or the focus last arrived.
    const [tipTab, setTipTab] = useState<string | null>(null);
    const noteCut = (id: string, tab: HTMLElement) => {
      const text = tab.querySelector<HTMLElement>('[data-slot="tabs-closable-label"]');
      const cut = !!text && text.scrollWidth > text.clientWidth + 1;
      setTipTab(cut ? id : null);
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: Runs when the tabs' ids, names or the selection change, not their array.
    useLayoutEffect(() => {
      measure();
      // The pills follow the tabs in this frame, not the next.
      measureItems();
    }, [measure, measureItems, signature, selectedId]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: Runs when the set of tabs changes.
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(root);
      if (scrollerRef.current) observer.observe(scrollerRef.current);
      for (const slot of [trailingRef.current, endRef.current]) if (slot) observer.observe(slot);
      for (const element of measurers.current.values()) observer.observe(element);
      return () => observer.disconnect();
    }, [measure, idList, !!trailing, !!end]);

    // Whether the strip scrolls follows its content too, whatever moved it.
    useLayoutEffect(() => {
      const scroller = scrollerRef.current;
      const container = containerRef.current;
      if (!scroller || !container || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => readScrolls());
      observer.observe(container);
      return () => observer.disconnect();
    }, [readScrolls]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: Runs when the set of tabs changes.
    useLayoutEffect(() => {
      // A focused tab that moved or went away takes its focus state with it.
      const focused = rootRef.current?.ownerDocument.activeElement;
      const index = tabsRef.current.findIndex((tab) => tabElement(tab.id) === focused);
      setFocusedIndex(index >= 0 ? index : null);
      if (index < 0) setFocusVisible(false);
      resyncFocus();
    }, [idList, tabElement, resyncFocus]);

    // Room for the trailing controls clear of the fade, once the strip scrolls.
    // biome-ignore lint/correctness/useExhaustiveDependencies: Read again when the stage or the tabs change.
    useLayoutEffect(() => {
      const scroller = scrollerRef.current;
      if (scroller) readScrolls();
    }, [compact, signature, selectedId, labelWidths]);

    // The selected tab in view, after a selection or a change of stage.
    // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll again when the stage or the tabs change the tab's place.
    useLayoutEffect(() => {
      if (!selectedId) return;
      const tab = tabElement(selectedId);
      if (tab) reveal(tab);
    }, [selectedId, compact, idList]);

    const selectedIndex = tabs.findIndex((tab) => tab.id === selectedId);
    // The pill stays on its tab's last place while a remeasure is pending.
    const lastPill = useRef<{ id: string; rect: ItemRect } | null>(null);
    const measuredSelected = selectedIndex >= 0 ? itemRects[selectedIndex] : undefined;
    if (measuredSelected && selectedId)
      lastPill.current = { id: selectedId, rect: measuredSelected };
    const selectedRect =
      measuredSelected ??
      (lastPill.current && lastPill.current.id === selectedId ? lastPill.current.rect : undefined);
    const hoverRect = hoveredIndex !== null ? itemRects[hoveredIndex] : undefined;
    const focusRect = focusVisible && focusedIndex !== null ? itemRects[focusedIndex] : undefined;
    const isHoveringSelected = hoveredIndex === selectedIndex;
    const isHovering = hoveredIndex !== null && !isHoveringSelected;
    const selectionMoved = useRecentChange(selectedId, TRAVEL_MS);
    const hoverMoved = useRecentChange(hoveredIndex, TRAVEL_MS);
    const focusMoved = useRecentChange(focusedIndex, TRAVEL_MS);
    const travel = reduce || !selectionMoved ? instant : spring.moderate;
    const hoverTravel = reduce || !hoverMoved ? instant : spring.fast;
    const focusTravel = reduce || !focusMoved ? instant : spring.fast;

    const indexOf = (element: EventTarget | null) => {
      const attr = (element as HTMLElement | null)
        ?.closest?.('[data-fluid-hover-index]')
        ?.getAttribute('data-fluid-hover-index');
      return attr == null ? null : Number(attr);
    };

    return (
      <div
        ref={rootRef}
        data-slot="tabs-closable"
        // Isolated, so its layers stay below the app shell's.
        className={cn('isolate flex min-w-0 items-center', className)}
        {...props}
      >
        <div
          ref={scrollerRef}
          data-slot="tabs-closable-scroller"
          className={cn(
            // Negative margins and padding give the focus ring room inside the scroller.
            'scroll-fade-x scrollbar-hide relative -mx-1 -my-1 min-w-0 flex-initial overflow-x-auto overflow-y-hidden px-1 py-1 [--scroll-fade-size:24px]',
          )}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Pointer tracking for the hover layer only; the tabs and close buttons own every action. */}
          <div
            ref={containerRef}
            className="relative flex"
            // As wide as the tabs, so the pointer beyond the last one hovers nothing.
            style={compact ? { width: 'max-content' } : { width: 'max-content', maxWidth: '100%' }}
            onMouseMove={(event) => {
              isMouseInside.current = true;
              setMouseInside(true);
              handlers.onMouseMove(event);
            }}
            onMouseLeave={() => {
              isMouseInside.current = false;
              setMouseInside(false);
              handlers.onMouseLeave();
            }}
          >
            <Tabs.Root
              value={selectedId}
              onValueChange={(value) => {
                if (typeof value !== 'string' || value === selectedId) return;
                if (tabsRef.current.some((tab) => tab.id === value)) onSelect(value);
              }}
              render={
                <Tabs.List
                  activateOnFocus={false}
                  aria-label={ariaLabel}
                  className="flex min-w-0 flex-1 items-center"
                  onKeyDownCapture={() => {
                    scrollBeforeKey.current = scrollerRef.current?.scrollLeft ?? null;
                  }}
                  onFocus={(event: React.FocusEvent<HTMLDivElement>) => {
                    if (resyncEvents.has(event.nativeEvent)) return;
                    const index = indexOf(event.target);
                    if (index === null) return;
                    const tab = event.target as HTMLElement;
                    setFocusedIndex(index);
                    // A focused tab looks hovered, as in TabsSubtle.
                    setHoveredIndex(index);
                    setFocusVisible(tab.matches(':focus-visible'));
                    const scroller = scrollerRef.current;
                    const before = scrollBeforeKey.current;
                    scrollBeforeKey.current = null;
                    if (scroller && before !== null) scroller.scrollLeft = before;
                    reveal(tab);
                  }}
                  onBlur={(event: React.FocusEvent<HTMLDivElement>) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                    setFocusedIndex(null);
                    setFocusVisible(false);
                    if (!isMouseInside.current) setHoveredIndex(null);
                  }}
                >
                  {/* Selected pill */}
                  {selectedRect ? (
                    <motion.div
                      aria-hidden="true"
                      className={cn('pointer-events-none absolute bg-active', shape.bg)}
                      initial={false}
                      animate={{
                        left: selectedRect.left,
                        width: selectedRect.width,
                        top: selectedRect.top,
                        height: selectedRect.height,
                        opacity: isHovering ? 0.8 : 1,
                      }}
                      transition={{ ...travel, opacity: tween.fast }}
                    />
                  ) : null}

                  {/* Hover pill */}
                  <AnimatePresence>
                    {hoverRect && !isHoveringSelected ? (
                      <motion.div
                        aria-hidden="true"
                        className={cn('pointer-events-none absolute bg-active', shape.bg)}
                        initial={{
                          ...(selectedRect ?? hoverRect),
                          opacity: 0,
                        }}
                        animate={{ ...hoverRect, opacity: 0.4 }}
                        exit={
                          !mouseInside && selectedRect
                            ? {
                                ...selectedRect,
                                opacity: 0,
                                transition: {
                                  ...(reduce ? instant : spring.moderate),
                                  opacity: tween.fast.exit,
                                },
                              }
                            : { opacity: 0, transition: spring.fast.exit }
                        }
                        transition={{ ...hoverTravel, opacity: tween.fast }}
                      />
                    ) : null}
                  </AnimatePresence>

                  {/* Focus ring */}
                  <AnimatePresence>
                    {focusRect ? (
                      <motion.div
                        aria-hidden="true"
                        data-slot="tabs-closable-focus-ring"
                        className={cn(
                          'pointer-events-none absolute z-20 border-2 border-[color:var(--focus-ring)]',
                          shape.focusRing,
                        )}
                        initial={false}
                        animate={{
                          left: focusRect.left - 2,
                          top: focusRect.top - 2,
                          width: focusRect.width + 4,
                          height: focusRect.height + 4,
                        }}
                        exit={{ opacity: 0, transition: spring.fast.exit }}
                        transition={{ ...focusTravel, opacity: tween.fast }}
                      />
                    ) : null}
                  </AnimatePresence>

                  {tabs.map((tab, index) => {
                    const selected = tab.id === selectedId;
                    const active = selected || hoveredIndex === index;
                    const iconOnly = compact && !selected;
                    const showsText = !iconOnly || !!tab.shortLabel;
                    const closeInIconSlot =
                      !selected && showsText && (hoveredIndex === index || focusedIndex === index);
                    const ids = tabsClosableIds(idPrefix, tab.id);
                    const label = labelWidths[tab.id] ?? 0;
                    const Icon = tab.icon;
                    return (
                      // A name not on screen (icon only, or cut short) shows in the kit's
                      // tooltip on hover and keyboard focus. The tree stays the same at every
                      // stage, so a change of stage never remounts a focused tab.
                      <Tooltip
                        key={tab.id}
                        content={tab.label}
                        side="bottom"
                        escapeThrough
                        forceOpen={iconOnly || tipTab === tab.id ? undefined : false}
                      >
                        <ClosableTab
                          index={index}
                          registerItem={registerItem}
                          value={tab.id}
                          id={ids.tab}
                          aria-controls={ids.panel}
                          aria-keyshortcuts="Delete"
                          data-fluid-hover-index={index}
                          data-selected={selected ? '' : undefined}
                          onPointerEnter={(event: React.PointerEvent<HTMLElement>) =>
                            noteCut(tab.id, event.currentTarget)
                          }
                          onFocus={(event: React.FocusEvent<HTMLElement>) => {
                            if (resyncEvents.has(event.nativeEvent)) return;
                            noteCut(tab.id, event.currentTarget);
                          }}
                          onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
                            if (event.key !== 'Delete' || event.defaultPrevented) return;
                            // A held key closes one tab, and a chord is someone else's.
                            if (event.repeat) return;
                            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
                              return;
                            event.preventDefault();
                            onClose(tab.id);
                          }}
                          onMouseDown={(event: React.MouseEvent<HTMLElement>) => {
                            // A middle press would start the browser's autoscroll.
                            if (event.button === 1) event.preventDefault();
                          }}
                          onAuxClick={(event: React.MouseEvent<HTMLElement>) => {
                            if (event.button !== 1) return;
                            event.preventDefault();
                            onClose(tab.id);
                          }}
                          className={cn(
                            'relative z-10 flex h-7 min-w-0 cursor-pointer items-center border-none bg-transparent outline-none',
                            shape.bg,
                            size.text,
                          )}
                          style={{
                            paddingLeft: PAD,
                            paddingRight: selected ? SELECTED_END : PAD,
                            ...(compact
                              ? {
                                  flex: 'none',
                                  maxWidth: selected ? 'var(--tabs-available)' : undefined,
                                }
                              : selected
                                ? { flex: 'none', maxWidth: '100%' }
                                : {
                                    flex: '0 1 auto',
                                    minWidth: CHROME + Math.min(label, MIN_LABEL),
                                  }),
                          }}
                        >
                          <span
                            aria-hidden="true"
                            className="relative flex shrink-0 items-center justify-center"
                            style={{ width: ICON, height: ICON }}
                          >
                            <Icon
                              size={ICON}
                              strokeWidth={active ? 2 : 1.5}
                              className={cn(
                                'shrink-0 transition-[color,stroke-width,opacity] duration-80',
                                active ? 'text-foreground' : 'text-muted-foreground',
                                closeInIconSlot && 'opacity-0',
                              )}
                            />
                          </span>
                          {/* Stacked: the invisible semibold copy keeps the width when the
                              selection changes the weight. In the compact stage the name stays
                              for assistive technology only. */}
                          <span
                            data-slot="tabs-closable-name"
                            className={cn('grid min-w-0', iconOnly && 'sr-only')}
                            style={{ marginLeft: GAP }}
                          >
                            <span
                              aria-hidden="true"
                              className="invisible col-start-1 row-start-1 truncate whitespace-nowrap"
                              style={semibold}
                            >
                              {tab.label}
                            </span>
                            <span
                              data-slot="tabs-closable-label"
                              className={cn(
                                'col-start-1 row-start-1 truncate whitespace-nowrap transition-[color,font-variation-settings] duration-80',
                                active ? 'text-foreground' : 'text-muted-foreground',
                              )}
                              style={{
                                fontVariationSettings: selected
                                  ? fontWeights.semibold
                                  : fontWeights.normal,
                              }}
                            >
                              {tab.label}
                            </span>
                          </span>
                          {iconOnly && tab.shortLabel ? (
                            <span
                              aria-hidden="true"
                              className={cn(
                                'whitespace-nowrap tabular-nums transition-colors duration-80',
                                active ? 'text-foreground' : 'text-muted-foreground',
                              )}
                              style={{ marginLeft: GAP }}
                            >
                              {tab.shortLabel}
                            </span>
                          ) : null}
                          {/* The selected tab keeps room for its close control after the name. */}
                          {selected ? (
                            <span
                              aria-hidden="true"
                              className="shrink-0"
                              style={{ width: CLOSE_GAP + CLOSE }}
                            />
                          ) : null}
                        </ClosableTab>
                      </Tooltip>
                    );
                  })}
                </Tabs.List>
              }
            />

            {/* Close controls: beside the tablist, never inside a tab, out of the tab order. On
                the selected tab after its name; on an unselected tab that shows text, in its
                icon's place while hovered or focused. A tab shrunk to its icon shows none. */}
            <div className="pointer-events-none absolute inset-0 z-30">
              {tabs.map((tab, index) => {
                const selected = tab.id === selectedId;
                const showsText = !(compact && !selected) || !!tab.shortLabel;
                const rect = itemRects[index];
                const shown =
                  !!rect &&
                  (selected || (showsText && (hoveredIndex === index || focusedIndex === index)));
                const left = rect
                  ? selected
                    ? rect.left + rect.width - SELECTED_END - CLOSE
                    : rect.left + PAD + ICON / 2 - CLOSE / 2
                  : 0;
                const button = (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={closeLabel(tab)}
                    data-slot="tabs-closable-close"
                    data-place={selected ? 'end' : 'icon'}
                    data-shown={shown ? '' : undefined}
                    // Keeps the focus where it is (the host moves it after the close), and keeps
                    // a middle press from starting the browser's autoscroll.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onClose(tab.id)}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      onClose(tab.id);
                    }}
                    className={cn(
                      'absolute flex cursor-pointer items-center justify-center text-muted-foreground outline-none',
                      'transition-[color,background-color,opacity] duration-80 hover:bg-active hover:text-foreground',
                      shape.chip,
                      shown ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
                    )}
                    style={{
                      width: CLOSE,
                      height: CLOSE,
                      left,
                      top: rect ? rect.top + (rect.height - CLOSE) / 2 : 0,
                    }}
                  >
                    <CloseIcon size={CLOSE_GLYPH} strokeWidth={2} />
                  </button>
                );
                // Named by its own label, which carries the tab's name. Only a shown control
                // opens its tooltip; the tree stays the same, so showing it never remounts it.
                return (
                  <Tooltip
                    key={tab.id}
                    content={closeLabel(tab)}
                    side="bottom"
                    escapeThrough
                    forceOpen={shown ? undefined : false}
                  >
                    {button}
                  </Tooltip>
                );
              })}
            </div>
          </div>

          {/* Each name's natural width, for the stage. Clipped to nothing, so it adds no overflow. */}
          <div
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-0 left-0 size-0 overflow-hidden"
          >
            {tabs.map((tab) => (
              <span
                key={tab.id}
                ref={(node) => {
                  if (node) measurers.current.set(tab.id, node);
                  else measurers.current.delete(tab.id);
                }}
                className={cn('absolute whitespace-nowrap', size.text)}
                style={semibold}
              >
                {tab.label}
              </span>
            ))}
          </div>
        </div>
        {trailing ? (
          <div
            ref={trailingRef}
            data-slot="tabs-closable-trailing"
            // Next to the last tab, as the tabs stand to each other; 12px clear of the fade once
            // the strip scrolls under it (the scroller's 4px margin reaches into this padding).
            className={cn('flex shrink-0 items-center gap-1', scrolls && 'pl-4')}
          >
            {trailing}
          </div>
        ) : null}
        {end ? (
          <div
            ref={endRef}
            data-slot="tabs-closable-end"
            // At least 8px from what comes before; 12px clear of the fade when it follows the
            // scrolling strip directly.
            className={cn(
              'ml-auto flex shrink-0 items-center gap-1',
              scrolls && !trailing ? 'pl-4' : 'pl-2',
            )}
          >
            {end}
          </div>
        ) : null}
      </div>
    );
  },
);
TabsClosable.displayName = 'TabsClosable';

type ClosableTabProps = Omit<React.ComponentProps<typeof Tabs.Tab>, 'ref'> & {
  index: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  /** The tooltip trigger's ref, merged with the strip's own. */
  ref?: React.Ref<HTMLElement>;
};

/** One tab, registered with the hover layer by its place in the strip. */
function ClosableTab({ index, registerItem, ref, ...props }: ClosableTabProps) {
  const element = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    registerItem(index, element.current);
    return () => registerItem(index, null);
  }, [index, registerItem]);
  return (
    <Tabs.Tab
      ref={(node: HTMLElement | null) => {
        element.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as { current: HTMLElement | null }).current = node;
      }}
      {...props}
    />
  );
}

export interface TabsClosablePanelProps extends HTMLAttributes<HTMLDivElement> {
  idPrefix: string;
  tabId: string;
  selected: boolean;
  children: ReactNode;
}

/** A tab's panel, named by its tab. Its content first renders when the tab is first selected,
 *  and stays mounted, hidden, while the tab is unselected. */
export const TabsClosablePanel = forwardRef<HTMLDivElement, TabsClosablePanelProps>(
  ({ idPrefix, tabId, selected, children, className, ...props }, ref) => {
    const ids = tabsClosableIds(idPrefix, tabId);
    const [seen, setSeen] = useState(selected);
    if (selected && !seen) setSeen(true);
    return (
      <div
        ref={ref}
        id={ids.panel}
        role="tabpanel"
        aria-labelledby={ids.tab}
        hidden={!selected}
        tabIndex={-1}
        className={cn('outline-none', className)}
        {...props}
      >
        {seen || selected ? children : null}
      </div>
    );
  },
);
TabsClosablePanel.displayName = 'TabsClosablePanel';
