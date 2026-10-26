// biome-ignore-all lint/a11y/noStaticElementInteractions: The supplied kit's pointer layer delegates semantics and keyboard input to SliderPrimitive.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: SliderPrimitive supplies the equivalent keyboard value controls.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: Preserve the supplied kit's spring synchronization and timing.
'use client';

import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import {
  AnimatePresence,
  animate,
  type MotionValue,
  motion,
  useMotionValue,
  useTransform,
} from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fontWeights } from '../../lib/font-weight';
import { omit } from '../../lib/omit';
import { useShape } from '../../lib/shape-context';
import { fieldTouchClass, type SizeVariant, useSizeVariant } from '../../lib/size-context';
import { spring } from '../../lib/springs';
import { cn } from '../../lib/utils';

// ---------------------------------------------------------------------------
// Two engines picked by size: ComfortableSlider (default step) and
// CompactSlider (compact step). Both draw motion values over an invisible
// primitive that supplies ARIA and arrow keys; pointer input never reaches it,
// so presses can spring instead of jump.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SliderValue = number | [number, number];
type SliderValues = [number] | [number, number];
type StepValues = [number, number, ...number[]];
type ValuePosition = 'left' | 'right' | 'top' | 'bottom' | 'tooltip';

/** Props of the compact engine — the feature-rich design (ranges, discrete
 *  step lists, value display) that renders the ladder's compact step. The
 *  public <Slider> accepts these plus `variant` and `size`. */
interface SliderEngineProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value: SliderValue;
  onChange: (value: SliderValue) => void;
  min?: number;
  max?: number;
  step?: number;
  /**
   * Discrete list of allowed values, e.g. [0.1, 0.5, 0.7, 1.1, 1.3].
   *
   * When set, the thumb snaps only to these values (positioned proportionally
   * along the track) and arrow keys walk the list. `min`/`max` derive from the
   * list's extremes and `step` is ignored.
   */
  steps?: number[];
  showSteps?: boolean;
  showValue?: boolean;
  /** "tooltip" shows a bubble above each thumb only while hovered or
   *  pressed; the other positions place a click-to-edit label on that side
   *  of the track. */
  valuePosition?: ValuePosition;
  /** Formats every displayed value (labels and tooltips) and, with `steps`,
   *  the thumbs' aria-valuetext. */
  formatValue?: (v: number) => string;
  /** The thumb's accessible name, also shown as text (the value label's
   *  prefix, or the row's leading label at the default size). Range thumbs
   *  get "<label> minimum" / "<label> maximum". */
  label?: string;
  disabled?: boolean;
  trackClassName?: string;
  trackStyle?: CSSProperties;
  fillClassName?: string;
  fillStyle?: CSSProperties;
  hideFill?: boolean;
  thumbColor?: string;
  thumbBorderColor?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The thumb's layout box. Travel is the track width minus this, so the thumb
// never overhangs either end; the visible knob is THUMB_SIZE_REST inside it.
const THUMB_SIZE = 20;
const THUMB_SIZE_REST = 16;
// Leaves 1px above and below the 16px knob.
const TRACK_BG_HEIGHT = 18;
const DOT_SIZE = 4;
const PIP_SIZE = 5;
// Inset track BG so its rounded-end centers align with thumb centers at min/max
const TRACK_INSET = (THUMB_SIZE - TRACK_BG_HEIGHT) / 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Value → the thumb's left offset in layout px.
function valueToPixel(v: number, min: number, max: number, trackWidth: number): number {
  if (max === min) return 0;
  const usable = trackWidth - THUMB_SIZE;
  return ((v - min) / (max - min)) * usable;
}

// Strict `<`: a value exactly halfway between two entries snaps to the lower.
function nearestStepIndex(v: number, steps: number[]): number {
  let idx = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs((steps[i] as number) - v) < Math.abs((steps[idx] as number) - v)) idx = i;
  }
  return idx;
}

// Inverse of valueToPixel with snapping built in, so a thumb at rest always
// sits on a value the slider can emit.
function pixelToValue(
  px: number,
  min: number,
  max: number,
  step: number,
  trackWidth: number,
  stepValues: StepValues | null = null,
): number {
  const usable = trackWidth - THUMB_SIZE;
  if (usable <= 0) return min;
  const raw = (px / usable) * (max - min) + min;
  if (stepValues) return stepValues[nearestStepIndex(raw, stepValues)] as number;
  const snapped = Math.round((raw - min) / step) * step + min;
  return Math.max(min, Math.min(max, snapped));
}

function toRadixValue(value: SliderValue): SliderValues {
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// ValueDisplay (internal)
// ---------------------------------------------------------------------------

interface ValueDisplayProps {
  values: SliderValues;
  editingIndex: number | null;
  onStartEdit: (index: number) => void;
  onCommitEdit: (index: number, v: number) => void;
  onCancelEdit: () => void;
  min: number;
  max: number;
  step: number;
  stepValues: StepValues | null;
  formatValue: (v: number) => string;
  label?: string;
  isRange: boolean;
  isInteracting: boolean;
}

// Click-to-edit value label: a pointer shortcut; keyboards use arrow keys.
function ValueDisplay({
  values,
  editingIndex,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  min,
  max,
  step,
  stepValues,
  formatValue,
  label,
  isRange,
  isInteracting,
}: ValueDisplayProps) {
  const shape = useShape();
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Seed with the raw number (a formatted "50%" never has to be parsed back),
  // only when an edit starts, so mid-edit value updates don't clobber typing.
  const [seededIndex, setSeededIndex] = useState<number | null>(null);
  if (seededIndex !== editingIndex) {
    setSeededIndex(editingIndex);
    if (editingIndex !== null) setInputValue(String(values[editingIndex]));
  }
  useEffect(() => {
    if (editingIndex === null) return;
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [editingIndex]);

  const commitEdit = useCallback(
    (index: number) => {
      const parsed = parseFloat(inputValue);
      if (!isNaN(parsed)) {
        const clamped = Math.max(min, Math.min(max, parsed));
        const snapped = stepValues
          ? (stepValues[nearestStepIndex(clamped, stepValues)] as number)
          : Math.round((clamped - min) / step) * step + min;
        onCommitEdit(index, snapped);
      } else {
        onCancelEdit();
      }
    },
    [inputValue, min, max, step, stepValues, onCommitEdit, onCancelEdit],
  );

  const renderValue = (index: number) => {
    if (editingIndex === index) {
      return (
        <span className="inline-grid text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)]">
          {/* Ghost for layout stability — widest possible value */}
          <span
            className="col-start-1 row-start-1 invisible"
            style={{ fontVariationSettings: fontWeights.normal }}
            aria-hidden="true"
          >
            {label ? `${label}: ` : ''}
            {formatValue(max)}
          </span>
          <span className="col-start-1 row-start-1 flex items-center gap-1">
            {label && <span className="text-muted-foreground">{label}:</span>}
            {/* 5ch in this slot's font, not the input's, so the 16px touch
                font doesn't widen it and shift the track. */}
            <span className="inline-flex w-[5ch] shrink-0">
              {/* List values sit off any grid, so the input takes step="any"
                  and commitEdit snaps to the list instead. */}
              <input
                ref={inputRef}
                type="number"
                value={inputValue}
                min={min}
                max={max}
                step={stepValues ? 'any' : step}
                onChange={(e) => setInputValue(e.target.value)}
                onBlur={() => commitEdit(index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit(index);
                  if (e.key === 'Escape') onCancelEdit();
                }}
                aria-label={`Edit slider value${isRange ? (index === 0 ? ' (start)' : ' (end)') : ''}`}
                className={cn(
                  'w-full min-w-0 bg-transparent text-foreground outline-none border-b border-border text-center',
                  fieldTouchClass,
                  shape.input,
                )}
                style={{ fontVariationSettings: fontWeights.normal }}
              />
            </span>
          </span>
        </span>
      );
    }

    return (
      <span className="cursor-text select-none" onClick={() => onStartEdit(index)}>
        {formatValue(values[index] as number)}
      </span>
    );
  };

  // Assumes formatValue(max) is the longest string.
  const widestValue = isRange
    ? `${label ? `${label}: ` : ''}${formatValue(max)} — ${formatValue(max)}`
    : `${label ? `${label}: ` : ''}${formatValue(max)}`;

  // Weight signals interaction; tabular-nums plus a semibold ghost keep the
  // box from changing width.
  return (
    <span
      className={cn(
        'inline-grid shrink-0 text-[length:var(--fs-body,13px)] leading-none text-muted-foreground transition-[font-variation-settings] duration-100',
        'tabular-nums',
      )}
      style={{
        fontVariationSettings: isInteracting ? fontWeights.semibold : fontWeights.normal,
      }}
    >
      {/* Invisible ghost — reserves width of widest possible value */}
      <span
        className="col-start-1 row-start-1 invisible whitespace-nowrap"
        style={{ fontVariationSettings: fontWeights.semibold }}
        aria-hidden="true"
      >
        {widestValue}
      </span>
      <span className="col-start-1 row-start-1 whitespace-nowrap">
        {/* While editing, the edit slot draws its own label beside the input. */}
        {label && editingIndex === null && <span className="text-muted-foreground">{label}: </span>}
        {isRange ? (
          <>
            {renderValue(0)}
            <span className="mx-1 text-muted-foreground">—</span>
            {renderValue(1)}
          </>
        ) : (
          renderValue(0)
        )}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// TooltipValue (internal)
// ---------------------------------------------------------------------------

interface TooltipValueProps {
  value: number;
  formatValue: (v: number) => string;
  motionX: MotionValue<number>;
}

// Bubble for valuePosition="tooltip", following the thumb's motion value.
function TooltipValue({ value, formatValue, motionX }: TooltipValueProps) {
  const shape = useShape();
  const tooltipX = useTransform(motionX, (x) => x + THUMB_SIZE / 2);
  return (
    <motion.div
      className="absolute -translate-x-1/2 pointer-events-none z-20"
      style={{
        x: tooltipX,
        top: -16,
      }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4, transition: spring.fast.exit }}
      transition={spring.fast}
    >
      <span
        className={cn(
          'text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] text-background tabular-nums whitespace-nowrap bg-foreground px-2 py-1',
          shape.bg,
        )}
        style={{ fontVariationSettings: fontWeights.normal }}
      >
        {formatValue(value)}
      </span>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// CompactSlider — the compact-step design.
// ---------------------------------------------------------------------------

const CompactSlider = forwardRef<HTMLDivElement, SliderEngineProps>(
  (
    {
      value,
      onChange,
      min: minProp = 0,
      max: maxProp = 100,
      step = 1,
      steps,
      showSteps = false,
      showValue = true,
      valuePosition = 'left',
      formatValue = String,
      label,
      disabled = false,
      trackClassName,
      trackStyle,
      fillClassName,
      fillStyle,
      hideFill = false,
      thumbColor,
      thumbBorderColor,
      className,
      ...props
    },
    ref,
  ) => {
    const isRange = Array.isArray(value);
    const values = toRadixValue(value);
    const shape = useShape();

    // Keyed on the joined string so inline array literals don't recompute.
    const stepsKey = steps ? steps.join(',') : '';
    const stepValues = useMemo(() => {
      if (!stepsKey) return null;
      const parsed = Array.from(new Set(stepsKey.split(',').map(Number))).sort((a, b) => a - b);
      // A single entry can't span a track; fall back to min/max/step.
      return parsed.length > 1 ? (parsed as StepValues) : null;
    }, [stepsKey]);
    const min = stepValues ? stepValues[0] : minProp;
    const max = stepValues ? (stepValues[stepValues.length - 1] as number) : maxProp;

    // --- Refs ---
    const trackRef = useRef<HTMLDivElement>(null);
    // Layout width, unaffected by ancestor CSS transforms.
    const trackWidthRef = useRef(0);
    // True while a pointer drag owns the thumbs; sync effects stand down.
    const dragging = useRef(false);
    const activeDragThumb = useRef<number>(0);
    // Latest props for the ResizeObserver callback, which subscribes once per
    // isRange and would otherwise read stale values.
    const valuesRef = useRef(values);
    const minRef = useRef(min);
    const maxRef = useRef(max);
    useLayoutEffect(() => {
      valuesRef.current = values;
      minRef.current = min;
      maxRef.current = max;
    });

    // --- State ---
    const [isHovered, setIsHovered] = useState(false);
    const [isPressed, setIsPressed] = useState(false);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [hoverPreview, setHoverPreview] = useState<{
      left: number;
      width: number;
      snappedValue: number;
      cursorX: number;
    } | null>(null);
    const [focusedThumb, setFocusedThumb] = useState<number | null>(null);
    // Only the tooltip waits 100ms into a hover, so sweeping the cursor
    // across the slider doesn't flash it.
    const [hoverDelayDone, setHoverDelayDone] = useState(false);

    if (!isHovered && hoverDelayDone) setHoverDelayDone(false);
    useEffect(() => {
      if (!isHovered) return;
      const id = setTimeout(() => setHoverDelayDone(true), 100);
      return () => clearTimeout(id);
    }, [isHovered]);
    const showHoverTooltip = isHovered && hoverDelayDone;

    // --- Motion values ---
    // Each thumb's left offset in layout px; every layer derives from these.
    const motionX0 = useMotionValue(0);
    const motionX1 = useMotionValue(0);

    // --- Derived motion values for fill ---
    // Single: pill start → thumb center. Range: center → center.
    // `- TRACK_INSET` converts to the inset pill's own px.
    const fillLeft = useTransform(motionX0, (x) =>
      isRange ? x + THUMB_SIZE / 2 - TRACK_INSET : 0,
    );
    const fillWidthSingle = useTransform(motionX0, (x) => x + THUMB_SIZE / 2 - TRACK_INSET);
    const fillWidthRange = useTransform(
      [motionX0, motionX1] as MotionValue<number>[],
      ([x0, x1]) => (x1 as number) - (x0 as number),
    );
    const fillWidth = isRange ? fillWidthRange : fillWidthSingle;

    // --- Step dots mask (hides dots on the filled side) ---
    // A 2px feather at each thumb center instead of a hard clip.
    const stepDotsMaskSingle = useTransform(motionX0, (x) => {
      const edge = x + THUMB_SIZE / 2;
      return `linear-gradient(to right, transparent ${edge}px, black ${edge + 2}px)`;
    });
    const stepDotsMaskRange = useTransform(
      [motionX0, motionX1] as MotionValue<number>[],
      ([x0, x1]) => {
        const left = (x0 as number) + THUMB_SIZE / 2;
        const right = (x1 as number) + THUMB_SIZE / 2;
        return `linear-gradient(to right, black ${left - 2}px, transparent ${left}px, transparent ${right}px, black ${right + 2}px)`;
      },
    );
    const stepDotsMask = isRange ? stepDotsMaskRange : stepDotsMaskSingle;

    // --- Hover preview computation ---
    // The bar runs from the nearer thumb's center to the snapped hover value.
    const computeHoverPreview = useCallback(
      (cursorX: number, trackWidth: number) => {
        // Everything here is in layout px, unaffected by ancestor transforms.
        const usable = trackWidth - THUMB_SIZE;
        const rawPx = cursorX - THUMB_SIZE / 2;
        const clampedPx = Math.max(0, Math.min(usable, rawPx));
        const rawVal = usable > 0 ? (clampedPx / usable) * (max - min) + min : min;
        const snappedVal = stepValues
          ? (stepValues[nearestStepIndex(rawVal, stepValues)] as number)
          : Math.max(min, Math.min(max, Math.round((rawVal - min) / step) * step + min));
        const snappedPercent = max === min ? 0 : (snappedVal - min) / (max - min);
        const snappedX = THUMB_SIZE / 2 + snappedPercent * usable;

        const c0 = motionX0.get() + THUMB_SIZE / 2;
        const c1 = motionX1.get() + THUMB_SIZE / 2;
        const nearestIdx = isRange
          ? Math.abs(snappedX - c0) <= Math.abs(snappedX - c1)
            ? 0
            : 1
          : 0;
        const nearest = nearestIdx === 0 ? c0 : c1;

        // Extend hover bar to track edges at extremes so there's no gap
        const edgeX = snappedVal === min ? 0 : snappedVal === max ? trackWidth : snappedX;
        const left = Math.min(nearest, edgeX);
        const width = Math.abs(edgeX - nearest);
        // The tooltip anchors to the snapped step, not the raw cursor.
        setHoverPreview({ left, width, snappedValue: snappedVal, cursorX: snappedX });
      },
      [min, max, step, stepValues, isRange, motionX0, motionX1],
    );

    // --- Initial sync (before paint) ---
    // Runs once, unanimated; the track stays hidden until `ready` so thumbs
    // never visibly slide in from 0.
    const initialSyncDone = useRef(false);
    const [ready, setReady] = useState(false);
    useLayoutEffect(() => {
      const el = trackRef.current;
      if (!el || initialSyncDone.current) return;
      const w = el.offsetWidth;
      trackWidthRef.current = w;
      const px0 = valueToPixel(values[0], min, max, w);
      motionX0.set(px0);
      if (isRange && values[1] !== undefined) {
        const px1 = valueToPixel(values[1], min, max, w);
        motionX1.set(px1);
      }
      initialSyncDone.current = true;
      setReady(true);
    }, [values, min, max, isRange, motionX0, motionX1]);

    // --- Track width measurement (resize only) ---
    // Thumbs spring to their new spots; skipped mid-drag.
    useEffect(() => {
      const el = trackRef.current;
      if (!el) return;
      const ro = new ResizeObserver(([entry]) => {
        const w = (entry as ResizeObserverEntry).contentRect.width;
        trackWidthRef.current = w;
        if (!dragging.current && initialSyncDone.current) {
          const v = valuesRef.current;
          const mn = minRef.current;
          const mx = maxRef.current;
          const px0 = valueToPixel(v[0], mn, mx, w);
          animate(motionX0, px0, spring.moderate);
          if (isRange && v[1] !== undefined) {
            const px1 = valueToPixel(v[1], mn, mx, w);
            animate(motionX1, px1, spring.moderate);
          }
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [isRange, motionX0, motionX1]);

    // --- Sync motion values on value change (keyboard, programmatic) ---
    // Keyed on a string: `values` is a new array every render, which would
    // restart the spring on unrelated re-renders. Skipped mid-drag.
    const valuesKey = values.join(',');
    useEffect(() => {
      if (!initialSyncDone.current) return;
      if (dragging.current) return;
      const tw = trackWidthRef.current;
      if (tw <= 0) return;
      const v = valuesRef.current;
      const px0 = valueToPixel(v[0], min, max, tw);
      animate(motionX0, px0, spring.moderate);
      if (isRange && v[1] !== undefined) {
        const px1 = valueToPixel(v[1], min, max, tw);
        animate(motionX1, px1, spring.moderate);
      }
    }, [valuesKey, min, max, isRange, motionX0, motionX1]);

    // --- Range crossing prevention ---
    // Each thumb stops half a thumb short of the other, so they never swap.
    const clampForRange = useCallback(
      (px: number, thumbIndex: number): number => {
        if (!isRange) return px;
        if (thumbIndex === 0) {
          return Math.min(px, motionX1.get() - THUMB_SIZE * 0.5);
        } else {
          return Math.max(px, motionX0.get() + THUMB_SIZE * 0.5);
        }
      },
      [isRange, motionX0, motionX1],
    );

    // --- Emit value change ---
    // Range mode replaces only the moving thumb's entry.
    const emitChange = useCallback(
      (thumbIndex: number, newValue: number) => {
        if (isRange) {
          const newValues: [number, number] = [...(values as [number, number])];
          newValues[thumbIndex] = newValue;
          onChange(newValues);
        } else {
          onChange(newValue);
        }
      },
      [isRange, values, onChange],
    );

    // --- Pointer handlers on track ---
    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        // The 8px hit area sits inside the track and both carry these
        // handlers; stopping here keeps one press from running twice.
        e.stopPropagation();

        const trackEl = trackRef.current;
        if (!trackEl) return;
        const trackRect = trackEl.getBoundingClientRect();
        const layoutWidth = trackEl.offsetWidth;
        if (layoutWidth <= 0 || trackRect.width <= 0) return;
        // Normalize to layout px (motionX's space), even under an ancestor scale.
        const scale = trackRect.width / layoutWidth;
        const localX = (e.clientX - trackRect.left) / scale - THUMB_SIZE / 2;
        const clamped = Math.max(0, Math.min(layoutWidth - THUMB_SIZE, localX));

        // The nearer thumb takes the press; a tie goes to the first.
        if (isRange) {
          const dist0 = Math.abs(clamped - motionX0.get());
          const dist1 = Math.abs(clamped - motionX1.get());
          activeDragThumb.current = dist0 <= dist1 ? 0 : 1;
        } else {
          activeDragThumb.current = 0;
        }

        dragging.current = true;
        setIsPressed(true);

        const motionX = activeDragThumb.current === 0 ? motionX0 : motionX1;

        const snappedValue = pixelToValue(clamped, min, max, step, layoutWidth, stepValues);
        const snappedPx = valueToPixel(snappedValue, min, max, layoutWidth);

        const finalPx = clampForRange(snappedPx, activeDragThumb.current);
        animate(motionX, finalPx, spring.moderate);

        // From the clamped pixel, so the value matches where the thumb stopped.
        const finalValue = pixelToValue(finalPx, min, max, step, layoutWidth, stepValues);
        emitChange(activeDragThumb.current, finalValue);

        // Capture keeps the drag alive when the pointer leaves the track.
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      },
      [
        disabled,
        isRange,
        min,
        max,
        step,
        stepValues,
        motionX0,
        motionX1,
        clampForRange,
        emitChange,
      ],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragging.current) return;
        e.stopPropagation();
        const trackEl = trackRef.current;
        if (!trackEl) return;
        const trackRect = trackEl.getBoundingClientRect();
        const layoutWidth = trackEl.offsetWidth;
        if (layoutWidth <= 0 || trackRect.width <= 0) return;
        const scale = trackRect.width / layoutWidth;
        const localX = (e.clientX - trackRect.left) / scale - THUMB_SIZE / 2;
        const clamped = Math.max(0, Math.min(layoutWidth - THUMB_SIZE, localX));

        const motionX = activeDragThumb.current === 0 ? motionX0 : motionX1;

        // Set, not animated, so the thumb stays under the cursor.
        const snappedValue = pixelToValue(clamped, min, max, step, layoutWidth, stepValues);
        const snappedPx = valueToPixel(snappedValue, min, max, layoutWidth);
        const finalPx = clampForRange(snappedPx, activeDragThumb.current);
        motionX.set(finalPx);

        const finalValue = pixelToValue(finalPx, min, max, step, layoutWidth, stepValues);
        emitChange(activeDragThumb.current, finalValue);
      },
      [min, max, step, stepValues, motionX0, motionX1, clampForRange, emitChange],
    );

    const handlePointerUp = useCallback(() => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsPressed(false);
      setHoverPreview(null);

      // Settles a thumb the range clamp left between steps.
      const tw = trackWidthRef.current;
      const motionX = activeDragThumb.current === 0 ? motionX0 : motionX1;
      const currentPx = motionX.get();
      const snapped = pixelToValue(currentPx, min, max, step, tw, stepValues);
      const snappedPx = valueToPixel(snapped, min, max, tw);
      animate(motionX, snappedPx, spring.moderate);
    }, [min, max, step, stepValues, motionX0, motionX1]);

    // --- Base UI keyboard handler ---
    // In steps mode the primitive runs on indices; map them back to values.
    const handleRadixChange = useCallback(
      (newValues: number[]) => {
        if (dragging.current) return;
        const mapped = stepValues
          ? newValues.map((i) => stepValues[Math.round(i)] as number)
          : newValues;
        if (isRange) {
          onChange(mapped as [number, number]);
        } else {
          onChange(mapped[0] as number);
        }
      },
      [isRange, onChange, stepValues],
    );

    // --- Click-to-edit handlers ---
    const handleStartEdit = useCallback((index: number) => {
      setEditingIndex(index);
    }, []);

    const handleCommitEdit = useCallback(
      (index: number, v: number) => {
        emitChange(index, v);
        setEditingIndex(null);
      },
      [emitChange],
    );

    const handleCancelEdit = useCallback(() => {
      setEditingIndex(null);
    }, []);

    // --- Step dots ---
    const stepDots = useMemo(
      () =>
        showSteps
          ? stepValues
            ? stepValues.map((v) => ({
                value: v,
                percent: max === min ? 0 : (v - min) / (max - min),
              }))
            : Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => {
                const v = min + i * step;
                const percent = (v - min) / (max - min);
                return { value: v, percent };
              })
          : [],
      [showSteps, min, max, step, stepValues],
    );

    // --- Interaction state for tooltip ---
    const isInteracting = isHovered || isPressed;

    // --- Per-thumb accessible names ---
    // aria-label on Root lands on a role-less div and never reaches the
    // thumb's input, so each Thumb gets its own label.
    const thumbAriaLabel = (index: number): string | undefined => {
      if (!isRange) return label;
      if (!label) return index === 0 ? 'Minimum' : 'Maximum';
      return index === 0 ? `${label} minimum` : `${label} maximum`;
    };

    // --- Value display component ---
    const valueDisplay = showValue && valuePosition !== 'tooltip' && (
      <ValueDisplay
        values={values}
        editingIndex={editingIndex}
        onStartEdit={handleStartEdit}
        onCommitEdit={handleCommitEdit}
        onCancelEdit={handleCancelEdit}
        min={min}
        max={max}
        step={step}
        stepValues={stepValues}
        formatValue={formatValue}
        label={label}
        isRange={isRange}
        isInteracting={isInteracting}
      />
    );

    // --- Render visual thumb (not the Base UI thumb, purely visual) ---
    // pointer-events-none lets presses fall through to the track handlers.
    const renderVisualThumb = (index: number) => {
      const motionX = index === 0 ? motionX0 : motionX1;
      return (
        <motion.span
          key={`visual-thumb-${index}`}
          className="flex items-center justify-center pointer-events-none"
          style={{
            width: THUMB_SIZE,
            height: THUMB_SIZE,
            marginTop: -THUMB_SIZE / 2,
            x: motionX,
            position: 'absolute',
            top: '50%',
            left: 0,
            zIndex: 10,
          }}
          initial={false}
        >
          <motion.span
            className="block rounded-full"
            initial={false}
            animate={{
              width: THUMB_SIZE_REST,
              height: THUMB_SIZE_REST,
            }}
            transition={spring.fast}
            style={{
              backgroundColor: thumbColor ?? 'white',
              boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
              border: thumbBorderColor ? `1px solid ${thumbBorderColor}` : undefined,
            }}
          />
          {/* Focus ring, only on :focus-visible so a pointer press never shows it. */}
          <motion.span
            className="absolute rounded-full border border-[color:var(--focus-ring,#6B97FF)] pointer-events-none"
            initial={false}
            animate={{
              opacity: focusedThumb === index ? 1 : 0,
              width: THUMB_SIZE + 4,
              height: THUMB_SIZE + 4,
            }}
            transition={spring.fast}
          />
        </motion.span>
      );
    };

    return (
      <div
        ref={ref}
        className={cn(
          // touch-none: a touch drag moves the thumb instead of scrolling.
          'flex flex-col gap-0 w-full select-none touch-none overflow-visible',
          valuePosition === 'left' || valuePosition === 'right'
            ? 'flex-row items-center gap-2 mb-2'
            : 'flex-col',
          disabled && 'opacity-50 pointer-events-none',
          className,
        )}
        {...props}
      >
        {/* Top / Left value */}
        {(valuePosition === 'top' || valuePosition === 'left') && valueDisplay}

        {/* Track area; tooltip mode adds top padding for the bubble. */}
        <div
          className="relative flex-1 overflow-visible"
          style={{
            height:
              valuePosition === 'left' || valuePosition === 'right'
                ? THUMB_SIZE + 16
                : THUMB_SIZE + (valuePosition === 'tooltip' ? 16 : 0),
            paddingTop: valuePosition === 'tooltip' ? 16 : 0,
          }}
          onPointerEnter={() => setIsHovered(true)}
          onPointerLeave={() => {
            setIsHovered(false);
            setHoverPreview(null);
          }}
          onMouseMove={(e) => {
            if (dragging.current) return;
            const trackEl = trackRef.current;
            if (!trackEl) return;
            const trackRect = trackEl.getBoundingClientRect();
            const layoutWidth = trackEl.offsetWidth;
            if (layoutWidth <= 0 || trackRect.width <= 0) return;
            // Normalize to layout px, even under an ancestor CSS scale.
            const scale = trackRect.width / layoutWidth;
            const layoutX = (e.clientX - trackRect.left) / scale;
            const clamped = Math.max(0, Math.min(layoutWidth, layoutX));
            computeHoverPreview(clamped, layoutWidth);
          }}
        >
          {/* Tooltip values */}
          {showValue && valuePosition === 'tooltip' && (
            <AnimatePresence>
              {isInteracting && (
                <TooltipValue
                  key="tooltip-0"
                  value={values[0]}
                  formatValue={formatValue}
                  motionX={motionX0}
                />
              )}
              {isInteracting && isRange && values[1] !== undefined && (
                <TooltipValue
                  key="tooltip-1"
                  value={values[1]}
                  formatValue={formatValue}
                  motionX={motionX1}
                />
              )}
            </AnimatePresence>
          )}

          {/* Invisible Base UI slider for ARIA + keyboard. With `steps` it runs
              on indices, so thumbs announce the real value via aria-valuetext. */}
          <SliderPrimitive.Root
            value={stepValues ? values.map((v) => nearestStepIndex(v, stepValues)) : values}
            onValueChange={(v) => handleRadixChange(v as number[])}
            min={stepValues ? 0 : min}
            max={stepValues ? stepValues.length - 1 : max}
            step={stepValues ? 1 : step}
            disabled={disabled}
            className="absolute inset-0 opacity-0 pointer-events-none"
            style={{ height: THUMB_SIZE }}
          >
            <SliderPrimitive.Control className="w-full h-full">
              <SliderPrimitive.Track className="w-full h-full">
                <SliderPrimitive.Indicator />
              </SliderPrimitive.Track>
              <SliderPrimitive.Thumb
                index={0}
                aria-label={thumbAriaLabel(0)}
                getAriaValueText={stepValues ? () => formatValue(values[0]) : undefined}
                className="block outline-none"
                style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
                onFocus={(e) => {
                  if ((e.currentTarget as HTMLElement).matches(':focus-visible'))
                    setFocusedThumb(0);
                }}
                onBlur={() => setFocusedThumb((prev) => (prev === 0 ? null : prev))}
              />
              {isRange && (
                <SliderPrimitive.Thumb
                  index={1}
                  aria-label={thumbAriaLabel(1)}
                  getAriaValueText={stepValues ? () => formatValue(values[1] as number) : undefined}
                  className="block outline-none"
                  style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
                  onFocus={(e) => {
                    if ((e.currentTarget as HTMLElement).matches(':focus-visible'))
                      setFocusedThumb(1);
                  }}
                  onBlur={() => setFocusedThumb((prev) => (prev === 1 ? null : prev))}
                />
              )}
            </SliderPrimitive.Control>
          </SliderPrimitive.Root>

          {/* Visual track; py-2 makes the press target 36px tall. */}
          <div
            ref={trackRef}
            className="relative w-full cursor-ew-resize py-2"
            style={{ height: THUMB_SIZE + 16, opacity: ready ? 1 : 0 }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {/* Hit area 8px beyond each edge; presses there clamp to min/max. */}
            <div
              className="absolute cursor-ew-resize"
              style={{ left: -8, right: -8, top: 0, bottom: 0 }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
            {/* Hover value tooltip */}
            <AnimatePresence>
              {hoverPreview && showHoverTooltip && !isPressed && valuePosition !== 'tooltip' && (
                <motion.div
                  key="hover-tooltip"
                  className="absolute -translate-x-1/2 pointer-events-none z-20"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4, transition: spring.fast.exit }}
                  transition={spring.fast}
                  style={{
                    left: hoverPreview.cursorX,
                    top: -20,
                  }}
                >
                  <span
                    className={cn(
                      'text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] text-background tabular-nums whitespace-nowrap bg-foreground px-2 py-1',
                      shape.bg,
                    )}
                    style={{ fontVariationSettings: fontWeights.normal }}
                  >
                    {formatValue(hoverPreview.snappedValue)}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Track background; overflow-hidden gives the fill and hover bar
                its rounded ends. */}
            <motion.div
              className={cn(
                'absolute border border-border overflow-hidden rounded-full',
                trackClassName,
              )}
              initial={false}
              animate={{
                height: TRACK_BG_HEIGHT,
                top: 8 + (THUMB_SIZE - TRACK_BG_HEIGHT) / 2,
              }}
              transition={spring.fast}
              style={{
                left: TRACK_INSET,
                right: TRACK_INSET,
                backgroundColor: 'transparent',
                ...trackStyle,
              }}
            >
              {/* Filled range */}
              {!hideFill && (
                <motion.div
                  className={cn('absolute h-full bg-selected/50 dark:bg-accent/40', fillClassName)}
                  style={{
                    left: fillLeft,
                    width: fillWidth,
                    ...fillStyle,
                  }}
                />
              )}

              {/* Hover preview, in pill px (track px minus TRACK_INSET). */}
              <motion.div
                className="absolute h-full pointer-events-none z-[2]"
                initial={false}
                animate={{
                  opacity: hoverPreview && !isPressed ? 1 : 0,
                }}
                transition={{
                  opacity: { duration: 0.15 },
                }}
                style={{
                  left: hoverPreview ? hoverPreview.left - TRACK_INSET : 0,
                  width: hoverPreview ? hoverPreview.width : 0,
                  borderRadius:
                    hoverPreview && hoverPreview.cursorX > hoverPreview.left
                      ? '0 9999px 9999px 0'
                      : '9999px 0 0 9999px',
                  backgroundColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)',
                }}
              />
            </motion.div>

            {/* Step dots — masked so filled side is hidden */}
            {stepDots.length > 0 && (
              <motion.div
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: 8 + (THUMB_SIZE - TRACK_BG_HEIGHT) / 2,
                  height: TRACK_BG_HEIGHT,
                  WebkitMaskImage: stepDotsMask,
                  maskImage: stepDotsMask,
                }}
              >
                {stepDots.map(({ value: v, percent }) => (
                  <div
                    key={v}
                    className="absolute pointer-events-none flex items-center justify-center"
                    style={{
                      left: `calc(${THUMB_SIZE / 2}px + ${percent} * (100% - ${THUMB_SIZE}px))`,
                      top: '50%',
                      width: 0,
                      height: 0,
                    }}
                  >
                    <motion.div
                      className="rounded-full flex-shrink-0"
                      initial={false}
                      animate={{
                        width: isHovered ? DOT_SIZE * 1.25 : DOT_SIZE,
                        height: isHovered ? DOT_SIZE * 1.25 : DOT_SIZE,
                      }}
                      transition={spring.moderate}
                      style={{
                        backgroundColor: 'var(--muted-foreground)',
                        opacity: 0.3,
                      }}
                    />
                  </div>
                ))}
              </motion.div>
            )}

            {/* Visual thumbs */}
            {renderVisualThumb(0)}
            {isRange && renderVisualThumb(1)}
          </div>
        </div>

        {/* Bottom / Right value */}
        {(valuePosition === 'bottom' || valuePosition === 'right') && valueDisplay}
      </div>
    );
  },
);

CompactSlider.displayName = 'SliderCompact';

// ---------------------------------------------------------------------------
// ComfortableSlider — the default-step design (pips / scrubber layouts).
// ---------------------------------------------------------------------------

// The drag and animation handlers are omitted because rest props spread onto
// a motion.div, whose own types for those names clash with the DOM ones.
interface SliderComfortableProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | 'onChange'
    | 'defaultValue'
    | 'onDrag'
    | 'onDragStart'
    | 'onDragEnd'
    | 'onDragOver'
    | 'onAnimationStart'
  > {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  variant?: 'pips' | 'scrubber';
  label?: string;
  formatValue?: (v: number) => string;
  disabled?: boolean;
}

// A 32px bordered row with the label and value. "pips" springs the fill on
// every snap; "scrubber" fills continuously under the cursor.
const ComfortableSlider = forwardRef<HTMLDivElement, SliderComfortableProps>(
  (
    {
      value,
      onChange,
      min = 0,
      max = 100,
      step = 1,
      variant = 'pips',
      label,
      formatValue = String,
      disabled = false,
      className,
      ...props
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Row presses and the scrubber's handle strip track their drags apart.
    const dragging = useRef(false);
    const handleDragging = useRef(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isPressed, setIsPressed] = useState(false);
    const [isFocused, setIsFocused] = useState(false);
    const [hoverPreview, setHoverPreview] = useState<{
      left: number;
      width: number;
      snappedValue: number;
      cursorX: number;
    } | null>(null);
    // Only the tooltip waits 100ms into a hover (see CompactSlider).
    const [hoverDelayDone, setHoverDelayDone] = useState(false);
    const shape = useShape();

    if (!isHovered && hoverDelayDone) setHoverDelayDone(false);
    useEffect(() => {
      if (!isHovered) return;
      const id = setTimeout(() => setHoverDelayDone(true), 100);
      return () => clearTimeout(id);
    }, [isHovered]);
    const showHoverTooltip = isHovered && hoverDelayDone;

    // The forwarded ref and rest props land on the bordered row, not the wrapper.
    const mergedRef = useCallback(
      (el: HTMLDivElement | null) => {
        containerRef.current = el;
        if (typeof ref === 'function') (ref as React.RefCallback<HTMLDivElement>)(el);
        else if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = el;
      },
      [ref],
    );

    const pipSteps = useMemo(
      () => Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step),
      [min, max, step],
    );
    const pipCount = pipSteps.length;

    const fillPercent = useMotionValue(
      max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min))),
    );
    // Offset at min so the handle line stays visible.
    const zeroTarget = variant === 'pips' ? 8 : 17;
    const zeroOffset = useMotionValue(value === min ? zeroTarget : 0);

    const fillWidthStyle = useTransform(fillPercent, (p) => `${p * 100}%`);
    // Scrubber handle strip: 8px wide, ending at the fill edge.
    const handleLeftStyle = useTransform(
      [fillPercent, zeroOffset] as MotionValue<number>[],
      ([p, zo]) => `calc(${(p as number) * 100}% - 8px + ${zo as number}px)`,
    );
    // Scrubber line: 9px behind the fill edge, which at min would put it past
    // the row's left edge; zeroOffset (17px) brings it back to 8px.
    const handleLineLeftStyle = useTransform(
      [fillPercent, zeroOffset] as MotionValue<number>[],
      ([p, zo]) => `calc(${(p as number) * 100}% - 9px + ${zo as number}px)`,
    );
    // Pips fill: edge runs from 20px at p = 0 to full width at p = 1, just
    // past the active pip so the mask hides it behind the handle line. At
    // min, zeroOffset × 2.5 (20px) cancels the base and the fill empties.
    const pipsFillWidthStyle = useTransform(
      [fillPercent, zeroOffset] as MotionValue<number>[],
      ([p, zo]) =>
        `calc(${(p as number) * 100}% + ${20 - 20 * (p as number) - (zo as number) * 2.5}px)`,
    );
    // Pips line: centered 12px in from each edge at the extremes (the pips
    // row's px-3 inset), so it stays visible at min without zeroOffset.
    const pipsHandleLineLeftStyle = useTransform(
      fillPercent,
      (p) => `calc(${p * 100}% + ${11 - 24 * p}px)`,
    );
    // Hides pips under the fill with a 2px feather, tracking the fill edge.
    const pipsMaskStyle = useTransform(
      [fillPercent, zeroOffset] as MotionValue<number>[],
      ([p, zo]) => {
        const offset = 20 - 20 * (p as number) - (zo as number) * 2.5;
        return `linear-gradient(to right, transparent calc(${(p as number) * 100}% + ${offset}px), black calc(${(p as number) * 100}% + ${offset + 2}px))`;
      },
    );

    // --- Hover preview computation ---
    const computeHoverPreview = useCallback(
      (clientX: number) => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // Use clientWidth (padding box) — CSS % and absolute left/width are relative to it
        const w = el.clientWidth;
        if (w <= 0 || rect.width <= 0) return;
        // Normalize to layout px; offsetWidth - clientWidth is the border,
        // split across both sides.
        const scale = rect.width / el.offsetWidth;
        const borderLeftLayout = (el.offsetWidth - w) / 2;
        const visualX = clientX - rect.left;
        const layoutX = visualX / scale - borderLeftLayout;
        const clamped = Math.max(0, Math.min(w, layoutX));

        let snappedVal: number;
        if (variant === 'pips') {
          if (pipCount <= 1) return;
          const index = Math.max(
            0,
            Math.min(pipCount - 1, Math.round((clamped / w) * (pipCount - 1))),
          );
          snappedVal = pipSteps[index] as number;
        } else {
          const raw = min + (clamped / w) * (max - min);
          snappedVal = Math.max(min, Math.min(max, Math.round((raw - min) / step) * step + min));
        }
        const snappedPercent = max === min ? 0 : (snappedVal - min) / (max - min);
        const snappedX = snappedPercent * w;

        // Current handle position — for pips, match the visual fill edge offset
        const currentPercent = fillPercent.get();
        let handleX: number;
        if (variant === 'pips') {
          const zo = zeroOffset.get();
          handleX = currentPercent * w + (20 - 20 * currentPercent - zo * 2.5);
        } else {
          handleX = currentPercent * w;
        }

        // Extend hover bar to container edges at extremes so there's no gap
        const edgeX = snappedVal === min ? 0 : snappedVal === max ? w : snappedX;
        const left = Math.min(handleX, edgeX);
        const width = Math.abs(edgeX - handleX);
        setHoverPreview({ left, width, snappedValue: snappedVal, cursorX: snappedX });
      },
      [variant, pipSteps, pipCount, min, max, step, fillPercent, zeroOffset],
    );

    // Sync fill on programmatic/keyboard changes; skipped during either drag.
    useEffect(() => {
      if (dragging.current || handleDragging.current) return;
      const percent = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
      animate(fillPercent, percent, spring.fast);
      animate(zeroOffset, value === min ? zeroTarget : 0, spring.fast);
    }, [value, min, max, variant, fillPercent, zeroOffset, zeroTarget]);

    // Visual x over visual width holds at any ancestor scale. Clamping maps
    // presses in the 8px gutters to min or max.
    const getValueFromX = useCallback(
      (clientX: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return min;
        const x = clientX - rect.left;
        const clamped = Math.max(0, Math.min(rect.width, x));
        if (variant === 'pips') {
          if (pipCount <= 1) return min;
          const index = Math.max(
            0,
            Math.min(pipCount - 1, Math.round((clamped / rect.width) * (pipCount - 1))),
          );
          return pipSteps[index] as number;
        } else {
          const raw = min + (clamped / rect.width) * (max - min);
          const snapped = Math.round((raw - min) / step) * step + min;
          return Math.max(min, Math.min(max, snapped));
        }
      },
      [variant, pipSteps, pipCount, min, max, step],
    );

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        dragging.current = true;
        setIsPressed(true);
        const newVal = getValueFromX(e.clientX);
        onChange(newVal);
        const newPercent = Math.max(0, Math.min(1, (newVal - min) / (max - min)));
        animate(fillPercent, newPercent, spring.fast);
        animate(zeroOffset, newVal === min ? zeroTarget : 0, spring.fast);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      },
      [disabled, getValueFromX, onChange, fillPercent, zeroOffset, zeroTarget, min, max],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragging.current) return;
        const newVal = getValueFromX(e.clientX);
        onChange(newVal);
        const newPercent = Math.max(0, Math.min(1, (newVal - min) / (max - min)));
        // Scrubber: set directly, so the fill stays glued to the cursor.
        // Pips: spring per snap, so each jump between pips eases.
        if (variant === 'scrubber') {
          fillPercent.set(newPercent);
        } else {
          animate(fillPercent, newPercent, spring.fast);
        }
        animate(zeroOffset, newVal === min ? zeroTarget : 0, spring.fast);
      },
      [getValueFromX, onChange, variant, fillPercent, zeroOffset, zeroTarget, min, max],
    );

    // No settle step on release: every move already landed on a snapped value.
    const handlePointerUp = useCallback(() => {
      dragging.current = false;
      setIsPressed(false);
      setHoverPreview(null);
    }, []);

    // Handle drag sets the fill directly from the first event; stopPropagation
    // keeps the row's press handler from also firing.
    const handleResizePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        handleDragging.current = true;
        setIsPressed(true);
        const newVal = getValueFromX(e.clientX);
        onChange(newVal);
        fillPercent.set(Math.max(0, Math.min(1, (newVal - min) / (max - min))));
        animate(zeroOffset, newVal === min ? zeroTarget : 0, spring.fast);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      },
      [disabled, getValueFromX, onChange, fillPercent, zeroOffset, zeroTarget, min, max],
    );

    const handleResizePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!handleDragging.current) return;
        const newVal = getValueFromX(e.clientX);
        onChange(newVal);
        fillPercent.set(Math.max(0, Math.min(1, (newVal - min) / (max - min))));
        animate(zeroOffset, newVal === min ? zeroTarget : 0, spring.fast);
      },
      [getValueFromX, onChange, fillPercent, zeroOffset, zeroTarget, min, max],
    );

    const handleResizePointerUp = useCallback(() => {
      handleDragging.current = false;
      setIsPressed(false);
      setHoverPreview(null);
    }, []);

    const handleRadixChange = useCallback(
      (newValues: number[]) => {
        onChange(newValues[0] as number);
      },
      [onChange],
    );

    const isActive = isHovered || isFocused;

    // Hover lives on this wrapper so the 8px gutters count as hovering too.
    return (
      <div
        className="relative w-full touch-none"
        onPointerEnter={() => {
          if (!disabled) setIsHovered(true);
        }}
        onPointerLeave={() => {
          if (!disabled) {
            setIsHovered(false);
            setHoverPreview(null);
          }
        }}
        onMouseMove={(e) => {
          if (disabled || dragging.current || handleDragging.current) return;
          computeHoverPreview(e.clientX);
        }}
      >
        {/* Hit area 8px beyond each edge (the row covers the middle). */}
        <div
          className="absolute cursor-ew-resize"
          style={{ left: -8, right: -8, top: 0, bottom: 0 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
        {/* Hover value tooltip — outside overflow-hidden container */}
        <AnimatePresence>
          {hoverPreview && showHoverTooltip && !isPressed && (
            <motion.div
              key="hover-tooltip"
              className="absolute -translate-x-1/2 pointer-events-none z-20"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4, transition: spring.fast.exit }}
              transition={spring.fast}
              style={{
                left: hoverPreview.cursorX,
                top: -30,
              }}
            >
              <span
                className={cn(
                  'text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] text-background tabular-nums whitespace-nowrap bg-foreground px-2 py-1',
                  shape.bg,
                )}
                style={{ fontVariationSettings: fontWeights.normal }}
              >
                {formatValue(hoverPreview.snappedValue)}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Focus ring is an outline, which the row's overflow-hidden can't clip. */}
        <motion.div
          ref={mergedRef}
          className={cn(
            'relative w-full h-8 select-none touch-none border border-border overflow-hidden outline-offset-2',
            variant === 'scrubber'
              ? 'flex items-center gap-3 px-4 cursor-ew-resize'
              : 'cursor-ew-resize',
            shape.bg,
            disabled && 'opacity-50 pointer-events-none',
            className,
          )}
          initial={false}
          animate={{
            outline: isFocused ? '1px solid var(--focus-ring, #6B97FF)' : '1px solid transparent',
          }}
          transition={spring.fast}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          {...props}
        >
          {/* Invisible Base UI slider for keyboard + a11y; [&_*]:pointer-events-none
            keeps its thumb off the hit path. */}
          <SliderPrimitive.Root
            value={[value]}
            onValueChange={(v) => handleRadixChange(v as number[])}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            className="absolute inset-0 opacity-0 pointer-events-none [&_*]:pointer-events-none"
          >
            <SliderPrimitive.Control className="w-full h-full">
              <SliderPrimitive.Track className="w-full h-full">
                <SliderPrimitive.Indicator />
              </SliderPrimitive.Track>
              <SliderPrimitive.Thumb
                index={0}
                aria-label={label}
                className="block outline-none"
                onFocus={(e) => {
                  if ((e.currentTarget as HTMLElement).matches(':focus-visible'))
                    setIsFocused(true);
                }}
                onBlur={() => setIsFocused(false)}
              />
            </SliderPrimitive.Control>
          </SliderPrimitive.Root>

          {/* Hover preview, from the fill edge to the snapped hover value. */}
          <motion.div
            className="absolute inset-y-0 pointer-events-none z-[3]"
            initial={false}
            animate={{
              opacity: hoverPreview && !isPressed ? 1 : 0,
            }}
            transition={{ opacity: { duration: 0.15 } }}
            style={{
              left: hoverPreview ? hoverPreview.left : 0,
              width: hoverPreview ? hoverPreview.width : 0,
              backgroundColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)',
            }}
          />

          {/* Pips: dots layer — z-[1] */}
          {variant === 'pips' && (
            <motion.div
              className="absolute inset-0 flex justify-between items-center px-3 pointer-events-none z-[1]"
              style={{ WebkitMaskImage: pipsMaskStyle, maskImage: pipsMaskStyle }}
            >
              {pipSteps.map((pipValue) => {
                // The active pip goes full foreground. At rest it only shows at
                // min; elsewhere the mask hides it behind the handle line.
                const isActivePip = pipValue === value;
                return (
                  <div
                    key={pipValue}
                    className="relative flex items-center justify-center"
                    style={{ width: PIP_SIZE, height: PIP_SIZE }}
                  >
                    <motion.div
                      className="rounded-full"
                      initial={false}
                      animate={{
                        backgroundColor: isActivePip
                          ? 'var(--foreground)'
                          : 'var(--muted-foreground)',
                        opacity: isActivePip ? 1 : 0.3,
                      }}
                      transition={spring.fast}
                      style={{ width: PIP_SIZE, height: PIP_SIZE }}
                    />
                  </div>
                );
              })}
            </motion.div>
          )}

          {/* Pips: label + value BG layer — z-[2]; transparent-text copies on
            bg-background so pips never cross the words. */}
          {variant === 'pips' && (
            <div
              className="absolute inset-0 flex items-center px-2 z-[2] pointer-events-none"
              aria-hidden
            >
              {label && (
                <span className="text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] px-2 bg-background text-transparent select-none">
                  {label}
                </span>
              )}
              <span
                className="text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] tabular-nums ml-auto px-2 bg-background text-transparent select-none"
                style={{ minWidth: `${String(formatValue(max)).length}ch` }}
              >
                {formatValue(value)}
              </span>
            </div>
          )}

          {/* Pips: fill — z-[3] */}
          {variant === 'pips' && (
            <motion.div
              className="absolute left-0 top-0 bottom-0 pointer-events-none z-[3]"
              style={{
                width: pipsFillWidthStyle,
                backgroundColor: 'var(--active)',
              }}
            />
          )}

          {/* Pips: handle line — z-[3] */}
          {variant === 'pips' && (
            <motion.div
              className="absolute rounded-full pointer-events-none z-[3]"
              initial={false}
              animate={{
                top: isActive ? 7 : 8,
                bottom: isActive ? 7 : 8,
                backgroundColor: isFocused
                  ? 'var(--foreground)'
                  : isHovered
                    ? 'color-mix(in srgb, var(--foreground) 50%, transparent)'
                    : 'color-mix(in srgb, var(--foreground) 25%, transparent)',
              }}
              transition={spring.fast}
              style={{
                left: pipsHandleLineLeftStyle,
                width: 2,
              }}
            />
          )}

          {/* Pips: label + value text layer — z-[4] */}
          {variant === 'pips' && (
            <div className="absolute inset-0 flex items-center px-2 z-[4] pointer-events-none">
              {label && (
                <motion.span
                  className="text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] px-2"
                  initial={false}
                  animate={{ color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)' }}
                  transition={spring.fast}
                >
                  {label}
                </motion.span>
              )}
              {/* minWidth reserves formatValue(max)'s width. */}
              <motion.span
                className="text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] tabular-nums ml-auto px-2"
                initial={false}
                animate={{ color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)' }}
                transition={spring.fast}
                style={{ minWidth: `${String(formatValue(max)).length}ch`, textAlign: 'right' }}
              >
                {formatValue(value)}
              </motion.span>
            </div>
          )}

          {/* Scrubber: fill */}
          {variant === 'scrubber' && (
            <motion.div
              className="absolute left-0 top-0 bottom-0 pointer-events-none"
              style={{
                width: fillWidthStyle,
                backgroundColor: 'var(--active)',
              }}
            />
          )}

          {/* Scrubber: handle line */}
          {variant === 'scrubber' && (
            <motion.div
              className="absolute rounded-full pointer-events-none z-10"
              initial={false}
              animate={{
                top: isActive ? 7 : 8,
                bottom: isActive ? 7 : 8,
                backgroundColor: isFocused
                  ? 'var(--foreground)'
                  : isHovered
                    ? 'color-mix(in srgb, var(--foreground) 50%, transparent)'
                    : 'color-mix(in srgb, var(--foreground) 25%, transparent)',
              }}
              transition={spring.fast}
              style={{
                left: handleLineLeftStyle,
                width: 2,
              }}
            />
          )}

          {/* Scrubber: label */}
          {variant === 'scrubber' && label && (
            <motion.span
              className="text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] shrink-0 z-10"
              initial={false}
              animate={{ color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)' }}
              transition={spring.fast}
            >
              {label}
            </motion.span>
          )}

          {/* Scrubber: flex-1 spacer + value */}
          {variant === 'scrubber' && (
            <>
              <div className="flex-1" />
              <motion.span
                className="text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] shrink-0 tabular-nums text-right z-10"
                initial={false}
                animate={{ color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)' }}
                transition={spring.fast}
                style={{ minWidth: `${String(formatValue(max)).length}ch` }}
              >
                {formatValue(value)}
              </motion.span>
            </>
          )}

          {/* Resize handle (scrubber only): an 8px grab strip at the line. */}
          {variant === 'scrubber' && (
            <motion.div
              className="absolute top-0 bottom-0 w-2 cursor-ew-resize z-20"
              style={{ left: handleLeftStyle }}
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
              onPointerCancel={handleResizePointerUp}
            />
          )}
        </motion.div>
      </div>
    );
  },
);

ComfortableSlider.displayName = 'SliderComfortable';

// ---------------------------------------------------------------------------
// Slider — the public component. Features only the compact engine implements
// (ranges, step lists, value display, track styling) force it at any size.
// ---------------------------------------------------------------------------

/** Props only the compact engine implements; setting any one routes the
 *  slider to it (see needsCompactEngine below). */
const COMPACT_ENGINE_PROPS = [
  'steps',
  'showSteps',
  'showValue',
  'valuePosition',
  'trackClassName',
  'trackStyle',
  'fillClassName',
  'fillStyle',
  'hideFill',
  'thumbColor',
  'thumbBorderColor',
] as const;

interface SliderProps extends SliderEngineProps {
  /** Default-step layout: value pips along the track, or an edge-to-edge
   *  scrubber. Ignored when the compact design renders. */
  variant?: 'pips' | 'scrubber';
  /** Pins the slider to one step of the size ladder.
   *  Omitted, it follows the surrounding SizeProvider. */
  size?: SizeVariant;
}

const Slider = forwardRef<HTMLDivElement, SliderProps>(
  ({ size, variant = 'pips', ...props }, ref) => {
    const resolved = useSizeVariant(size);
    // Presence, not truthiness: an explicit showValue={false} still picks the
    // compact engine, the only one that reads those props.
    const needsCompactEngine =
      Array.isArray(props.value) || COMPACT_ENGINE_PROPS.some((key) => props[key] !== undefined);

    if (resolved === 'compact' || needsCompactEngine) {
      return <CompactSlider ref={ref} {...props} />;
    }

    const { value, onChange, min, max, step, label, formatValue, disabled, ...rest } = props;
    // Compact-engine-only fields are all undefined on this path.
    const html = omit(rest, COMPACT_ENGINE_PROPS);

    return (
      <ComfortableSlider
        ref={ref}
        value={value as number}
        onChange={onChange as (v: number) => void}
        min={min}
        max={max}
        step={step}
        variant={variant}
        label={label}
        formatValue={formatValue}
        disabled={disabled}
        {...(html as Omit<SliderComfortableProps, 'value' | 'onChange'>)}
      />
    );
  },
);

Slider.displayName = 'Slider';

/** @deprecated The comfortable design is now the ladder's default step —
 *  render <Slider> (optionally with `variant`) instead. */
const SliderComfortable = ComfortableSlider;

export type { SliderComfortableProps, SliderProps, SliderValue, ValuePosition };
export { Slider, SliderComfortable };
