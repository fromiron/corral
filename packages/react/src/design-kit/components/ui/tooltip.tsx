'use client';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { motion, useMotionValue } from 'motion/react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { fontWeights } from '../../lib/font-weight.ts';
import { omit } from '../../lib/omit.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { exitFallbackMs, spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';

// ---------------------------------------------------------------------------
// Portal container context
// ---------------------------------------------------------------------------

const TooltipPortalContainerContext = createContext<HTMLElement | null>(null);

function TooltipPortalContainer({
  value,
  children,
}: {
  value: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <TooltipPortalContainerContext.Provider value={value}>
      {children}
    </TooltipPortalContainerContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const DEFAULT_DELAY = 200;

// Whether a <TooltipProvider> is above. A per-instance Provider is only added
// without one, since it would defeat cross-tooltip skip-delay grouping.
const TooltipGroupContext = createContext(false);

interface TooltipProviderProps {
  children: ReactNode;
  /** Hover delay before tooltips open, in ms. Defaults to 200. */
  delayDuration?: number;
  /** After a tooltip closes, adjacent tooltips opened within this window
   *  skip the hover delay, in ms. Defaults to 300. */
  skipDelayDuration?: number;
}

/** Groups descendant Tooltips so adjacent ones open without re-waiting the
 *  delay. Wrap once at the app level; bare Tooltips still work without it. */
function TooltipProvider({
  children,
  delayDuration = DEFAULT_DELAY,
  skipDelayDuration = 300,
}: TooltipProviderProps) {
  return (
    <TooltipGroupContext.Provider value={true}>
      <TooltipPrimitive.Provider delay={delayDuration} timeout={skipDelayDuration}>
        {children}
      </TooltipPrimitive.Provider>
    </TooltipGroupContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

interface TooltipProps {
  content: ReactNode;
  children: React.ReactElement<{ 'aria-describedby'?: string }>;
  side?: TooltipSide;
  sideOffset?: number;
  /** Hover delay before this tooltip opens, in ms. Defaults to 200, or to the
   *  ambient TooltipProvider's delayDuration when one is present. */
  delayDuration?: number;
  className?: string;
  /** Classes for the portalled positioner, e.g. a z utility (default z-50). */
  contentClassName?: string;
  /** true forces open, false forces closed, undefined uses hover/focus. */
  forceOpen?: boolean;
  /** Follow the cursor along one axis, for tall or wide triggers. */
  followCursor?: 'x' | 'y';
  /** Called when the internal open state changes (before forceOpen applies). */
  onOpenChange?: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

function getSlideOffset(side: TooltipSide) {
  switch (side) {
    case 'top':
      return { y: 4 };
    case 'bottom':
      return { y: -4 };
    case 'left':
      return { x: 4 };
    case 'right':
      return { x: -4 };
  }
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

// Base UI can't see the Motion exit spring and would unmount mid-exit. Closes
// call preventUnmountOnClose() and the content unmounts via actionsRef. A
// close made by setting `open` skips onOpenChange, so it's replayed through
// actionsRef.close().
function usePopupExit(open: boolean, setOpen: (open: boolean) => void) {
  const actionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const [rootOpen, setRootOpen] = useState(open);
  if (open && !rootOpen) setRootOpen(true);
  useLayoutEffect(() => {
    if (open || !rootOpen) return;
    // Without actionsRef, close immediately rather than stay open.
    if (actionsRef.current) actionsRef.current.close();
    else setRootOpen(false);
  }, [open, rootOpen]);
  const onOpenChange = (next: boolean, details: { preventUnmountOnClose: () => void }) => {
    if (!next) {
      details.preventUnmountOnClose();
      setRootOpen(false);
    }
    // A replayed close finds `open` already false: nothing to report.
    if (next !== open) setOpen(next);
  };
  return { actionsRef, rootOpen: open || rootOpen, onOpenChange };
}

function Tooltip({
  content,
  children,
  side = 'top',
  sideOffset = 8,
  delayDuration,
  className,
  contentClassName,
  forceOpen,
  onOpenChange: onOpenChangeProp,
  followCursor,
}: TooltipProps) {
  const tooltipId = useId();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = forceOpen !== undefined ? forceOpen : internalOpen;
  const { actionsRef, rootOpen, onOpenChange } = usePopupExit(open, (v) => {
    setInternalOpen(v);
    onOpenChangeProp?.(v);
  });
  // Fallback unmount for background tabs, where onAnimationComplete can
  // stall. Armed only after an open, so idle tooltips hold no timers.
  const openedRef = useRef(open);
  useEffect(() => {
    if (open) {
      openedRef.current = true;
      return;
    }
    if (!openedRef.current) return;
    openedRef.current = false;
    const id = setTimeout(() => actionsRef.current?.unmount(), exitFallbackMs(spring.fast));
    return () => clearTimeout(id);
  }, [open, actionsRef]);
  const shape = useShape();
  const portalContainer = useContext(TooltipPortalContainerContext);
  const hasAmbientProvider = useContext(TooltipGroupContext);

  const slideOffset = getSlideOffset(side);

  // A motion value, so pointer moves skip React re-renders.
  const followOffset = useMotionValue(0);
  // Force-opened, there's no cursor to follow: rest centered.
  useEffect(() => {
    if (forceOpen && followCursor) followOffset.set(0);
  }, [forceOpen, followCursor, followOffset]);
  const handleFollowMove = (event: React.PointerEvent) => {
    if (!followCursor) return;
    const rect = event.currentTarget.getBoundingClientRect();
    followOffset.set(
      followCursor === 'y'
        ? event.clientY - (rect.top + rect.height / 2)
        : event.clientX - (rect.left + rect.width / 2),
    );
  };

  const tooltip = (
    <TooltipPrimitive.Root open={rootOpen} onOpenChange={onOpenChange} actionsRef={actionsRef}>
      {/* Undefined delay inherits the provider's. */}
      <TooltipPrimitive.Trigger
        render={children}
        aria-describedby={
          [children.props['aria-describedby'], open ? tooltipId : undefined]
            .filter(Boolean)
            .join(' ') || undefined
        }
        delay={delayDuration}
        onPointerMove={followCursor ? handleFollowMove : undefined}
      />
      <TooltipPrimitive.Portal container={portalContainer ?? undefined}>
        <TooltipPrimitive.Positioner
          side={side}
          sideOffset={sideOffset}
          className={cn('z-50', contentClassName)}
        >
          <TooltipPrimitive.Popup
            role="tooltip"
            id={tooltipId}
            render={(props, state) => {
              const exiting = state.transitionStatus === 'ending';
              const contentChildren = content;
              const { style: baseStyle, ...baseProps } =
                props as React.HTMLAttributes<HTMLDivElement>;
              // Strip React-DOM handlers whose signatures clash with motion's.
              const rest = omit(baseProps, [
                'onDrag',
                'onDragStart',
                'onDragEnd',
                'onAnimationStart',
                'onAnimationEnd',
                'onAnimationIteration',
              ]);
              return (
                // Outer: popup props + cursor follow; inner: enter/exit slide,
                // so the two transforms don't fight.
                <motion.div
                  {...rest}
                  style={{
                    ...(baseStyle as React.CSSProperties | undefined),
                    ...(followCursor === 'y'
                      ? { y: followOffset }
                      : followCursor === 'x'
                        ? { x: followOffset }
                        : {}),
                  }}
                >
                  <motion.div
                    className={cn(
                      // Extra padding only where text-box trim applies, so the
                      // height matches untrimmed browsers (~24px).
                      'bg-foreground text-background text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] px-2 py-1',
                      '[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both]:py-2',
                      shape.bg,
                      className,
                    )}
                    style={{ fontVariationSettings: fontWeights.normal }}
                    initial={{ opacity: 0, ...slideOffset }}
                    // Both targets name x and y, or a separate instant
                    // animation would complete and unmount too early.
                    animate={
                      exiting
                        ? { opacity: 0, x: 0, y: 0, ...slideOffset }
                        : { opacity: 1, x: 0, y: 0 }
                    }
                    transition={exiting ? spring.fast.exit : spring.fast}
                    onAnimationComplete={() => {
                      if (exiting) actionsRef.current?.unmount();
                    }}
                  >
                    {contentChildren}
                  </motion.div>
                </motion.div>
              );
            }}
          />
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );

  // Without a TooltipProvider, use a local one for the default delay.
  if (hasAmbientProvider) return tooltip;

  return (
    <TooltipPrimitive.Provider delay={delayDuration ?? DEFAULT_DELAY}>
      {tooltip}
    </TooltipPrimitive.Provider>
  );
}

export type { TooltipProps, TooltipProviderProps, TooltipSide };
export { Tooltip, TooltipPortalContainer, TooltipProvider };
