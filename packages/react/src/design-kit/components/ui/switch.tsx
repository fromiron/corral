'use client';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { animate, motion, type Transition, useMotionValue } from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { omit } from '../../lib/omit.ts';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';

// A whole labeled row: a click anywhere toggles, and the thumb can be dragged.
// `checked` is always owned by the parent; the switch only calls onToggle.

interface SwitchProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  checked: boolean;
  /** Called by a click, the keyboard, or a drag released past the
   *  midpoint. Update `checked` here. */
  onToggle: () => void;
  disabled?: boolean;
  /** Overrides the thumb's spring (spring.moderate by default). */
  thumbTransition?: Transition;
  /** Pins the switch to one step of the size ladder.
   *  Omitted, it follows the surrounding SizeProvider. */
  size?: SizeVariant;
}

// Track/thumb geometry per size step.
const METRICS = {
  default: {
    trackWidth: 34,
    trackHeight: 20,
    thumbSize: 16,
    pillExtend: 2,
    pressExtend: 4,
    pressShrink: 4,
  },
  compact: {
    trackWidth: 28,
    trackHeight: 16,
    thumbSize: 12,
    pillExtend: 2,
    pressExtend: 3,
    pressShrink: 3,
  },
} as const;

// Gap between a resting thumb and each track edge (track = thumb + 4).
const THUMB_OFFSET = 2;
// Pointer travel (px) before a press becomes a drag, so a wobbly tap still toggles.
const DRAG_DEAD_ZONE = 2;

const Switch = forwardRef<HTMLDivElement, SwitchProps>(
  (
    { label, checked, onToggle, disabled = false, thumbTransition, size, className, ...props },
    ref,
  ) => {
    const labelId = useId();
    const hasMounted = useRef(false);
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    const sizeClasses = useSize(size);
    const m = METRICS[sizeClasses.variant];
    const thumbTravel = m.trackWidth - m.thumbSize - THUMB_OFFSET * 2;

    const dragging = useRef(false);
    // Outlives the pointerup by one frame so the click fired by the same
    // release can be swallowed.
    const didDrag = useRef(false);
    // Non-null only while a press is in progress.
    const pointerStart = useRef<{
      clientX: number;
      originX: number;
    } | null>(null);

    // A motion value so drags write it without re-rendering. Starts at the
    // resting spot for `checked`, so a switch that mounts on doesn't slide.
    const motionX = useMotionValue(checked ? THUMB_OFFSET + thumbTravel : THUMB_OFFSET);

    useEffect(() => {
      hasMounted.current = true;
    }, []);

    // Press wins over hover. On press y moves down by half the shrink, so the
    // thumb squashes toward its own center line.
    const thumbWidth = pressed
      ? m.thumbSize + m.pressExtend
      : hovered
        ? m.thumbSize + m.pillExtend
        : m.thumbSize;
    const thumbHeight = pressed ? m.thumbSize - m.pressShrink : m.thumbSize;
    const thumbY = pressed ? THUMB_OFFSET + m.pressShrink / 2 : THUMB_OFFSET;
    // When checked, extra width grows leftward so the outer edge stays pinned
    // to the track end.
    const extraWidth = thumbWidth - m.thumbSize;
    const thumbX = checked ? THUMB_OFFSET + thumbTravel - extraWidth : THUMB_OFFSET;

    // Mid-drag the pointer owns x, so this stands down.
    useEffect(() => {
      if (dragging.current) return;
      if (!hasMounted.current) {
        motionX.set(thumbX);
      } else {
        animate(motionX, thumbX, thumbTransition ?? spring.moderate);
      }
    }, [thumbX, motionX, thumbTransition]);

    // --- Pointer handlers ---

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        setPressed(true);
        dragging.current = false;
        didDrag.current = false;
        pointerStart.current = {
          clientX: e.clientX,
          // Current x, even mid-spring, so the first drag frame doesn't jump.
          originX: motionX.get(),
        };
        // Lets a drag overshoot the row and still release.
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      },
      [disabled, motionX],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!pointerStart.current) return;
        const delta = e.clientX - pointerStart.current.clientX;

        if (!dragging.current) {
          if (Math.abs(delta) < DRAG_DEAD_ZONE) return;
          dragging.current = true;
        }

        // Clamp with the pressed width: the thumb stays stretched all drag.
        const dragMin = THUMB_OFFSET;
        const pressedThumbWidth = m.thumbSize + m.pressExtend;
        const dragMax = m.trackWidth - THUMB_OFFSET - pressedThumbWidth;
        const rawX = pointerStart.current.originX + delta;
        motionX.set(Math.max(dragMin, Math.min(dragMax, rawX)));
      },
      [motionX, m],
    );

    const handlePointerUp = useCallback(() => {
      if (!pointerStart.current) return;
      setPressed(false);

      if (dragging.current) {
        // The release still fires a click; both click paths check didDrag
        // so a drag never toggles twice.
        didDrag.current = true;
        dragging.current = false;

        const currentX = motionX.get();
        const dragMin = THUMB_OFFSET;
        const pressedThumbWidth = m.thumbSize + m.pressExtend;
        const dragMax = m.trackWidth - THUMB_OFFSET - pressedThumbWidth;
        const midpoint = (dragMin + dragMax) / 2;

        const shouldBeOn = currentX > midpoint;

        // A toggle moves thumbX and the sync effect springs from here; on
        // the same side thumbX may not change, so spring home explicitly.
        if (shouldBeOn !== checked) {
          onToggle();
        } else {
          const snapTarget = checked ? THUMB_OFFSET + thumbTravel : THUMB_OFFSET;
          animate(motionX, snapTarget, thumbTransition ?? spring.moderate);
        }

        requestAnimationFrame(() => {
          didDrag.current = false;
        });
      }

      pointerStart.current = null;
    }, [checked, onToggle, motionX, thumbTransition, m, thumbTravel]);

    const handlePointerCancel = useCallback(() => {
      if (!pointerStart.current) return;
      setPressed(false);

      if (dragging.current) {
        dragging.current = false;
        // Gesture cancelled by the system: snap back without toggling
        const snapTarget = checked ? THUMB_OFFSET + thumbTravel : THUMB_OFFSET;
        animate(motionX, snapTarget, thumbTransition ?? spring.moderate);
      }

      pointerStart.current = null;
    }, [checked, motionX, thumbTransition, thumbTravel]);

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: The row extends the hit target; the Base UI switch owns semantics and keyboard interaction.
      // biome-ignore lint/a11y/useKeyWithClickEvents: The inner Base UI switch supplies the keyboard toggle path.
      <div
        ref={ref}
        className={cn(
          // touch-none stops the browser claiming a horizontal drag as a
          // scroll (which would cancel it).
          'relative z-10 flex items-center cursor-pointer select-none touch-none',
          sizeClasses.gap,
          sizeClasses.px,
          sizeClasses.variant === 'compact' ? 'py-1' : 'py-2',
          disabled && 'opacity-50 pointer-events-none',
          className,
        )}
        // Hover is mouse-only; on touch the thumb only takes the press shape.
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={() => {
          if (disabled || didDrag.current) return;
          onToggle();
        }}
        {...props}
      >
        <SwitchPrimitive.Root
          checked={checked}
          aria-labelledby={labelId}
          onCheckedChange={() => {
            if (didDrag.current) return;
            onToggle();
          }}
          disabled={disabled}
          tabIndex={0}
          className={cn(
            'relative shrink-0 rounded-full outline-none cursor-pointer',
            'transition-colors duration-80',
            'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
          style={{
            width: m.trackWidth,
            height: m.trackHeight,
            // Off-state hover mixes in 10% of the overlay color (darker in
            // light mode, lighter in dark).
            backgroundColor: checked
              ? hovered
                ? '#5C89F2'
                : '#6B97FF'
              : hovered
                ? 'color-mix(in oklab, var(--accent), rgb(var(--overlay)) 10%)'
                : 'var(--accent)',
          }}
          // The primitive toggles via onCheckedChange; stop the click so the
          // row's onClick doesn't toggle a second time.
          onClick={(e) => e.stopPropagation()}
        >
          <SwitchPrimitive.Thumb
            // Motion claims onDrag* and onAnimation* for its own callbacks, so
            // the DOM handlers are dropped before spreading onto motion.span.
            render={(props) => {
              const { style: baseStyle, ...baseProps } =
                props as React.HTMLAttributes<HTMLSpanElement>;
              const rest = omit(baseProps, [
                'onDrag',
                'onDragStart',
                'onDragEnd',
                'onAnimationStart',
                'onAnimationEnd',
                'onAnimationIteration',
              ]);
              return (
                <motion.span
                  {...rest}
                  // Placed only by the x/y transforms.
                  className="absolute top-0 left-0 block rounded-full bg-white shadow-sm"
                  initial={false}
                  style={{
                    ...(baseStyle as React.CSSProperties | undefined),
                    x: motionX,
                  }}
                  animate={{
                    y: thumbY,
                    width: thumbWidth,
                    height: thumbHeight,
                  }}
                  // No animation on the first render; afterwards shape changes
                  // share x's spring.
                  transition={
                    hasMounted.current ? (thumbTransition ?? spring.moderate) : { duration: 0 }
                  }
                />
              );
            }}
          />
        </SwitchPrimitive.Root>

        <span
          id={labelId}
          className={cn(
            // text-box trim recenters the letterforms against the track.
            '[text-box:trim-both_cap_alphabetic] transition-[color] duration-80',
            sizeClasses.text,
            checked ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
      </div>
    );
  },
);

Switch.displayName = 'Switch';

export type { SwitchProps };
export { Switch };
