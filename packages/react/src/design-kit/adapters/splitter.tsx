'use client';

import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from './utils.ts';

// -----------------------------------------------------------------------------
// A separator between two regions that resizes the panel on one side of it:
// vertical (a side panel's width) or horizontal (a bottom dock's height). The
// supplied kit resizes only its sidebar, with SidebarRail, whose press also
// collapses the sidebar; this keeps the rail's 8px hit strip, 16px key step,
// pointer capture and hover line, and leaves out the collapse click and its
// tooltip. The size is the host's: the splitter reports each change, when a
// drag starts and ends, and the size at the end of each drag or key press. A
// double press resets it when the host asks.
//
// The line is the panel's first pixel, where a drawer's edge also falls, and
// the hit strip lies over the panel, clear of the other region's scrollbar.
// -----------------------------------------------------------------------------

/** One arrow press, as SidebarRail steps. */
const STEP = 16;

export interface SplitterBaseProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'children' | 'aria-label'> {
  /** The panel's size in px: its width, or its height when horizontal. */
  value: number;
  min: number;
  /** Below `min`, `min` stands for both. */
  max: number;
  /** Each new size during a drag or a key press, already within the bounds. */
  onChange: (px: number) => void;
  /** The size at the end of a drag (however it ends) or when a held arrow key is let go. */
  onCommit?: (px: number) => void;
  /** A double press: the host puts its size back (to its default, say). Without it a double
   *  press does nothing. */
  onReset?: () => void;
  /** A drag starts (true) or ends (false): a host may switch off pointer events on a native
   *  view the pointer would cross. */
  onDragChange?: (dragging: boolean) => void;
  'aria-label': string;
}

export type SplitterProps = SplitterBaseProps &
  (
    | {
        orientation?: 'vertical';
        /** Which side of the splitter the panel is on: the arrows and the drag follow it. */
        side?: 'left' | 'right';
      }
    | {
        /** Between a region and a panel above or below it: ArrowUp and ArrowDown, along y. */
        orientation: 'horizontal';
        side?: 'top' | 'bottom';
      }
  );

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

interface Drag {
  pointerId: number;
  start: number;
  startValue: number;
  last: number;
  moved: boolean;
}

export const Splitter = forwardRef<HTMLDivElement, SplitterProps>(
  (
    {
      value,
      min,
      max: maxProp,
      orientation = 'vertical',
      side: sideProp,
      onChange,
      onCommit,
      onReset,
      onDragChange,
      className,
      onKeyDown,
      onKeyUp,
      onBlur,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onDoubleClick,
      ...props
    },
    ref,
  ) => {
    const horizontal = orientation === 'horizontal';
    const side = sideProp ?? (horizontal ? 'bottom' : 'right');
    // The arrow that moves the line toward the far end of the axis, and the one back.
    const [back, forth] = horizontal ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const max = Math.max(min, maxProp);
    const drag = useRef<Drag | null>(null);
    // The width a key press last set, committed when that key is let go.
    const keyed = useRef<number | null>(null);
    const [dragging, setDragging] = useState(false);
    // A panel after the line (right, below) grows as the line moves back.
    const direction = side === 'right' || side === 'bottom' ? -1 : 1;
    const along = (event: { clientX: number; clientY: number }) =>
      horizontal ? event.clientY : event.clientX;
    const latest = useRef({ onCommit, onDragChange });
    latest.current = { onCommit, onDragChange };

    const endDrag = (target: HTMLElement | null) => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      if (target?.hasPointerCapture?.(current.pointerId)) {
        target.releasePointerCapture(current.pointerId);
      }
      if (!current.moved) return;
      setDragging(false);
      onDragChange?.(false);
      onCommit?.(current.last);
    };

    // A drag cut short by unmounting still leaves the width where it was dragged.
    useEffect(
      () => () => {
        const current = drag.current;
        drag.current = null;
        if (!current?.moved) return;
        latest.current.onDragChange?.(false);
        latest.current.onCommit?.(current.last);
      },
      [],
    );

    return (
      // biome-ignore lint/a11y/useSemanticElements: A focusable splitter is a separator widget; <hr> takes no focus or value.
      <div
        ref={ref}
        role="separator"
        aria-orientation={orientation}
        aria-valuenow={clamp(value, min, max)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        data-slot="splitter"
        data-side={side}
        data-orientation={orientation}
        data-dragging={dragging ? '' : undefined}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key !== back && event.key !== forth) return;
          event.preventDefault();
          const toward = event.key === forth ? 1 : -1;
          const next = clamp(Math.round(value + STEP * toward * direction), min, max);
          // A press at a bound changes nothing, so it has nothing to commit.
          if (next === value) return;
          onChange(next);
          keyed.current = next;
        }}
        onKeyUp={(event: KeyboardEvent<HTMLDivElement>) => {
          onKeyUp?.(event);
          if (event.key !== back && event.key !== forth) return;
          const committed = keyed.current;
          keyed.current = null;
          if (committed !== null) onCommit?.(committed);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          // Focus left mid-press: the key's release goes elsewhere, so commit now.
          const committed = keyed.current;
          keyed.current = null;
          if (committed !== null) onCommit?.(committed);
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (event.defaultPrevented || event.button !== 0) return;
          drag.current = {
            pointerId: event.pointerId,
            start: along(event),
            startValue: clamp(value, min, max),
            last: clamp(value, min, max),
            moved: false,
          };
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // A pointer that is no longer active (a synthetic one) cannot be captured.
          }
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          onPointerMove?.(event);
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          // The release went somewhere this never heard of (outside the window).
          if (event.buttons === 0) {
            endDrag(event.currentTarget);
            return;
          }
          const dx = along(event) - current.start;
          if (dx === 0 && !current.moved) return;
          if (!current.moved) {
            current.moved = true;
            setDragging(true);
            onDragChange?.(true);
          }
          const next = clamp(Math.round(current.startValue + dx * direction), min, max);
          if (next === current.last) return;
          current.last = next;
          onChange(next);
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          if (drag.current?.pointerId === event.pointerId) endDrag(event.currentTarget);
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event);
          if (drag.current?.pointerId === event.pointerId) endDrag(event.currentTarget);
        }}
        onLostPointerCapture={(event) => {
          onLostPointerCapture?.(event);
          if (drag.current?.pointerId === event.pointerId) endDrag(null);
        }}
        onDoubleClick={(event) => {
          onDoubleClick?.(event);
          if (!event.defaultPrevented) onReset?.();
        }}
        className={cn(
          // An 8px strip over the panel's first 8px. touch-none: without it the browser claims a
          // touch drag for scrolling and cancels the resize mid-gesture.
          'relative z-10 shrink-0 touch-none select-none outline-none',
          horizontal ? 'h-2 cursor-row-resize' : 'w-2 cursor-col-resize',
          { right: '-mr-2', left: '-ml-2', bottom: '-mb-2', top: '-mt-2' }[side],
          // The line is the panel's first pixel. Keyboard focus draws it 2px in the focus colour;
          // forced colours keep an outline.
          'after:pointer-events-none after:absolute after:bg-border after:transition-colors after:duration-80',
          horizontal ? 'after:inset-x-0 after:h-px' : 'after:inset-y-0 after:w-px',
          {
            right: 'after:left-0',
            left: 'after:right-0',
            bottom: 'after:top-0',
            top: 'after:bottom-0',
          }[side],
          'hover:after:bg-foreground/25 data-[dragging]:after:bg-foreground/25',
          horizontal ? 'focus-visible:after:h-0.5' : 'focus-visible:after:w-0.5',
          'focus-visible:after:bg-[color:var(--focus-ring)]',
          'forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-solid forced-colors:focus-visible:-outline-offset-2',
          className,
        )}
        {...props}
      />
    );
  },
);
Splitter.displayName = 'Splitter';
