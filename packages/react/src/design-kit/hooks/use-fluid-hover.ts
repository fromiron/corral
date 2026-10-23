'use client';

import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export interface ItemRect {
  top: number;
  height: number;
  left: number;
  width: number;
}

export interface UseFluidHoverOptions {
  /** "y" vertical lists (default), "x" horizontal strips, "xy" 2-D grids
   *  (Euclidean distance to each item's center). */
  axis?: 'x' | 'y' | 'xy';
  /** Skips an item in hit-testing without unregistering it (e.g. a collapsed
   *  sub-tree row). Called on every mouse move, so keep it cheap. */
  isItemDisabled?: (element: HTMLElement) => boolean;
  /** Routes clicks between items to the highlighted item (default true).
   *  `false` keeps gaps inert; `{ maxDistance }` limits it to that many px. */
  gapClick?: boolean | { maxDistance?: number };
}

export interface UseFluidHoverReturn {
  activeIndex: number | null;
  setActiveIndex: Dispatch<SetStateAction<number | null>>;
  itemRects: ItemRect[];
  /** True once `itemRects` matches the current items. Gate overlays on it, or
   *  they visibly slide from a stale rect to the corrected one. */
  isMeasured: boolean;
  /** Counts pointer entries. Key the highlight on it so it fades in at the new
   *  row instead of sliding over from the previous one. */
  session: number;
  /** The same count as `session`, for code that reads it outside a render. */
  sessionRef: RefObject<number>;
  handlers: {
    /** Picks the item nearest the pointer; ignores moves from portalled children. */
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    /** Routes a click between items to the highlighted item. Clicks inside an
     *  item, on a control, or from a portalled child are left alone. */
    onClick: (e: React.MouseEvent) => void;
  };
  registerItem: (index: number, element: HTMLElement | null) => void;
  /** Re-measures on the next frame, holding `isMeasured` false until done. For
   *  popups that stay mounted between opens; registration and resizes already
   *  trigger it. */
  remeasure: () => void;
  /** Re-reads rects synchronously without touching `isMeasured`. Only for rows
   *  moving under a visible overlay frame by frame (e.g. a height animation). */
  measureItems: () => void;
}

export interface PickNearestInput {
  axis: 'x' | 'y' | 'xy';
  /** The pointer, in viewport coordinates. */
  point: { x: number; y: number };
  /** Item rects in the container's layout space (sparse). */
  rects: readonly (ItemRect | undefined)[];
  /** Map layout rects into the pointer's viewport space. */
  containerRect: { left: number; top: number; width: number; height: number };
  scroll: { x: number; y: number };
  border: { x: number; y: number };
  /** Lets an ancestor `transform: scale` (a popup mid scale-in) be factored out. */
  layoutSize: { width: number; height: number };
  /** Skips an item without unregistering it. */
  isDisabled?: (index: number) => boolean;
}

/**
 * The item containing the pointer, else the one with the nearest center (so
 * gaps and padding still land). Ties keep the first item.
 */
export function pickNearest({
  axis,
  point,
  rects,
  containerRect,
  scroll,
  border,
  layoutSize,
  isDisabled,
}: PickNearestInput): number | null {
  const scaleX = layoutSize.width > 0 ? containerRect.width / layoutSize.width : 1;
  const scaleY = layoutSize.height > 0 ? containerRect.height / layoutSize.height : 1;
  let closestIndex: number | null = null;
  let closestDistance = Infinity;
  let containingIndex: number | null = null;

  for (let index = 0; index < rects.length; index++) {
    const r = rects[index];
    if (!r) continue;
    if (isDisabled?.(index)) continue;

    if (axis === 'xy') {
      const left = containerRect.left + (border.x + r.left - scroll.x) * scaleX;
      const top = containerRect.top + (border.y + r.top - scroll.y) * scaleY;
      const width = r.width * scaleX;
      const height = r.height * scaleY;
      if (point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height) {
        containingIndex = index;
      }
      const distance = Math.hypot(point.x - (left + width / 2), point.y - (top + height / 2));
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
      continue;
    }

    const horizontal = axis === 'x';
    const mousePos = horizontal ? point.x : point.y;
    const scale = horizontal ? scaleX : scaleY;
    const itemStart =
      (horizontal ? containerRect.left : containerRect.top) +
      ((horizontal ? border.x : border.y) +
        (horizontal ? r.left : r.top) -
        (horizontal ? scroll.x : scroll.y)) *
        scale;
    const itemSize = (horizontal ? r.width : r.height) * scale;
    if (mousePos >= itemStart && mousePos <= itemStart + itemSize) {
      containingIndex = index;
    }
    const distance = Math.abs(mousePos - (itemStart + itemSize / 2));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }

  return containingIndex ?? closestIndex;
}

/**
 * Whether an event happened inside its handler's element. React bubbles
 * events from portalled children through React ancestors; this filters them.
 */
export function isOwnEvent(e: { currentTarget?: EventTarget | null; target?: EventTarget | null }) {
  const { currentTarget, target } = e;
  if (!(currentTarget instanceof Node) || !(target instanceof Node)) return true;
  return currentTarget.contains(target);
}

/** Set on the highlighted item (boolean attribute). */
export const ACTIVE_ATTR = 'data-fluid-hover-active';
/** Set on the container: the highlighted index, or absent. */
export const ACTIVE_INDEX_ATTR = 'data-fluid-hover-active-index';

const ACTIVATOR_SELECTOR =
  "a[href], button, [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='radio'], [role='checkbox'], [role='tab'], [role='link'], [role='button']";

// The item itself if interactive, else the first control inside it (a card
// wrapping its link).
function resolveActivator(element: HTMLElement): HTMLElement {
  if (element.matches(ACTIVATOR_SELECTOR) || element.hasAttribute('tabindex')) {
    return element;
  }
  return element.querySelector<HTMLElement>(ACTIVATOR_SELECTOR) ?? element;
}

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Frames to retry while items have no layout box yet (a popup can be in the
// DOM a frame before layout); capped so a permanently hidden list stops.
const measurementAttempts = 3;

export function useFluidHover<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  options: UseFluidHoverOptions = {},
): UseFluidHoverReturn {
  const { axis = 'y', isItemDisabled, gapClick = true } = options;
  const gapClickMaxDistance =
    typeof gapClick === 'object' ? (gapClick.maxDistance ?? Infinity) : Infinity;
  const itemsRef = useRef(new Map<number, HTMLElement>());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Mirror for handlers. A layout effect runs before rows' registration effects.
  const activeIndexRef = useRef<number | null>(null);
  useIsoLayoutEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Mirror the state into DOM attributes (for styling, devtools and tests).
  useEffect(() => {
    const container = containerRef.current;
    // The registry map is never replaced, so cleanup sees who holds the index then.
    const items = itemsRef.current;
    if (activeIndex === null) container?.removeAttribute(ACTIVE_INDEX_ATTR);
    else container?.setAttribute(ACTIVE_INDEX_ATTR, String(activeIndex));
    const active = activeIndex === null ? undefined : items.get(activeIndex);
    active?.setAttribute(ACTIVE_ATTR, '');
    return () => {
      active?.removeAttribute(ACTIVE_ATTR);
      // A row that re-registered under this index was marked by registerItem.
      if (activeIndex !== null) items.get(activeIndex)?.removeAttribute(ACTIVE_ATTR);
    };
  }, [activeIndex, containerRef]);
  const [itemRects, setItemRects] = useState<ItemRect[]>([]);
  const [isMeasured, setIsMeasured] = useState(false);
  const itemRectsRef = useRef<ItemRect[]>([]);
  const [session, setSession] = useState(0);
  const sessionRef = useRef(0);
  // Set on enter; the first highlight change then starts a new session.
  const sessionPendingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const remeasureRafIdRef = useRef<number | null>(null);

  // Returns false (publishing nothing) if any item lacks a layout box, so the
  // last complete measurement stands instead of being zeroed.
  const runMeasurement = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    const rects: ItemRect[] = [];
    let everyItemHasLayout = true;
    itemsRef.current.forEach((element, index) => {
      // Hidden elements report all offsets as 0. `position: fixed` items also
      // lack an offsetParent but have a size, so check both.
      const hasLayoutBox =
        element.offsetParent !== null || element.offsetWidth > 0 || element.offsetHeight > 0;
      if (!hasLayoutBox) {
        everyItemHasLayout = false;
        return;
      }
      // offset* rather than getBoundingClientRect: unaffected by CSS transforms
      // and in the same space as `position: absolute` overlays. Offsets of
      // positioned ancestors inside the container are accumulated.
      let top = element.offsetTop;
      let left = element.offsetLeft;
      let ancestor = element.offsetParent as HTMLElement | null;
      while (ancestor && ancestor !== container && container.contains(ancestor)) {
        top += ancestor.offsetTop + ancestor.clientTop;
        left += ancestor.offsetLeft + ancestor.clientLeft;
        ancestor = ancestor.offsetParent as HTMLElement | null;
      }
      rects[index] = {
        top,
        height: element.offsetHeight,
        left,
        width: element.offsetWidth,
      };
    });
    if (!everyItemHasLayout) return false;
    // Skip the state update when nothing moved.
    const prev = itemRectsRef.current;
    let changed = prev.length !== rects.length;
    for (let i = 0; !changed && i < rects.length; i++) {
      const p = prev[i];
      const r = rects[i];
      if (p === r) continue; // both undefined (sparse slot)
      changed =
        !p ||
        !r ||
        p.top !== r.top ||
        p.left !== r.left ||
        p.width !== r.width ||
        p.height !== r.height;
    }
    if (changed) {
      itemRectsRef.current = rects;
      setItemRects(rects);
    }
    return true;
  }, [containerRef]);

  const measureItems = useCallback(() => {
    runMeasurement();
  }, [runMeasurement]);

  // Coalesces every trigger into one pass on the next frame. The only place
  // `isMeasured` turns true, so it can't while another pass is queued.
  const scheduleMeasurement = useCallback(
    (attempts: number) => {
      const attempt = (attemptsLeft: number) => {
        if (remeasureRafIdRef.current !== null) {
          cancelAnimationFrame(remeasureRafIdRef.current);
        }
        remeasureRafIdRef.current = requestAnimationFrame(() => {
          remeasureRafIdRef.current = null;
          if (runMeasurement()) {
            setIsMeasured(true);
          } else if (attemptsLeft > 1) {
            attempt(attemptsLeft - 1);
          }
        });
      };
      attempt(attempts);
    },
    [runMeasurement],
  );

  const remeasure = useCallback(() => {
    setIsMeasured(false);
    scheduleMeasurement(measurementAttempts);
  }, [scheduleMeasurement]);

  // Observes the items themselves too: rows can resize in place, and the
  // container observed below may since have been remounted.
  const itemRoRef = useRef<ResizeObserver | null>(null);
  const getItemRo = useCallback(() => {
    if (itemRoRef.current === null && typeof ResizeObserver !== 'undefined') {
      itemRoRef.current = new ResizeObserver(() => scheduleMeasurement(measurementAttempts));
    }
    return itemRoRef.current;
  }, [scheduleMeasurement]);

  const registerItem = useCallback(
    (index: number, element: HTMLElement | null) => {
      if (element) {
        itemsRef.current.set(index, element);
        getItemRo()?.observe(element);
        if (index === activeIndexRef.current) element.setAttribute(ACTIVE_ATTR, '');
      } else {
        const previous = itemsRef.current.get(index);
        if (previous) itemRoRef.current?.unobserve(previous);
        // A row that only moved index must not carry the mark along.
        previous?.removeAttribute(ACTIVE_ATTR);
        itemsRef.current.delete(index);
        // Clear the highlight if its row is gone. Checked when the update
        // applies, so a row that merely moved hands it to the row now there.
        if (index === activeIndexRef.current) {
          setActiveIndex((current) =>
            current === index && !itemsRef.current.has(index) ? null : current,
          );
        }
      }
      remeasure();
    },
    [remeasure, getItemRo],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isOwnEvent(e)) return;
      const mouseX = e.clientX;
      const mouseY = e.clientY;

      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }

      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const container = containerRef.current;
        if (!container) return;
        const next = pickNearest({
          axis,
          point: { x: mouseX, y: mouseY },
          rects: itemRectsRef.current,
          containerRect: container.getBoundingClientRect(),
          scroll: { x: container.scrollLeft, y: container.scrollTop },
          border: { x: container.clientLeft, y: container.clientTop },
          layoutSize: { width: container.offsetWidth, height: container.offsetHeight },
          isDisabled: isItemDisabled
            ? (index) => {
                const el = itemsRef.current.get(index);
                return !!el && isItemDisabled(el);
              }
            : undefined,
        });
        if (sessionPendingRef.current && next !== activeIndexRef.current) {
          sessionPendingRef.current = false;
          sessionRef.current += 1;
          setSession(sessionRef.current);
        }
        setActiveIndex(next);
      });
    },
    [axis, containerRef, isItemDisabled],
  );

  const handleMouseEnter = useCallback(() => {
    sessionPendingRef.current = true;
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setActiveIndex(null);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      for (const element of itemsRef.current.values()) {
        if (element.contains(target)) return;
      }
      // A row that unmounted while its own click bubbled already handled it.
      if (!target.isConnected) return;
      if (!isOwnEvent(e)) return;
      // Controls between rows (a search field, a footer button) keep their click.
      const control = (target as Element).closest?.(
        "input, textarea, select, button, a, summary, [contenteditable], [role='textbox'], [role='searchbox'], [role='button']",
      );
      if (control) return;
      if (gapClick === false) return;
      const index = activeIndexRef.current;
      if (index === null) return;
      const element = itemsRef.current.get(index);
      if (!element || isItemDisabled?.(element)) return;
      if (gapClickMaxDistance !== Infinity) {
        const r = element.getBoundingClientRect();
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        if (Math.hypot(dx, dy) > gapClickMaxDistance) return;
      }
      // A real DOM click, so the item's own handlers run as usual.
      resolveActivator(element).click();
    },
    [isItemDisabled, gapClick, gapClickMaxDistance],
  );

  // Remeasure on container resize. `isMeasured` stays true: the item set is
  // unchanged, and hiding overlays on every reflow would flicker them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => scheduleMeasurement(measurementAttempts));
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, scheduleMeasurement]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (remeasureRafIdRef.current !== null) {
        cancelAnimationFrame(remeasureRafIdRef.current);
      }
      itemRoRef.current?.disconnect();
      itemRoRef.current = null;
    };
  }, []);

  return {
    activeIndex,
    setActiveIndex,
    itemRects,
    isMeasured,
    session,
    sessionRef,
    handlers: {
      onMouseMove: handleMouseMove,
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      onClick: handleClick,
    },
    registerItem,
    remeasure,
    measureItems,
  };
}

/**
 * Registers an item with its list while mounted. If `registerItem` or `index`
 * is missing (a row outside any list), nothing is registered.
 */
export function useRegisterFluidHoverItem(
  registerItem: ((index: number, element: HTMLElement | null) => void) | undefined,
  index: number | undefined,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!registerItem || index === undefined) return;
    registerItem(index, ref.current);
    return () => registerItem(index, null);
  }, [index, registerItem, ref]);
}
