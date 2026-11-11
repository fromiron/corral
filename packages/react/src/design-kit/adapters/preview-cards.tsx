'use client';

import { motion, useReducedMotion } from 'motion/react';
import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DrawnCheck } from '../components/agent/agent-primitives.tsx';
import { FluidHoverHighlight } from '../components/ui/fluid-hover-highlight.tsx';
import { useFluidHover, useRegisterFluidHoverItem } from '../hooks/use-fluid-hover.ts';
import { focusRing } from '../lib/focus.ts';
import { fontWeights } from '../lib/font-weight.ts';
import { useShape } from '../lib/shape-context.tsx';
import { spring } from '../lib/springs.ts';
import { useSurface } from '../lib/surface-context.tsx';
import { cn } from './utils.ts';

// -----------------------------------------------------------------------------
// One choice among cards that each show a picture of the option above its name
// (a theme's preview). The supplied kit has no such contract: RadioGroup lists
// rows, CardGroup has no selection, so this composes them. From RadioGroup:
// one tab stop, arrow keys and Home/End that move and select at once, a muted
// name that turns foreground on hover and semibold when chosen, and a shared
// selection that springs from option to option. From CardGroup: grids with one
// fluid hover highlight each. From ColorSwatch: the chosen mark, a 2px gap and
// a 2px --emphasis ring around the picture. A check draws itself on the chosen
// card. Reduced motion keeps the fades and drops the travel.
// -----------------------------------------------------------------------------

/** The ring's gap and width, in px, around the picture (ColorSwatch's 2 + 2). */
const RING_OUTSET = 4;

interface GroupContextValue {
  value: string;
  select: (value: string) => void;
  registerMedia: (index: number, element: HTMLElement | null) => void;
  /** The chosen card reports its index; the ring reads it. */
  setChosen: (index: number | null) => void;
  hasChoice: (value: string) => boolean;
}

const GroupContext = createContext<GroupContextValue | null>(null);
const GridContext = createContext<((index: number, element: HTMLElement | null) => void) | null>(
  null,
);

function useGroup() {
  const group = useContext(GroupContext);
  if (!group) throw new Error('PreviewCard must be used within a PreviewCardGroup');
  return group;
}

interface PreviewCardGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Every option's value, so the group knows whether one is chosen (the first
   *  card takes the tab stop when none is). */
  values: readonly string[];
  children: ReactNode;
}

function PreviewCardGroup({
  value,
  onValueChange,
  values,
  className,
  children,
  ...props
}: PreviewCardGroupProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Registry only: the pictures' rects, in the group's coordinates, for the ring.
  const media = useFluidHover(ref);
  const [chosen, setChosen] = useState<number | null>(null);
  const reduce = useReducedMotion() ?? false;
  const shape = useShape();
  const surface = useSurface();
  const known = useMemo(() => new Set(values), [values]);
  const hasChoice = useCallback((each: string) => known.has(each), [known]);
  const context = useMemo<GroupContextValue>(
    () => ({
      value,
      select: onValueChange,
      registerMedia: media.registerItem,
      setChosen,
      hasChoice,
    }),
    [value, onValueChange, media.registerItem, hasChoice],
  );
  const rect = chosen === null ? null : (media.itemRects[chosen] ?? null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    props.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const radios = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[data-preview-card-radio]') ?? [],
    );
    const current = radios.indexOf(event.target as HTMLElement);
    if (current === -1) return;
    let next: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
      next = (current + 1) % radios.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
      next = (current - 1 + radios.length) % radios.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = radios.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = radios[next];
    // Moves and chooses, like native radios; the card's own click does the choosing.
    target?.focus();
    target?.click();
  }

  return (
    <GroupContext.Provider value={context}>
      <div
        ref={ref}
        role="radiogroup"
        {...props}
        onKeyDown={onKeyDown}
        className={cn('relative flex min-w-0 flex-col', className)}
      >
        {children}
        {rect ? (
          <motion.div
            aria-hidden
            data-preview-card-ring
            className={cn(
              'pointer-events-none absolute top-0 left-0 z-20 border-2 border-emphasis',
              shape.container,
            )}
            initial={false}
            animate={{
              x: rect.left - RING_OUTSET,
              y: rect.top - RING_OUTSET,
              width: rect.width + RING_OUTSET * 2,
              height: rect.height + RING_OUTSET * 2,
            }}
            transition={reduce ? { duration: 0 } : spring.moderate}
          >
            <span
              className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-emphasis text-background"
              // The ring of the surface the cards sit on keeps the badge apart from the picture.
              style={{ boxShadow: `0 0 0 2px var(--surface-${surface})` }}
            >
              <DrawnCheck key={value} size={12} strokeWidth={3} />
            </span>
          </motion.div>
        ) : null}
      </div>
    </GroupContext.Provider>
  );
}

/** A grid of cards with its own fluid hover highlight (auto-fill columns). */
function PreviewCardGrid({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  // Gaps stay inert: a press between cards (or on a heading nearby) chooses nothing.
  const hover = useFluidHover(ref, { axis: 'xy', gapClick: false });
  const shape = useShape();
  return (
    <GridContext.Provider value={hover.registerItem}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: The pointer only moves the hover highlight; the cards inside are the controls. */}
      <div
        ref={ref}
        {...props}
        onMouseEnter={hover.handlers.onMouseEnter}
        onMouseMove={hover.handlers.onMouseMove}
        onMouseLeave={hover.handlers.onMouseLeave}
        className={cn(
          'relative grid grid-cols-[repeat(auto-fill,minmax(min(9.5rem,100%),1fr))] gap-x-2 gap-y-3',
          className,
        )}
      >
        <FluidHoverHighlight hover={hover} className={cn('z-0', shape.container)} />
        {children}
      </div>
    </GridContext.Provider>
  );
}

/** The card's name: muted until hovered or chosen, semibold when chosen, never reflowing. */
function CardName({ children, chosen }: { children: string; chosen: boolean }) {
  return (
    <span className="inline-grid min-w-0 text-body">
      <span
        aria-hidden
        className="invisible col-start-1 row-start-1 line-clamp-2 break-words"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {children}
      </span>
      <span
        className={cn(
          'col-start-1 row-start-1 line-clamp-2 break-words transition-[color,font-variation-settings] duration-80',
          chosen
            ? 'text-foreground'
            : 'text-muted-foreground group-hover/preview:text-foreground group-data-[fluid-hover-active]/preview:text-foreground',
        )}
        style={{ fontVariationSettings: chosen ? fontWeights.semibold : fontWeights.normal }}
      >
        {children}
      </span>
    </span>
  );
}

interface PreviewCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  value: string;
  /** 0-based, in render order across the whole group. */
  index: number;
  /** The name under the picture, and the option's accessible name. */
  label: string;
  /** The picture, drawn into a 16:10 frame. */
  preview: ReactNode;
  /** A control at the end of the name row (a card menu): shown on hover and
   *  focus, always on touch. It is the card's sibling, never inside the radio. */
  action?: ReactNode;
}

function PreviewCard({
  value,
  index,
  label,
  preview,
  action,
  className,
  ...props
}: PreviewCardProps) {
  const group = useGroup();
  const registerHover = useContext(GridContext) ?? undefined;
  const card = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLDivElement>(null);
  const shape = useShape();
  const chosen = group.value === value;
  useRegisterFluidHoverItem(registerHover, index, card);
  useRegisterFluidHoverItem(group.registerMedia, index, media);
  const { setChosen } = group;
  useLayoutEffect(() => {
    if (!chosen) return;
    setChosen(index);
    return () => setChosen(null);
  }, [chosen, index, setChosen]);
  // Roving tab stop: the chosen card, else the first.
  const tabbable = chosen || (index === 0 && !group.hasChoice(group.value));

  return (
    <div
      ref={card}
      data-fluid-hover-index={index}
      {...props}
      className={cn('group/preview relative z-10 min-w-0', className)}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: A native radio cannot hold the picture; the card owns the checked state and the group the keys. */}
      <div
        role="radio"
        aria-checked={chosen}
        aria-label={label}
        tabIndex={tabbable ? 0 : -1}
        data-preview-card-radio
        data-value={value}
        onClick={() => group.select(value)}
        onKeyDown={(event) => {
          // preventDefault keeps Space from scrolling the page.
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            group.select(value);
          }
        }}
        className={cn(
          'flex min-w-0 cursor-pointer flex-col gap-1.5 p-1',
          shape.container,
          focusRing,
        )}
      >
        <div
          ref={media}
          data-preview-card-media
          className={cn('relative aspect-[16/10] w-full overflow-hidden', shape.bg)}
        >
          {preview}
          {/* A hairline in the page's border role keeps a picture as pale as the page apart. */}
          <span
            aria-hidden
            className={cn('pointer-events-none absolute inset-0 border border-border', shape.bg)}
          />
        </div>
        <span className={cn('flex min-h-7 items-center px-1', action ? 'pr-8' : null)}>
          <CardName chosen={chosen}>{label}</CardName>
        </span>
      </div>
      {action ? (
        <div className="absolute right-1 bottom-1 z-30 flex opacity-0 transition-opacity duration-80 group-focus-within/preview:opacity-100 group-hover/preview:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100">
          {action}
        </div>
      ) : null}
    </div>
  );
}

interface PreviewCardButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Unique within its grid, after the cards (it joins the grid's hover). */
  index: number;
  label: string;
  /** Drawn in a dashed 16:10 frame where a card has its picture. */
  icon: ReactNode;
}

/** A tile in a card grid that is an action, not an option (a "new" tile). */
function PreviewCardButton({ index, label, icon, className, ...props }: PreviewCardButtonProps) {
  const registerHover = useContext(GridContext) ?? undefined;
  const ref = useRef<HTMLButtonElement>(null);
  const shape = useShape();
  useRegisterFluidHoverItem(registerHover, index, ref);
  return (
    <button
      ref={ref}
      type="button"
      data-fluid-hover-index={index}
      {...props}
      className={cn(
        'group/preview relative z-10 flex min-w-0 cursor-pointer flex-col gap-1.5 p-1 text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
        shape.container,
        focusRing,
        className,
      )}
    >
      <span
        className={cn(
          'flex aspect-[16/10] w-full items-center justify-center border border-dashed border-border text-muted-foreground transition-colors duration-80 group-hover/preview:text-foreground group-aria-disabled/preview:text-muted-foreground',
          shape.bg,
        )}
      >
        {icon}
      </span>
      <span className="flex min-h-7 items-center px-1">
        <span className="line-clamp-2 break-words text-body text-muted-foreground transition-colors duration-80 group-hover/preview:text-foreground group-aria-disabled/preview:text-muted-foreground">
          {label}
        </span>
      </span>
    </button>
  );
}

export {
  PreviewCard,
  PreviewCardButton,
  type PreviewCardButtonProps,
  PreviewCardGrid,
  PreviewCardGroup,
  type PreviewCardGroupProps,
  type PreviewCardProps,
};
