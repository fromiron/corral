'use client';

import { animate, motion, useReducedMotion } from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { exitFallbackMs, spring, tween } from '../lib/springs.ts';
import { Splitter, type SplitterBaseProps } from './splitter.tsx';
import { cn } from './utils.ts';

// -----------------------------------------------------------------------------
// A main region and a side region in one of five presentations. The supplied
// kit has no right-hand panel: its Dialog is modal and its Sidebar is the
// navigation shell. This frame lays the two regions out, and the host decides
// the presentation from the width the frame reports.
//
//   closed     main only; the side stays mounted, hidden, unless the host lets it go
//   beside     main, Splitter, side
//   maximized  side only; main stays mounted, hidden and inert
//   drawer     side over main's right edge; only main is dimmed and inert
//   withdrawn  main only; the side stays mounted, hidden
//
// Both regions keep one element each across presentations, so their children
// never remount. A drawer slides in and out on the kit's moderate tier and its
// scrim fades on the moderate tween; reduced motion changes both at once.
//
// A bottom region (a dock) may lie under both, across the frame's width. A
// drawer and its scrim cover it too and take it out of use; a maximized side
// covers main only. Its shown height yields so main keeps its least height.
// -----------------------------------------------------------------------------

export type SidePanelPresentation = 'closed' | 'beside' | 'maximized' | 'drawer' | 'withdrawn';

interface SidePanelFrameBaseProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  presentation: SidePanelPresentation;
  main: ReactNode;
  side: ReactNode;
  /** The side region's accessible name. */
  sideLabel: string;
  /** The side's width in px beside main. */
  sideWidth: number;
  /** The drawer's width in px, never wider than the frame. The host computes it (a whole narrow
   *  frame, say). */
  drawerWidth: number;
  /** Keep the side mounted (hidden) while closed, so every tab keeps its screen state (default).
   *  Withdrawn always keeps it. */
  keepSideMounted?: boolean;
  /** The splitter shown beside; its value is `sideWidth`. Without it there is none. While it is
   *  dragged the root carries `data-resizing`. */
  resize?: Omit<SplitterBaseProps, 'value'>;
  /** The frame's own width in px, on every change. The first width arrives in a layout effect
   *  after the first render, before paint: a host deciding the presentation from it starts as
   *  if there were no room. */
  onFrameWidthChange?: (px: number) => void;
  /** A press on the dimmed main region behind a drawer. */
  onScrimPress?: () => void;
  /** Escape while a drawer is open, unless something already handled it or an IME is composing.
   *  The frame marks the event handled. */
  onEscape?: (event: KeyboardEvent) => void;
  /** When main is taken out of use while it holds the focus, the side region takes it. When the
   *  side is hidden while it holds the focus, the focus falls to the document: the host moves it
   *  (to the control that opened the panel, say). */
  mainRef?: Ref<HTMLDivElement>;
  sideRef?: Ref<HTMLElement>;
  mainClassName?: string;
  sideClassName?: string;
}

interface SidePanelFrameBottomProps {
  /** A region under main and the side, across the frame (a dock). */
  bottom: ReactNode;
  /** The bottom region's accessible name. */
  bottomLabel: string;
  /** The bottom's height in px, as the host keeps it. The shown height may be less. */
  bottomHeight: number;
  /** Whether the bottom is on screen (default). Closed, it stays mounted, hidden and out of the
   *  flow at its height, so its content keeps its size; a focus inside it falls to the
   *  document, and the host moves it. */
  bottomOpen?: boolean;
  /** The horizontal splitter on the bottom's top edge; its value is the shown height. While it is
   *  dragged the root carries `data-resizing`. */
  bottomResize?: Omit<SplitterBaseProps, 'value'>;
  /** Main's least height in px: the shown bottom yields so main keeps it. The host's
   *  `bottomHeight` is unchanged. */
  mainMinHeight?: number;
  /** The bottom's least shown height in px. When yielding would take it below this (or to
   *  nothing), the open bottom is withdrawn: not drawn, out of the flow at the host's height,
   *  until there is room again. The host's height and open state are unchanged. */
  bottomMinHeight?: number;
  /** The bottom's height on screen, on every change (a yield, say); 0 when it is not drawn. */
  onShownBottomHeightChange?: (px: number) => void;
  /** Whether the open bottom is withdrawn for want of room, on mount and on every change. A
   *  focus inside it falls to the document; the host may move it on this report. */
  onBottomWithdrawnChange?: (withdrawn: boolean) => void;
  bottomRef?: Ref<HTMLElement>;
  bottomClassName?: string;
}

export type SidePanelFrameProps = SidePanelFrameBaseProps &
  (SidePanelFrameBottomProps | { [K in keyof SidePanelFrameBottomProps]?: undefined });

function assign<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

const SLIDE_OUT = 'translateX(100%)';
const SLIDE_IN = 'translateX(0%)';

export const SidePanelFrame = forwardRef<HTMLDivElement, SidePanelFrameProps>(
  (
    {
      presentation,
      main,
      side,
      sideLabel,
      sideWidth,
      drawerWidth,
      keepSideMounted = true,
      resize,
      onFrameWidthChange,
      onScrimPress,
      onEscape,
      mainRef,
      sideRef,
      mainClassName,
      sideClassName,
      bottom,
      bottomLabel,
      bottomHeight = 0,
      bottomOpen = true,
      bottomResize,
      mainMinHeight,
      bottomMinHeight = 0,
      onShownBottomHeightChange,
      onBottomWithdrawnChange,
      bottomRef,
      bottomClassName,
      className,
      ...props
    },
    ref,
  ) => {
    const hasBottom = bottom !== undefined && bottom !== null;
    const reduce = useReducedMotion() ?? false;
    const rootRef = useRef<HTMLDivElement | null>(null);
    const mainElement = useRef<HTMLDivElement | null>(null);
    const sideElement = useRef<HTMLElement | null>(null);
    const bottomElement = useRef<HTMLDivElement | null>(null);

    // A drawer that has just closed keeps its place while it slides away.
    const [leaving, setLeaving] = useState(false);
    const [previous, setPrevious] = useState(presentation);
    if (previous !== presentation) {
      setPrevious(presentation);
      setLeaving(
        previous === 'drawer' &&
          (presentation === 'closed' || presentation === 'withdrawn') &&
          !reduce,
      );
    }

    const [frameWidth, setFrameWidth] = useState(0);
    const [frameHeight, setFrameHeight] = useState(0);
    const reportWidth = useRef(onFrameWidthChange);
    reportWidth.current = onFrameWidthChange;
    // Measured before paint, so a host deciding the presentation from it never shows a wrong one.
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      let last = -1;
      const measure = () => {
        setFrameHeight(root.clientHeight);
        const width = root.clientWidth;
        if (width === last) return;
        last = width;
        setFrameWidth(width);
        reportWidth.current?.(width);
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      return () => observer.disconnect();
    }, []);

    const [resizing, setResizing] = useState(false);

    const drawer = presentation === 'drawer';
    const outOfUse = drawer || presentation === 'maximized';
    const overlay = drawer || leaving;
    const shown = presentation === 'beside' || presentation === 'maximized' || drawer;
    const sideMounted = presentation !== 'closed' || keepSideMounted || leaving;
    // A drawer as wide as the frame has no edge over main to draw.
    const drawerFull = frameWidth > 0 && drawerWidth >= frameWidth;

    // The room the bottom may take: all of it, unless main keeps a least height (once measured).
    const room =
      mainMinHeight !== undefined && frameHeight > 0
        ? Math.max(0, frameHeight - mainMinHeight)
        : Number.POSITIVE_INFINITY;
    // An open bottom with less room than its least height (or none) is withdrawn.
    const bottomWithdrawn = hasBottom && bottomOpen && room < Math.max(1, bottomMinHeight);
    const bottomState = !bottomOpen ? 'closed' : bottomWithdrawn ? 'withdrawn' : 'open';
    const shownBottom = hasBottom && bottomState === 'open' ? Math.min(bottomHeight, room) : 0;
    const bottomShown = shownBottom > 0;
    const reportShown = useRef({ onShownBottomHeightChange, onBottomWithdrawnChange });
    reportShown.current = { onShownBottomHeightChange, onBottomWithdrawnChange };
    const lastShown = useRef<{ height: number; withdrawn: boolean } | null>(null);
    useLayoutEffect(() => {
      if (!hasBottom) return;
      const last = lastShown.current;
      lastShown.current = { height: shownBottom, withdrawn: bottomWithdrawn };
      if (last?.height !== shownBottom)
        reportShown.current.onShownBottomHeightChange?.(shownBottom);
      if (last?.withdrawn !== bottomWithdrawn) {
        reportShown.current.onBottomWithdrawnChange?.(bottomWithdrawn);
      }
    }, [hasBottom, shownBottom, bottomWithdrawn]);

    // Main or the bottom turning inert would drop the focus it holds: the side takes it, as a
    // dialog's popup does. The host may move it on from there. Focus elsewhere (the sidebar)
    // stays.
    const bottomOutOfUse = hasBottom && drawer;
    const wasOutOfUse = useRef({ main: outOfUse, bottom: bottomOutOfUse });
    useLayoutEffect(() => {
      const was = wasOutOfUse.current;
      wasOutOfUse.current = { main: outOfUse, bottom: bottomOutOfUse };
      const mainLeft = outOfUse && !was.main;
      const bottomLeft = bottomOutOfUse && !was.bottom;
      if (!mainLeft && !bottomLeft) return;
      const focused = document.activeElement;
      const lost =
        !focused ||
        focused === document.body ||
        (mainLeft && !!mainElement.current?.contains(focused)) ||
        (bottomLeft && !!bottomElement.current?.contains(focused));
      if (lost) sideElement.current?.focus({ preventScroll: true });
    }, [outOfUse, bottomOutOfUse]);

    // The drawer slides in over main when it appears, and out when it closes. A slide cut short is
    // cancelled, not stopped: stopping writes its last value to the side on motion's next frame.
    const wasPresentation = useRef(presentation);
    useLayoutEffect(() => {
      const was = wasPresentation.current;
      wasPresentation.current = presentation;
      const element = sideElement.current;
      if (!element || reduce || presentation !== 'drawer') return;
      if (was !== 'closed' && was !== 'withdrawn') return;
      element.style.transform = SLIDE_OUT;
      const controls = animate(element, { transform: [SLIDE_OUT, SLIDE_IN] }, spring.moderate);
      controls.then(() => {
        element.style.transform = '';
      });
      return () => {
        controls.cancel();
        element.style.transform = '';
      };
    }, [presentation, reduce]);

    useEffect(() => {
      if (!leaving) return;
      const element = sideElement.current;
      const done = () => setLeaving(false);
      // A throttled background tab may never finish the animation.
      const fallback = setTimeout(done, exitFallbackMs(spring.moderate));
      const controls = element
        ? animate(
            element,
            { transform: [SLIDE_IN, SLIDE_OUT] },
            { duration: spring.moderate.exit.duration, ease: tween.moderate.ease },
          )
        : null;
      controls?.then(done);
      return () => {
        clearTimeout(fallback);
        controls?.cancel();
        if (element) element.style.transform = '';
      };
    }, [leaving]);

    const escapeHandler = useRef(onEscape);
    escapeHandler.current = onEscape;
    // On window, in the bubble phase: a popup over the drawer dismisses from its own document
    // listener first and marks the event handled.
    useEffect(() => {
      if (!drawer) return;
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (event.isComposing || event.keyCode === 229) return;
        if (!escapeHandler.current) return;
        event.preventDefault();
        escapeHandler.current(event);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [drawer]);

    const scrim =
      drawer || leaving ? (
        // A press here closes the drawer; it never takes the focus from where it is. While it
        // fades away, presses go through to main.
        <motion.div
          data-slot="side-panel-scrim"
          aria-hidden="true"
          className="absolute inset-0 z-20 bg-(--dialog-scrim)"
          style={{ pointerEvents: drawer ? 'auto' : 'none' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: drawer ? 1 : 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : drawer
                ? tween.moderate
                : { ...tween.moderate, ...tween.moderate.exit }
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (drawer) onScrimPress?.();
          }}
        />
      ) : null;

    return (
      <div
        ref={(node) => {
          rootRef.current = node;
          assign(ref, node);
        }}
        data-slot="side-panel-frame"
        data-presentation={presentation}
        data-resizing={resizing ? '' : undefined}
        // Clipped, not a scroll container: a focus inside a drawer still sliding in must not
        // scroll the frame sideways. Isolated, so its layers stay below the app shell's.
        className={cn(
          'relative isolate flex h-full min-h-0 min-w-0 flex-col overflow-clip',
          className,
        )}
        {...props}
      >
        {/* With a bottom, the scrim lies over main and the bottom alike, under the drawer. */}
        {hasBottom ? scrim : null}
        <div
          data-slot="side-panel-row"
          // Maximized, the side covers this row only; a drawer is placed against the frame, so it
          // covers the bottom too.
          className={cn('flex min-h-0 min-w-0 flex-1', presentation === 'maximized' && 'relative')}
        >
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              ref={(node) => {
                mainElement.current = node;
                assign(mainRef, node);
              }}
              data-slot="side-panel-main"
              inert={outOfUse}
              // Hidden, not removed, so a maximized panel keeps main's scroll and drafts.
              style={presentation === 'maximized' ? { visibility: 'hidden' } : undefined}
              // Its own stacking context, so nothing raised inside it paints over the scrim.
              className={cn('isolate flex min-h-0 min-w-0 flex-1 flex-col', mainClassName)}
            >
              {main}
            </div>
            {hasBottom ? null : scrim}
          </div>
          {presentation === 'beside' && resize ? (
            <Splitter
              {...resize}
              value={sideWidth}
              side="right"
              onDragChange={(dragging) => {
                setResizing(dragging);
                resize.onDragChange?.(dragging);
              }}
            />
          ) : null}
          {sideMounted ? (
            <section
              ref={(node) => {
                sideElement.current = node;
                assign(sideRef, node);
              }}
              aria-label={sideLabel}
              data-slot="side-panel-side"
              data-presentation={leaving ? 'leaving' : presentation}
              data-full={overlay && drawerFull ? '' : undefined}
              // Focus lands on the region itself when main gives it up.
              tabIndex={-1}
              inert={!shown}
              aria-hidden={leaving ? true : undefined}
              // Off screen it keeps its width and paints nothing, whatever visibility its content
              // sets.
              style={{
                width: presentation === 'maximized' ? undefined : overlay ? drawerWidth : sideWidth,
                maxWidth: overlay ? '100%' : undefined,
                visibility: shown || leaving ? undefined : 'hidden',
                opacity: shown || leaving ? undefined : 0,
              }}
              className={cn(
                'flex min-h-0 min-w-0 flex-col bg-background outline-none',
                presentation === 'beside' && 'relative shrink-0',
                overlay && 'absolute inset-y-0 right-0 z-30 shadow-surface-4',
                // The drawer's edge is its first pixel, where the splitter's line falls beside.
                overlay && !drawerFull && 'border-l border-border',
                presentation === 'maximized' && 'absolute inset-0 z-20',
                !shown && !leaving && 'pointer-events-none absolute inset-y-0 right-0',
                sideClassName,
              )}
            >
              {side}
            </section>
          ) : null}
        </div>
        {hasBottom ? (
          <div
            ref={bottomElement}
            data-slot="side-panel-bottom-area"
            // Under a drawer it is out of use, as main is.
            inert={bottomOutOfUse}
            // Its own stacking context, so nothing raised inside it paints over the scrim.
            className="isolate flex shrink-0 flex-col"
          >
            {bottomShown && bottomResize ? (
              <Splitter
                {...bottomResize}
                orientation="horizontal"
                side="bottom"
                value={shownBottom}
                max={Math.min(bottomResize.max, room)}
                onDragChange={(dragging) => {
                  setResizing(dragging);
                  bottomResize.onDragChange?.(dragging);
                }}
              />
            ) : null}
            <section
              ref={(node) => assign(bottomRef, node)}
              aria-label={bottomLabel}
              data-slot="side-panel-bottom"
              data-state={bottomState}
              inert={!bottomShown}
              // Hidden, it keeps its height out of the flow, so its content keeps its size.
              style={{
                height: bottomShown ? shownBottom : bottomHeight,
                visibility: bottomShown ? undefined : 'hidden',
                opacity: bottomShown ? undefined : 0,
              }}
              className={cn(
                'flex min-h-0 min-w-0 flex-col bg-background',
                !bottomShown && 'pointer-events-none absolute inset-x-0 bottom-0',
                bottomClassName,
              )}
            >
              {bottom}
            </section>
          </div>
        ) : null}
      </div>
    );
  },
);
SidePanelFrame.displayName = 'SidePanelFrame';
