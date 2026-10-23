'use client';

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { UseFluidHoverReturn } from '../../hooks/use-fluid-hover.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';
import type { MenuItemProps } from './menu-item.tsx';

// Submenus inside a dropdown popup.
//
// Base UI's SubmenuRoot lets the pointer cut diagonally across other rows to
// reach an open submenu (the safe area). While a submenu is open,
// useSubmenuHost keeps the parent's highlight on its trigger and moves it
// only with focus, so it doesn't track rows the pointer merely crosses.

/** Distance from the trigger row to its submenu, in px. Both primitives
 *  measure from the row, which sits inside the popup's 4px padding, so this
 *  leaves a 2px gap between the two surfaces. */
export const SUBMENU_SIDE_OFFSET = 6;
/** Pulls the submenu up by the popup's padding (p-1), so its first row
 *  lines up with the trigger row. */
export const SUBMENU_ALIGN_OFFSET = -4;

export type DropdownSubTriggerProps = Omit<MenuItemProps, 'checked' | 'onSelect' | 'closeOnClick'>;

const ROW_SELECTOR = '[data-fluid-hover-index]';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * The parent popup's side of its submenus. Use `onMouseEnter`,
 * `onMouseMove` and `onMouseLeave` in place of the hook's own, skip
 * clearing on blur while `holding()`, and hand `onSubmenuOpenChange` to the
 * rows through the dropdown context. `open` is the parent popup's own state.
 */
export function useSubmenuHost(
  containerRef: RefObject<HTMLElement | null>,
  hover: Pick<UseFluidHoverReturn, 'setActiveIndex' | 'handlers'>,
  open: boolean,
) {
  // The handlers object is new every render but its functions are stable;
  // depend on those so the callbacks below stay stable.
  const { setActiveIndex } = hover;
  const {
    onMouseEnter: hoverEnter,
    onMouseMove: hoverMove,
    onMouseLeave: hoverLeave,
  } = hover.handlers;
  const openIndexRef = useRef<number | null>(null);
  // Read in a trigger's effect cleanup; a layout effect updates it before
  // passive cleanups run in the same commit.
  const parentOpenRef = useRef(open);
  useIsoLayoutEffect(() => {
    parentOpenRef.current = open;
  }, [open]);
  // Last pointer position. While a submenu is open it's tracked on the
  // document: Base UI disables pointer events on the parent during the crossing.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const stopListeningRef = useRef<(() => void) | null>(null);

  const listen = useCallback(() => {
    if (stopListeningRef.current) return;
    const onMove = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener('pointermove', onMove, { capture: true, passive: true });
    stopListeningRef.current = () => {
      document.removeEventListener('pointermove', onMove, { capture: true });
      stopListeningRef.current = null;
    };
  }, []);

  useEffect(() => () => stopListeningRef.current?.(), []);

  const onSubmenuOpenChange = useCallback(
    (index: number, open: boolean) => {
      if (open) {
        openIndexRef.current = index;
        setActiveIndex(index);
        listen();
        return;
      }
      if (openIndexRef.current !== index) return;
      openIndexRef.current = null;
      stopListeningRef.current?.();
      // The whole menu is closing: let the highlight fade out with it.
      if (!parentOpenRef.current) return;
      // Hand the highlight back to the focused row, else the row under the
      // pointer, else nothing.
      const container = containerRef.current;
      if (!container) return;
      const focused = (document.activeElement as HTMLElement | null)?.closest?.(ROW_SELECTOR);
      if (focused && container.contains(focused)) {
        setActiveIndex(Number(focused.getAttribute('data-fluid-hover-index')));
        return;
      }
      const p = pointerRef.current;
      const r = container.getBoundingClientRect();
      if (p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
        hoverMove({ clientX: p.x, clientY: p.y } as React.MouseEvent);
      } else {
        setActiveIndex(null);
      }
    },
    [containerRef, setActiveIndex, hoverMove, listen],
  );

  const holding = useCallback(() => openIndexRef.current !== null, []);

  // Entering starts a fresh hover session; a held highlight stays put.
  const onMouseEnter = useCallback(() => {
    if (openIndexRef.current !== null) return;
    hoverEnter();
  }, [hoverEnter]);

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
      // While a submenu is open, only focus moves the highlight.
      if (openIndexRef.current !== null) return;
      hoverMove(e);
    },
    [hoverMove],
  );

  const onMouseLeave = useCallback(() => {
    if (openIndexRef.current !== null) return;
    hoverLeave();
  }, [hoverLeave]);

  return { onSubmenuOpenChange, holding, onMouseEnter, onMouseMove, onMouseLeave };
}

/** Reports a trigger's submenu opening and closing to its parent popup. */
export function useReportSubmenu(
  onSubmenuOpenChange: ((index: number, open: boolean) => void) | undefined,
  index: number,
  open: boolean,
) {
  useEffect(() => {
    if (!open || !onSubmenuOpenChange) return;
    onSubmenuOpenChange(index, true);
    return () => onSubmenuOpenChange(index, false);
  }, [onSubmenuOpenChange, index, open]);
}

/** The trailing chevron on a submenu trigger row. It lights with the row,
 *  like the leading icon. */
export function SubmenuChevron({ lit }: { lit: boolean }) {
  const icons = useIcons();
  const ChevronRight = icons['chevron-right'];
  const sizeClasses = useSize();
  return (
    <span aria-hidden="true" className="inline-grid shrink-0 rtl:-scale-x-100">
      <ChevronRight
        size={sizeClasses.icon}
        strokeWidth={lit ? 2 : 1.5}
        className={cn(
          'transition-[color,stroke-width] duration-80',
          lit ? 'text-foreground' : 'text-muted-foreground',
        )}
      />
    </span>
  );
}
