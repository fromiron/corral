'use client';

// Size density: the 36px default step or the 28px compact one. SizeProvider
// is optional — without it every component uses "default".

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import {
  fieldTouchClass,
  type TypeScalePair,
  type TypeScaleRole,
  type TypeScaleStep,
  typeClass,
  typeClasses,
  typeScale,
  typeStyles,
} from './type-scale.ts';

type SizeVariant = 'default' | 'compact';

interface SizeClasses {
  variant: SizeVariant;
  /** Height of bounded controls AND list/menu rows, so a popup row lines up
   *  with the trigger that opened it. */
  control: string;
  /** `control` in px. */
  controlHeight: number;
  /** Tab height in a segmented list; `segmentPad` + `segmentItem` = `control`. */
  segmentItem: string;
  /** Padding of the segmented list around its tabs. */
  segmentPad: string;
  /** Body text inside controls (size + line height), same as `type.body`. */
  text: string;
  /** `text` for editable fields, bumped to 16px on touch screens so iOS
   *  Safari doesn't zoom into the focused field. */
  field: string;
  /** One class string per type role at this step (size + leading). */
  type: Record<TypeScaleRole, string>;
  /** Horizontal padding of bounded controls (select trigger, inputs). */
  px: string;
  /** Horizontal padding of list/menu rows inside a padded popup or group. */
  itemPx: string;
  /** Gap between a glyph and its label, and between neighbouring controls. */
  gap: string;
  /** Glyph size in px, including the checkbox square / radio circle. */
  icon: number;
}

const sizeMap: Record<SizeVariant, SizeClasses> = {
  // 36px controls.
  default: {
    variant: 'default',
    control: 'h-9',
    controlHeight: 36,
    segmentItem: 'h-7',
    segmentPad: 'p-1',
    text: typeClasses.default.body,
    field: `${typeClasses.default.body} ${fieldTouchClass}`,
    type: typeClasses.default,
    px: 'px-3',
    itemPx: 'px-2',
    gap: 'gap-2',
    icon: 16,
  },
  // 28px controls for dense surfaces (toolbars, filter bars, sidebars); text
  // and icons step down too.
  compact: {
    variant: 'compact',
    control: 'h-7',
    controlHeight: 28,
    segmentItem: 'h-6',
    segmentPad: 'p-0.5',
    text: typeClasses.compact.body,
    field: `${typeClasses.compact.body} ${fieldTouchClass}`,
    type: typeClasses.compact,
    px: 'px-2.5',
    itemPx: 'px-1.5',
    gap: 'gap-1',
    icon: 14,
  },
};

/** Font size in px per type role for the active size step:
 *  explicit override > provider > "default". */
function useTypeScale(override?: SizeVariant | null): Record<TypeScaleRole, number> {
  const variant = useSizeVariant(override);
  return {
    display: typeScale.display[variant],
    title: typeScale.title[variant],
    subtitle: typeScale.subtitle[variant],
    body: typeScale.body[variant],
    caption: typeScale.caption[variant],
    micro: typeScale.micro[variant],
  };
}

interface SizeContextValue {
  size: SizeVariant;
  setSize: (size: SizeVariant) => void;
  classes: SizeClasses;
}

const SizeContext = createContext<SizeContextValue | null>(null);

/** Resolve the active size variant: explicit prop > provider > "default". */
function useSizeVariant(override?: SizeVariant | null): SizeVariant {
  const ctx = useContext(SizeContext);
  return override ?? ctx?.size ?? 'default';
}

/** Resolve size classes: explicit prop > provider > "default". */
function useSize(override?: SizeVariant | null): SizeClasses {
  return sizeMap[useSizeVariant(override)];
}

function useSizeContext() {
  const ctx = useContext(SizeContext);
  if (!ctx) throw new Error('useSizeContext must be used within a SizeProvider');
  return ctx;
}

function SizeProvider({
  children,
  size,
  defaultSize = 'default',
}: {
  children: ReactNode;
  /** Controlled variant — pins a region to one size (e.g. a compact filter bar). */
  size?: SizeVariant;
  defaultSize?: SizeVariant;
}) {
  const [internalSize, setInternalSize] = useState<SizeVariant>(defaultSize);
  const isControlled = size !== undefined;
  const resolved = size ?? internalSize;

  // Controlled providers ignore setSize, so removing the prop later doesn't
  // reveal a stale internal value.
  const setSize = useCallback(
    (next: SizeVariant) => {
      if (isControlled) return;
      setInternalSize(next);
    },
    [isControlled],
  );

  const value = useMemo(
    () => ({ size: resolved, setSize, classes: sizeMap[resolved] }),
    [resolved, setSize],
  );

  return <SizeContext.Provider value={value}>{children}</SizeContext.Provider>;
}

export type { SizeClasses, SizeVariant, TypeScalePair, TypeScaleRole, TypeScaleStep };
export {
  fieldTouchClass,
  SizeProvider,
  sizeMap,
  typeClass,
  typeClasses,
  typeScale,
  typeStyles,
  useSize,
  useSizeContext,
  useSizeVariant,
  useTypeScale,
};
