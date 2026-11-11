'use client';

import { Popover } from '@base-ui/react/popover';
import { motion } from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { nestedRadius, useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { surfaceClasses } from '../../lib/surface-classes.ts';
import { SurfaceProvider, useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';
import { Slider } from './slider.tsx';
import { Tooltip } from './tooltip.tsx';

// -----------------------------------------------------------------------------
// The color lives in state as HSV; keeping H lets the hue survive gray or
// black, where RGB has none. Every edit emits an opaque `#rrggbb` (lower case)
// plus the parsed color.
//
// Corral copy: opaque colors only (no alpha slider or alpha field) and hex as
// the only format (no format menu, no RGB/HSL/OKLCH channel fields). Labels are
// the host's, the swatches carry names, and the popover takes a host trigger.
// -----------------------------------------------------------------------------

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedColor {
  // HSV (canonical, 0..360 / 0..1 / 0..1)
  h: number;
  s: number;
  v: number;
  // sRGB 0..255
  r: number;
  g: number;
  b: number;
  /** `#rrggbb`, lower case. */
  hex: string;
}

/** The picker's words; English unless the host passes its own. */
interface ColorPickerLabels {
  /** The saturation and brightness area. */
  area: string;
  hue: string;
  /** The hex field. */
  hex: string;
  eyedropper: string;
  /** Shown under the hex field while its text is not a `#rrggbb` color. */
  invalid: string;
  /** The default trigger's remove control. */
  remove: string;
}

const DEFAULT_LABELS: ColorPickerLabels = {
  area: 'Saturation and brightness',
  hue: 'Hue',
  hex: 'Hex value',
  eyedropper: 'Pick color from screen',
  invalid: 'Use #rrggbb.',
  remove: 'Remove color',
};

/** A swatch: a `#rrggbb` color, or one with a name to show and announce. */
type ColorPickerSwatch = string | { color: string; label: string };

interface ColorPickerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue' | 'children'> {
  /** `#rrggbb` (the `#` optional, any case). A later value that doesn't parse
   *  is ignored (the panel keeps its color); an unparseable first value
   *  starts at pure red. */
  value?: string;
  defaultValue?: string;
  /** Fires with the color as lower-case `#rrggbb` plus the parsed color. */
  onValueChange?: (value: string, parsed: ParsedColor) => void;
  swatches?: ColorPickerSwatch[];
  /** The button already hides itself where `window.EyeDropper` is missing
   *  (the API is Chromium-only). */
  hideEyedropper?: boolean;
  /** Pins trigger and popover to one step of the size ladder (default 36px,
   *  compact 28px). Omitted, they follow the surrounding
   *  SizeProvider. */
  size?: SizeVariant;
  labels?: Partial<ColorPickerLabels>;
  /** Host content under the swatches (a contrast readout, a note). */
  children?: ReactNode;
}

interface ColorPickerPopoverProps extends ColorPickerProps {
  /** Replaces the bordered trigger (Base UI `render`): the host's own tile or
   *  button opens the panel and keeps its own name. */
  trigger?: ReactElement;
  triggerLabel?: string;
  triggerLabelPosition?: 'left' | 'right';
  /** Shows the color as 6-digit hex next to the tile. Default true. */
  triggerShowValue?: boolean;
  /** Adds an X inside the trigger that calls onTriggerRemove without
   *  opening the popover. */
  triggerShowRemove?: boolean;
  onTriggerRemove?: () => void;
  triggerClassName?: string;
  /** The popup's accessible name. */
  popupLabel?: string;
  /** Controls the popover's open state. When provided, the popover is fully
   *  controlled and ignores trigger clicks. */
  open?: boolean;
  /** Initial open state for the popover (uncontrolled). */
  defaultOpen?: boolean;
  /** Called when the open state would change (fires even when controlled). */
  onOpenChange?: (open: boolean) => void;
}

interface ColorSwatchProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'color'> {
  /** Any CSS color; it paints over a checker. */
  color: string;
  /** Square edge in px. Default 28. */
  size?: number;
  /** Draws the accent ring outside a 2px background gap. */
  selected?: boolean;
  /** The accessible name; defaults to the color. */
  label?: string;
}

// ─── Color math (no deps) ────────────────────────────────────────────────────

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function clamp255(n: number) {
  return Math.max(0, Math.min(255, n));
}

// Any hue angle is accepted. Channels are unrounded 0..255 floats.
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) {
    r = c;
    g = x;
  } else if (hh < 2) {
    r = x;
    g = c;
  } else if (hh < 3) {
    g = c;
    b = x;
  } else if (hh < 4) {
    g = x;
    b = c;
  } else if (hh < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = v - c;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// Achromatic colors return h = 0, s = 0; callers check `s === 0` and keep
// their current hue.
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

function to2hex(n: number): string {
  return Math.round(clamp255(n)).toString(16).padStart(2, '0');
}

function rgbToHexStr(r: number, g: number, b: number): string {
  return `#${to2hex(r)}${to2hex(g)}${to2hex(b)}`;
}

// Exactly six digits, "#" optional, any case: the only form a color takes here.
function parseColor(input: string): { r: number; g: number; b: number } | null {
  const m = input.trim().match(/^#?([0-9a-fA-F]{6})$/);
  const digits = m?.[1];
  if (!digits) return null;
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

const subscribeNever = () => () => {};

/** False on the server and while hydrating, true after: a client-only value
 *  without a hydration mismatch. */
function useIsClient() {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

function buildParsed(h: number, s: number, v: number): ParsedColor {
  const { r, g, b } = hsvToRgb(h, s, v);
  return {
    h,
    s,
    v,
    r: Math.round(r),
    g: Math.round(g),
    b: Math.round(b),
    hex: rgbToHexStr(r, g, b),
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PANEL_WIDTH = 280;
const SQUARE_HEIGHT = 156;
// 8px checkerboard behind the swatches.
const CHECKER_BG: CSSProperties = {
  backgroundImage:
    'conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%, var(--checker-a) 0 75%, var(--checker-b) 0)',
  backgroundSize: '8px 8px',
};

// ─── SaturationSquare ────────────────────────────────────────────────────────

interface SaturationSquareProps {
  h: number;
  s: number;
  v: number;
  label: string;
  onChange: (s: number, v: number) => void;
}

// x = saturation, y = value. Arrows nudge by 0.01, Shift by 0.1.
function SaturationSquare({ h, s, v, label, onChange }: SaturationSquareProps) {
  const ref = useRef<HTMLDivElement>(null);
  // State, not a ref: it gates the ghost cursor during render.
  const [dragging, setDragging] = useState(false);
  const hasMoved = useRef(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const shape = useShape();
  // Nested inside the panel's 12px padding (p-3).
  const radius = nestedRadius(shape.containerRadius, 12);

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const x = clamp01((clientX - rect.left) / rect.width);
      const y = clamp01((clientY - rect.top) / rect.height);
      onChange(x, 1 - y);
    },
    [onChange],
  );

  // Ghost ring position: previews where a press will land.
  const updateCursorPos = useCallback((clientX: number, clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setCursorPos({
      x: clamp01((clientX - rect.left) / rect.width) * 100,
      y: clamp01((clientY - rect.top) / rect.height) * 100,
    });
  }, []);

  // Pointer capture keeps the drag alive past the edges.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      setDragging(true);
      hasMoved.current = false;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      updateFromPointer(e.clientX, e.clientY);
    },
    [updateFromPointer],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      updateCursorPos(e.clientX, e.clientY);
      if (!dragging) return;
      hasMoved.current = true;
      updateFromPointer(e.clientX, e.clientY);
    },
    [dragging, updateFromPointer, updateCursorPos],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
    hasMoved.current = false;
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.1 : 0.01;
      let nextS = s;
      let nextV = v;
      let handled = true;
      if (e.key === 'ArrowLeft') nextS = clamp01(s - step);
      else if (e.key === 'ArrowRight') nextS = clamp01(s + step);
      else if (e.key === 'ArrowUp') nextV = clamp01(v + step);
      else if (e.key === 'ArrowDown') nextV = clamp01(v - step);
      else handled = false;
      if (handled) {
        e.preventDefault();
        onChange(nextS, nextV);
      }
    },
    [onChange, s, v],
  );

  const { r, g, b } = hsvToRgb(h, s, v);
  const thumbColor = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

  // role="application" hands the arrow keys to this widget. cursor-none: the
  // ghost ring stands in for the OS cursor.
  return (
    <div
      ref={ref}
      role="application"
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The area is a two-axis control; role="application" hands it the arrow keys.
      tabIndex={0}
      onFocus={(e) => {
        if (e.currentTarget.matches(':focus-visible')) setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        setCursorPos(null);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className="relative w-full cursor-none touch-none select-none outline-none"
      style={{
        height: SQUARE_HEIGHT,
        borderRadius: radius,
        boxShadow: focused ? '0 0 0 2px var(--focus-ring, #6B97FF)' : undefined,
      }}
    >
      <div
        className="absolute inset-0 overflow-hidden"
        style={{
          borderRadius: radius,
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))`,
        }}
      />
      {/* White border + black ring stays visible on any region; duration 0 so
          it never lags the pointer. */}
      <motion.div
        className="pointer-events-none absolute rounded-full"
        initial={false}
        animate={{
          left: `${s * 100}%`,
          top: `${(1 - v) * 100}%`,
          width: 18,
          height: 18,
        }}
        transition={{ duration: 0 }}
        style={{
          transform: 'translate(-50%, -50%)',
          border: '1px solid white',
          boxShadow: '0 0 0 1px rgba(0,0,0,1)',
          backgroundColor: thumbColor,
        }}
      />
      {/* Ghost ring: hollow so it never reads as the value. */}
      {hovered && !dragging && cursorPos && (
        <div
          className="pointer-events-none absolute rounded-full"
          style={{
            left: `${cursorPos.x}%`,
            top: `${cursorPos.y}%`,
            width: 18,
            height: 18,
            transform: 'translate(-50%, -50%)',
            border: '2px solid rgba(255, 255, 255, 0.55)',
            boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.2)',
          }}
        />
      )}
    </div>
  );
}

// ─── HueSlider ───────────────────────────────────────────────────────────────

// trackStyle / hideFill / thumbColor put Slider in its compact mode at any
// size; hideFill so no fill paints over the gradient track.
function HueSlider({
  h,
  label,
  onChange,
}: {
  h: number;
  label: string;
  onChange: (h: number) => void;
}) {
  const hueColor = `hsl(${h}, 100%, 50%)`;
  return (
    <Slider
      value={h}
      onChange={(v) => onChange(typeof v === 'number' ? v : (v[0] ?? h))}
      min={0}
      max={360}
      step={1}
      showValue={false}
      hideFill
      thumbColor={hueColor}
      thumbBorderColor="rgba(255,255,255,0.9)"
      trackStyle={{
        background:
          'linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))',
        borderColor: 'transparent',
      }}
      // The source passes aria-label, which lands on the root, not the thumb.
      label={label}
    />
  );
}

// Base UI can't see the Motion exit spring and would cut it, so closes hold
// the unmount (preventUnmountOnClose) until actionsRef.unmount(). A close via
// the `open` prop skips onOpenChange, so it's replayed through actionsRef.close().
type PopupActions = { unmount: () => void; close: () => void };

function usePopupExit(open: boolean, setOpen: (open: boolean) => void) {
  const actionsRef = useRef<PopupActions | null>(null);
  const [rootOpen, setRootOpen] = useState(open);
  if (open && !rootOpen) setRootOpen(true);
  useLayoutEffect(() => {
    if (open || !rootOpen) return;
    // Without actionsRef, close straight away rather than stay open.
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

// -----------------------------------------------------------------------------
// HexInput: the hex field. A complete six-digit value applies as it is typed;
// on Enter or blur anything else is marked (and never applied), Escape puts the
// current color back.
// -----------------------------------------------------------------------------

/** One value however it was typed: with or without `#`, in either case. */
function sameHex(a: string, b: string) {
  return a.replace(/^#/, '').toLowerCase() === b.replace(/^#/, '').toLowerCase();
}

function HexInput({
  value,
  onCommit,
  label,
  invalidLabel,
}: {
  value: string;
  onCommit: (hex: string) => void;
  label: string;
  invalidLabel: string;
}) {
  // A local draft; outside changes don't overwrite it mid-edit.
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const interactingRef = useRef(false);
  const shape = useShape();
  const sizeClasses = useSize();
  const compact = sizeClasses.variant === 'compact';
  const messageId = useId();

  useEffect(() => {
    if (!interactingRef.current) {
      setDraft(value);
      setInvalid(false);
    }
  }, [value]);

  const commit = () => {
    const parsed = parseColor(draft);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const hex = rgbToHexStr(parsed.r, parsed.g, parsed.b);
    if (hex !== value) onCommit(hex);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div
        className={cn(
          // Touch screens use 16px digits; halve the inset to fit them.
          'flex select-none items-center bg-transparent px-2 transition-colors duration-80 hover:bg-hover focus-within:outline-2 focus-within:outline-[color:var(--focus-ring)] focus-within:outline-offset-2 focus-within:outline-solid active:bg-active pointer-coarse:px-1',
          invalid && 'shadow-[inset_0_0_0_1px_var(--destructive)]',
          sizeClasses.control,
          shape.input,
        )}
      >
        <span
          className={cn(
            'mr-1 select-none text-muted-foreground',
            typeClass('caption', compact ? 'compact' : 'default'),
          )}
        >
          #
        </span>
        <input
          value={draft.replace(/^#/, '')}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            const parsed = parseColor(next);
            if (parsed) {
              setInvalid(false);
              onCommit(rgbToHexStr(parsed.r, parsed.g, parsed.b));
            }
          }}
          onFocus={(e) => {
            interactingRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            interactingRef.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape' && (!sameHex(draft, value) || invalid)) {
              // Puts the color back; a second Escape closes the popover.
              e.stopPropagation();
              setDraft(value);
              setInvalid(false);
            }
          }}
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          maxLength={7}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? messageId : undefined}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-foreground uppercase tabular-nums outline-none',
            sizeClasses.field,
          )}
          style={{ fontVariationSettings: fontWeights.normal }}
        />
      </div>
      {invalid ? (
        <p
          id={messageId}
          className={cn(
            'm-0 text-destructive',
            typeClass('caption', compact ? 'compact' : 'default'),
          )}
        >
          {invalidLabel}
        </p>
      ) : null}
    </div>
  );
}

// ─── EyeDropperButton ────────────────────────────────────────────────────────

// Typed here because TypeScript's DOM lib doesn't ship EyeDropper.
interface EyeDropperGlobal {
  open(): Promise<{ sRGBHex: string }>;
}

function EyeDropperButton({ label, onPick }: { label: string; onPick: (hex: string) => void }) {
  const shape = useShape();
  const sizeClasses = useSize();
  const icons = useIcons();
  const PipetteIcon = icons.pipette;

  // Chromium only. Unsupported on the server and while hydrating, so no mismatch.
  const supported = useIsClient() && 'EyeDropper' in window;

  if (!supported) return null;

  // open() rejects on Escape; cancelling isn't an error.
  const handleClick = async () => {
    try {
      const Ctor = (window as unknown as { EyeDropper: new () => EyeDropperGlobal }).EyeDropper;
      const eye = new Ctor();
      const result = await eye.open();
      onPick(result.sRGBHex);
    } catch {
      // user cancelled
    }
  };

  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        className={cn(
          'flex shrink-0 cursor-pointer items-center justify-center bg-transparent text-muted-foreground transition-colors duration-80 hover:bg-hover hover:text-foreground active:bg-active',
          focusRing,
          sizeClasses.control,
          sizeClasses.px,
          shape.input,
        )}
      >
        <PipetteIcon size={sizeClasses.icon} strokeWidth={1.5} />
      </button>
    </Tooltip>
  );
}

// ─── ColorTile (small colored square — checker behind) ───────────────────────

interface ColorTileProps {
  color: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

// The inset hairline keeps white or near-background colors visible.
function ColorTile({ color, size = 24, className, style }: ColorTileProps) {
  const shape = useShape();
  return (
    <span
      className={cn('relative inline-block shrink-0 overflow-hidden', shape.bg, className)}
      style={{
        width: size,
        height: size,
        ...CHECKER_BG,
        boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.25)',
        ...style,
      }}
    >
      <span className="absolute inset-0" style={{ backgroundColor: color }} />
    </span>
  );
}

// ─── ColorSwatch (clickable strip swatch) ────────────────────────────────────

const ColorSwatch = forwardRef<HTMLButtonElement, ColorSwatchProps>(
  ({ color, size = 28, selected, label, className, onMouseEnter, onMouseLeave, ...props }, ref) => {
    const shape = useShape();
    const [hovered, setHovered] = useState(false);
    // Hairline, a 2px background gap, then the ring; the gap keeps it readable
    // on any swatch color.
    const ring = selected
      ? 'inset 0 0 0 1px rgba(127,127,127,0.25), 0 0 0 2px var(--background), 0 0 0 4px var(--emphasis)'
      : hovered
        ? 'inset 0 0 0 1px rgba(127,127,127,0.25), 0 0 0 2px var(--background), 0 0 0 4px rgba(127,127,127,0.4)'
        : 'inset 0 0 0 1px rgba(127,127,127,0.25)';
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label ?? color}
        aria-pressed={selected ?? false}
        className={cn(
          'relative shrink-0 cursor-pointer overflow-hidden transition-shadow duration-80',
          focusRing,
          shape.bg,
          className,
        )}
        style={{
          width: size,
          height: size,
          ...CHECKER_BG,
          boxShadow: ring,
        }}
        onMouseEnter={(e) => {
          setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setHovered(false);
          onMouseLeave?.(e);
        }}
        {...props}
      >
        <span className="absolute inset-0" style={{ backgroundColor: color }} />
      </button>
    );
  },
);

ColorSwatch.displayName = 'ColorSwatch';

// ─── SwatchStrip ─────────────────────────────────────────────────────────────

function SwatchStrip({
  swatches,
  current,
  onPick,
}: {
  swatches: ColorPickerSwatch[];
  current: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {swatches.map((swatch, i) => {
        const { color, label } = typeof swatch === 'string' ? { color: swatch, label: '' } : swatch;
        const parsed = parseColor(color);
        const normalized = parsed ? rgbToHexStr(parsed.r, parsed.g, parsed.b) : color.toLowerCase();
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: The same color may appear twice in a list.
          <Tooltip key={`${normalized}-${i}`} content={label || normalized}>
            <ColorSwatch
              color={normalized}
              size={24}
              label={label || normalized}
              selected={normalized === current}
              onClick={() => onPick(normalized)}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}

// ─── ColorPicker (panel) ─────────────────────────────────────────────────────

const ColorPicker = forwardRef<HTMLDivElement, ColorPickerProps>(
  (
    {
      value,
      defaultValue = '#6B97FF',
      onValueChange,
      swatches,
      hideEyedropper,
      size,
      labels: labelOverrides,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const labels = { ...DEFAULT_LABELS, ...labelOverrides };
    const isControlled = value !== undefined;
    const [internalValue, setInternalValue] = useState(value ?? defaultValue);
    const currentRawValue = isControlled ? (value as string) : internalValue;

    // Canonical HSV, seeded once from the initial value.
    const [hsv, setHsv] = useState(() => {
      const p = parseColor(currentRawValue);
      if (!p) return { h: 0, s: 1, v: 1 };
      const next = rgbToHsv(p.r, p.g, p.b);
      return { h: next.s === 0 ? 0 : next.h, s: next.s, v: next.v };
    });

    // Sync outside value changes during render. A parent echoing back our own
    // last emitted string is skipped, so rounding never snaps HSV.
    const [lastEmitted, setLastEmitted] = useState('');
    const [syncedValue, setSyncedValue] = useState(value);
    if (isControlled && value !== syncedValue) {
      setSyncedValue(value);
      const p = value !== lastEmitted ? parseColor(value as string) : null;
      if (p) {
        const next = rgbToHsv(p.r, p.g, p.b);
        // A gray, white or black from outside keeps the hue already in state.
        setHsv((prev) => ({ h: next.s === 0 ? prev.h : next.h, s: next.s, v: next.v }));
      }
    }

    const parsed = useMemo(() => buildParsed(hsv.h, hsv.s, hsv.v), [hsv]);

    const emit = useCallback(
      (next: ParsedColor) => {
        setLastEmitted(next.hex);
        if (!isControlled) setInternalValue(next.hex);
        onValueChange?.(next.hex, next);
      },
      [isControlled, onValueChange],
    );

    const updateHsv = useCallback(
      (next: { h?: number; s?: number; v?: number }) => {
        const merged = { ...hsv, ...next };
        setHsv(merged);
        emit(buildParsed(merged.h, merged.s, merged.v));
      },
      [hsv, emit],
    );

    // Whole-color entry for the hex field, swatches and eyedropper.
    const handleHexCommit = useCallback(
      (input: string) => {
        const p = parseColor(input);
        if (!p) return;
        const next = rgbToHsv(p.r, p.g, p.b);
        const merged = { h: next.s === 0 ? hsv.h : next.h, s: next.s, v: next.v };
        setHsv(merged);
        emit(buildParsed(merged.h, merged.s, merged.v));
      },
      [hsv.h, emit],
    );

    const shape = useShape();
    const substrate = useSurface();
    // Announce the panel's level so popups elevate above it.
    const pickerLevel = Math.max(substrate, 3);

    const root = (
      <SurfaceProvider value={pickerLevel}>
        {/* p-3 must match the 12px SaturationSquare subtracts from the radius. */}
        <div
          ref={ref}
          className={cn(
            'flex flex-col gap-2 p-3',
            surfaceClasses(pickerLevel, 1),
            shape.container,
            className,
          )}
          style={{ width: PANEL_WIDTH, maxWidth: '100%' }}
          {...props}
        >
          <SaturationSquare
            h={hsv.h}
            s={hsv.s}
            v={hsv.v}
            label={labels.area}
            onChange={(s, v) => updateHsv({ s, v })}
          />

          <HueSlider h={hsv.h} label={labels.hue} onChange={(h) => updateHsv({ h })} />

          <div className="flex items-start gap-2">
            <HexInput
              value={parsed.hex}
              onCommit={handleHexCommit}
              label={labels.hex}
              invalidLabel={labels.invalid}
            />
            {!hideEyedropper && (
              <EyeDropperButton label={labels.eyedropper} onPick={handleHexCommit} />
            )}
          </div>

          {swatches && swatches.length > 0 && (
            <SwatchStrip swatches={swatches} current={parsed.hex} onPick={handleHexCommit} />
          )}

          {children}
        </div>
      </SurfaceProvider>
    );

    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
  },
);

ColorPicker.displayName = 'ColorPicker';

// -----------------------------------------------------------------------------
// ColorPickerPopover (trigger button + popover panel)
//
// Base UI Popover handles positioning, dismissal and focus; usePopupExit
// holds the unmount so the exit spring plays.
// -----------------------------------------------------------------------------

const ColorPickerPopover = forwardRef<HTMLDivElement, ColorPickerPopoverProps>(
  (
    {
      trigger,
      triggerLabel,
      triggerLabelPosition = 'left',
      triggerShowValue = true,
      triggerShowRemove = false,
      onTriggerRemove,
      triggerClassName,
      popupLabel,
      open: openProp,
      defaultOpen = false,
      onOpenChange,
      size,
      ...pickerProps
    },
    ref,
  ) => {
    const isOpenControlled = openProp !== undefined;
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const open = isOpenControlled ? openProp : internalOpen;
    const shape = useShape();
    // Uses the prop directly: these hooks run outside the SizeProvider below.
    const sizeClasses = useSize(size);
    const compact = sizeClasses.variant === 'compact';
    const substrate = useSurface();
    // Two surface levels above the opener, capped at 8.
    const level = Math.min(substrate + 2, 8);
    const labels = { ...DEFAULT_LABELS, ...pickerProps.labels };

    const handleOpenChange = useCallback(
      (next: boolean) => {
        if (!isOpenControlled) setInternalOpen(next);
        onOpenChange?.(next);
      },
      [isOpenControlled, onOpenChange],
    );
    const {
      actionsRef,
      rootOpen,
      onOpenChange: handleRootOpenChange,
    } = usePopupExit(open, handleOpenChange);

    // The popover owns the value (the trigger shows it); the panel is always
    // controlled.
    const isControlled = pickerProps.value !== undefined;
    const [internalValue, setInternalValue] = useState(
      pickerProps.value ?? pickerProps.defaultValue ?? '#6B97FF',
    );
    const currentValue = isControlled ? (pickerProps.value as string) : internalValue;

    const onValueChange = pickerProps.onValueChange;
    const handleValueChange = useCallback(
      (v: string, parsed: ParsedColor) => {
        if (!isControlled) setInternalValue(v);
        onValueChange?.(v, parsed);
      },
      [isControlled, onValueChange],
    );

    // Fallback unmount for background tabs (spring.moderate.exit is 120ms).
    useEffect(() => {
      if (open) return;
      const id = setTimeout(() => actionsRef.current?.unmount(), 150);
      return () => clearTimeout(id);
    }, [open, actionsRef]);

    const icons = useIcons();
    const XIcon = icons.x;
    const parsed = useMemo(() => parseColor(currentValue), [currentValue]);
    const swatchColor = parsed ? rgbToHexStr(parsed.r, parsed.g, parsed.b) : currentValue;
    const valueLabel = swatchColor.replace(/^#/, '').toUpperCase();

    const root = (
      <Popover.Root
        open={rootOpen}
        onOpenChange={handleRootOpenChange}
        actionsRef={actionsRef}
        // Non-modal: the page keeps scrolling and the panel tracks its trigger.
        modal={false}
      >
        {trigger ? (
          <Popover.Trigger render={trigger} />
        ) : (
          <div ref={ref} className="inline-flex">
            <Popover.Trigger
              className={cn(
                'flex cursor-pointer items-center border border-border bg-transparent transition-colors duration-80 hover:bg-hover',
                focusRing,
                sizeClasses.gap,
                sizeClasses.control,
                compact ? 'px-1.5' : 'px-2',
                shape.input,
                triggerClassName,
              )}
              style={{ fontVariationSettings: fontWeights.normal }}
            >
              {triggerLabel && triggerLabelPosition === 'left' && (
                <span className={cn('select-none px-1 text-muted-foreground', sizeClasses.text)}>
                  {triggerLabel}
                </span>
              )}
              <ColorTile color={swatchColor} size={compact ? 16 : 20} />
              {triggerShowValue && (
                <span className={cn('text-foreground tabular-nums', sizeClasses.text)}>
                  {valueLabel}
                </span>
              )}
              {triggerLabel && triggerLabelPosition === 'right' && (
                <span className={cn('select-none px-1 text-muted-foreground', sizeClasses.text)}>
                  {triggerLabel}
                </span>
              )}
              {/* role="button" span: a real button can't nest in the trigger. */}
              {triggerShowRemove && (
                // biome-ignore lint/a11y/useSemanticElements: A native button cannot nest inside the trigger button.
                <span
                  role="button"
                  aria-label={labels.remove}
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTriggerRemove?.();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      onTriggerRemove?.();
                    }
                  }}
                  className="ml-1 flex cursor-pointer items-center text-muted-foreground hover:text-foreground"
                >
                  <XIcon size={14} strokeWidth={1.5} />
                </span>
              )}
            </Popover.Trigger>
          </div>
        )}
        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 outline-none"
          >
            <motion.div
              initial={{ opacity: 0, y: -4, scaleY: 0.96 }}
              animate={open ? { opacity: 1, y: 0, scaleY: 1 } : { opacity: 0, y: -4, scaleY: 0.96 }}
              transition={open ? spring.moderate : spring.moderate.exit}
              style={{ transformOrigin: 'top left' }}
              // Release the held unmount once the exit spring finishes.
              onAnimationComplete={() => {
                if (!open) actionsRef.current?.unmount();
              }}
            >
              <Popover.Popup
                data-slot="color-picker-popup"
                aria-label={popupLabel}
                className="outline-none"
              >
                <SurfaceProvider value={level}>
                  <ColorPicker
                    {...pickerProps}
                    size={size}
                    value={currentValue}
                    onValueChange={handleValueChange}
                    className={cn(surfaceClasses(level, 3), pickerProps.className)}
                  />
                </SurfaceProvider>
              </Popover.Popup>
            </motion.div>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    );

    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
  },
);

ColorPickerPopover.displayName = 'ColorPickerPopover';

// ─── Exports ─────────────────────────────────────────────────────────────────

export type {
  ColorPickerLabels,
  ColorPickerPopoverProps,
  ColorPickerProps,
  ColorPickerSwatch,
  ColorSwatchProps,
  ColorTileProps,
  ParsedColor,
};
export { buildParsed, ColorPicker, ColorPickerPopover, ColorSwatch, ColorTile, parseColor };
