'use client';

import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// SSR-safe layout effect.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { omit } from '../../lib/omit.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';

// ─── Contexts ────────────────────────────────────────────────────────────────

interface ItemRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface AccordionGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  registerFullItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  grouped: true;
  remeasure: () => void;
  openValues: Set<string>;
  openItemRects: Map<number, ItemRect>;
}

const AccordionGroupContext = createContext<AccordionGroupContextValue | null>(null);

function useAccordionGroup() {
  return useContext(AccordionGroupContext);
}

interface AccordionItemContextValue {
  index?: number;
  value: string;
  isOpen: boolean;
  triggerRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Standalone items carry the group's choice themselves. */
  highlight: 'trigger' | 'item';
}

const AccordionItemContext = createContext<AccordionItemContextValue | null>(null);

function useAccordionItemContext() {
  const ctx = useContext(AccordionItemContext);
  if (!ctx)
    throw new Error('AccordionTrigger/AccordionContent must be used within an AccordionItem');
  return ctx;
}

// ─── AccordionGroup ──────────────────────────────────────────────────────────

type AccordionGroupSingleProps = {
  type?: 'single';
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  collapsible?: boolean;
};

type AccordionGroupMultipleProps = {
  type: 'multiple';
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
};

type AccordionGroupProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** Pins the rows to one size step (default 36px, compact 28px). Omitted,
   *  they follow the surrounding SizeProvider. */
  size?: SizeVariant;
  /** What an open item tints: "item" fills the row and its panel while open;
   *  "trigger" fills only the row, and only on hover. @default "item" */
  highlight?: 'trigger' | 'item';
} & (AccordionGroupSingleProps | AccordionGroupMultipleProps);

const AccordionGroup = forwardRef<HTMLDivElement, AccordionGroupProps>((props, ref) => {
  const { children, highlight = 'item', type = 'single', size, className, ...rest } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const fullItemElementsRef = useRef<Map<number, HTMLElement>>(new Map());
  const [openItemRects, setOpenItemRects] = useState<Map<number, ItemRect>>(new Map());
  const openItemRectsRef = useRef(openItemRects);

  const hover = useFluidHover(containerRef);
  const { activeIndex, setActiveIndex, itemRects, handlers, registerItem, measureItems } = hover;

  const registerFullItem = useCallback((index: number, element: HTMLElement | null) => {
    if (element) {
      fullItemElementsRef.current.set(index, element);
    } else {
      fullItemElementsRef.current.delete(index);
    }
  }, []);

  const measureFullItems = useCallback(() => {
    if (!containerRef.current) return;
    const next = new Map<number, ItemRect>();
    fullItemElementsRef.current.forEach((el, idx) => {
      next.set(idx, {
        top: el.offsetTop,
        left: el.offsetLeft,
        width: el.offsetWidth,
        height: el.offsetHeight,
      });
    });
    // Runs every animation frame; skip no-op updates so the group context
    // doesn't re-render every item.
    const prev = openItemRectsRef.current;
    let changed = prev.size !== next.size;
    if (!changed) {
      for (const [idx, r] of next) {
        const p = prev.get(idx);
        if (
          !p ||
          p.top !== r.top ||
          p.left !== r.left ||
          p.width !== r.width ||
          p.height !== r.height
        ) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    openItemRectsRef.current = next;
    setOpenItemRects(next);
  }, []);

  const [internalSingleValue, setInternalSingleValue] = useState<string>(() => {
    if (type === 'single') {
      const sp = props as AccordionGroupSingleProps;
      return sp.defaultValue ?? '';
    }
    return '';
  });
  const [internalMultipleValue, setInternalMultipleValue] = useState<string[]>(() => {
    if (type === 'multiple') {
      const mp = props as AccordionGroupMultipleProps;
      return mp.defaultValue ?? [];
    }
    return [];
  });
  const singleOnValueChange = (props as AccordionGroupSingleProps).onValueChange;
  const multipleOnValueChange = (props as AccordionGroupMultipleProps).onValueChange;

  const openValuesList: string[] =
    type === 'multiple'
      ? ((props as AccordionGroupMultipleProps).value ?? internalMultipleValue)
      : (() => {
          const v = (props as AccordionGroupSingleProps).value ?? internalSingleValue;
          return v ? [v] : [];
        })();

  // Serialized so the Set (and the group context) keeps its identity while
  // the open values are unchanged.
  const openValuesKey = JSON.stringify(openValuesList);

  const openValues = useMemo(() => new Set(JSON.parse(openValuesKey) as string[]), [openValuesKey]);

  const handleSingleValueChange = useCallback(
    (value: string) => {
      if (singleOnValueChange) singleOnValueChange(value);
      else setInternalSingleValue(value);
    },
    [singleOnValueChange],
  );

  const handleMultipleValueChange = useCallback(
    (value: string[]) => {
      if (multipleOnValueChange) multipleOnValueChange(value);
      else setInternalMultipleValue(value);
    },
    [multipleOnValueChange],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Children changes require remeasuring the source kit's shared highlight geometry.
  useEffect(() => {
    measureItems();
    measureFullItems();
  }, [measureItems, measureFullItems, children]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Open-state changes require remeasuring the expanded item geometry.
  useEffect(() => {
    measureItems();
    measureFullItems();
  }, [measureItems, measureFullItems, openValuesKey]);

  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
  // "item" tints the whole open item; "trigger" tints an open row only
  // while it's hovered, since the panel already shows it's open.
  const expandedRects =
    highlight === 'item'
      ? openItemRects
      : new Map(
          [...openItemRects.keys()].flatMap((idx) => {
            const rect = idx === activeIndex ? itemRects[idx] : null;
            return rect ? ([[idx, rect]] as [number, ItemRect][]) : [];
          }),
        );

  const isHoveringNonOpen = activeIndex !== null && !openItemRects.has(activeIndex);
  const shape = useShape();

  const htmlProps = omit(rest as Record<string, unknown>, [
    'value',
    'defaultValue',
    'onValueChange',
    'collapsible',
    'type',
  ]);

  // Base UI takes `value: string[]` plus `multiple`; single mode wraps its
  // value in an array.
  const baseValue: string[] =
    type === 'multiple'
      ? ((props as AccordionGroupMultipleProps).value ?? internalMultipleValue)
      : (() => {
          const v = (props as AccordionGroupSingleProps).value ?? internalSingleValue;
          return v ? [v] : [];
        })();

  const baseOnValueChange = (next: string[]) => {
    if (type === 'multiple') handleMultipleValueChange(next);
    else handleSingleValueChange(next[0] ?? '');
  };

  const remeasure = useCallback(() => {
    measureItems();
    measureFullItems();
  }, [measureItems, measureFullItems]);

  // Memoized: the group re-renders on every hover mousemove.
  const groupContextValue = useMemo<AccordionGroupContextValue>(
    () => ({
      registerItem,
      registerFullItem,
      activeIndex,
      grouped: true,
      remeasure,
      openValues,
      openItemRects,
    }),
    [registerItem, registerFullItem, activeIndex, remeasure, openValues, openItemRects],
  );

  const group = (
    <AccordionGroupContext.Provider value={groupContextValue}>
      <AccordionPrimitive.Root
        value={baseValue}
        onValueChange={baseOnValueChange}
        multiple={type === 'multiple'}
        render={(rootProps) => {
          const restRoot = omit(rootProps as React.HTMLAttributes<HTMLDivElement>, [
            'style',
            'onDrag',
            'onDragStart',
            'onDragEnd',
            'onAnimationStart',
            'onAnimationEnd',
            'onAnimationIteration',
          ]);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: The wrapper tracks hover/focus geometry; Base UI triggers own all actions.
            <div
              {...restRoot}
              ref={(node) => {
                (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
                if (typeof ref === 'function') ref(node);
                else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
              }}
              onMouseEnter={handlers.onMouseEnter}
              onMouseMove={(e) => {
                const container = containerRef.current;
                if (container) {
                  const cRect = container.getBoundingClientRect();
                  const layoutH = container.offsetHeight;
                  const visualH = cRect.height;
                  const scale = layoutH > 0 ? visualH / layoutH : 1;
                  const localY = (e.clientY - cRect.top) / scale + container.scrollTop;
                  for (const [idx, full] of openItemRects) {
                    const trigger = itemRects[idx];
                    if (!trigger) continue;
                    const contentTop = trigger.top + trigger.height;
                    const contentBottom = full.top + full.height;
                    if (localY >= contentTop && localY <= contentBottom) {
                      setActiveIndex(null);
                      return;
                    }
                  }
                }
                handlers.onMouseMove(e);
              }}
              onMouseLeave={handlers.onMouseLeave}
              onFocus={(e) => {
                const indexAttr = (e.target as HTMLElement)
                  .closest('[data-fluid-hover-index]')
                  ?.getAttribute('data-fluid-hover-index');
                if (indexAttr != null) {
                  const idx = Number(indexAttr);
                  setActiveIndex(idx);
                  setFocusedIndex((e.target as HTMLElement).matches(':focus-visible') ? idx : null);
                }
              }}
              onBlur={(e) => {
                if (containerRef.current?.contains(e.relatedTarget as Node)) return;
                setFocusedIndex(null);
                setActiveIndex(null);
              }}
              className={cn('relative flex flex-col w-72 max-w-full', className)}
              {...(htmlProps as HTMLAttributes<HTMLDivElement>)}
            >
              {/* Expanded item backgrounds */}
              <AnimatePresence>
                {[...expandedRects.entries()].map(([idx, rect]) => (
                  <motion.div
                    key={`expanded-${idx}`}
                    className={`absolute ${shape.bg} bg-accent/20 dark:bg-accent/12 pointer-events-none`}
                    // Fade in instead of popping in at full opacity while the
                    // previous item's bg fades out. Geometry snaps (duration 0)
                    // so the bg hugs the animating item.
                    initial={{
                      top: rect.top,
                      left: rect.left,
                      width: rect.width,
                      height: rect.height,
                      opacity: 0,
                    }}
                    animate={{
                      top: rect.top,
                      left: rect.left,
                      width: rect.width,
                      height: rect.height,
                      opacity: isHoveringNonOpen ? 0.7 : 1,
                    }}
                    exit={{ opacity: 0, transition: spring.moderate.exit }}
                    transition={{
                      top: { duration: 0 },
                      left: { duration: 0 },
                      width: { duration: 0 },
                      height: { duration: 0 },
                      opacity: { duration: 0.12 },
                    }}
                  />
                ))}
              </AnimatePresence>

              {/* Hover background */}
              <FluidHoverHighlight hover={hover} className={shape.bg} />

              {/* Focus ring */}
              <AnimatePresence>
                {focusRect && (
                  <motion.div
                    className={`absolute ${shape.focusRing} pointer-events-none z-20 border border-[color:var(--focus-ring,#6B97FF)]`}
                    initial={false}
                    animate={{
                      left: focusRect.left - 2,
                      top: focusRect.top - 2,
                      width: focusRect.width + 4,
                      height: focusRect.height + 4,
                    }}
                    exit={{ opacity: 0, transition: spring.fast.exit }}
                    transition={{
                      ...spring.fast,
                      opacity: { duration: 0.08 },
                    }}
                  />
                )}
              </AnimatePresence>

              {children}
            </div>
          );
        }}
      />
    </AccordionGroupContext.Provider>
  );

  return size ? <SizeProvider size={size}>{group}</SizeProvider> : group;
});

AccordionGroup.displayName = 'AccordionGroup';

// ─── Accordion (Standalone) ──────────────────────────────────────────────────

interface AccordionProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  type?: 'single' | 'multiple';
  collapsible?: boolean;
  defaultValue?: string | string[];
  value?: string | string[];
  onValueChange?: ((value: string) => void) | ((value: string[]) => void);
  /** Pins the rows to one size step (default 36px, compact 28px). Omitted,
   *  they follow the surrounding SizeProvider. */
  size?: SizeVariant;
}

const Accordion = forwardRef<HTMLDivElement, AccordionProps>(
  (
    {
      children,
      type = 'single',
      collapsible = true,
      defaultValue,
      value,
      onValueChange,
      size,
      className,
      ...props
    },
    ref,
  ) => {
    void collapsible; // Base UI's single-mode is always collapsible.

    const [internalSingleValue, setInternalSingleValue] = useState<string>(() => {
      if (type === 'single') {
        return (defaultValue as string) ?? '';
      }
      return '';
    });
    const [internalMultipleValue, setInternalMultipleValue] = useState<string[]>(() => {
      if (type === 'multiple') {
        return (defaultValue as string[]) ?? [];
      }
      return [];
    });

    const openValues = new Set<string>(
      type === 'multiple'
        ? ((value as string[] | undefined) ?? internalMultipleValue)
        : (() => {
            const v = (value as string | undefined) ?? internalSingleValue;
            return v ? [v] : [];
          })(),
    );

    const handleSingleChange = useCallback(
      (v: string) => {
        if (onValueChange) (onValueChange as (v: string) => void)(v);
        else setInternalSingleValue(v);
      },
      [onValueChange],
    );

    const handleMultipleChange = useCallback(
      (v: string[]) => {
        if (onValueChange) (onValueChange as (v: string[]) => void)(v);
        else setInternalMultipleValue(v);
      },
      [onValueChange],
    );

    const baseValue: string[] =
      type === 'multiple'
        ? ((value as string[] | undefined) ?? internalMultipleValue)
        : (() => {
            const v = (value as string | undefined) ?? internalSingleValue;
            return v ? [v] : [];
          })();

    const baseOnValueChange = (next: string[]) => {
      if (type === 'multiple') handleMultipleChange(next);
      else handleSingleChange(next[0] ?? '');
    };

    const root = (
      <AccordionPrimitive.Root
        value={baseValue}
        onValueChange={baseOnValueChange}
        multiple={type === 'multiple'}
        render={(rootProps) => {
          const restRoot = omit(rootProps as React.HTMLAttributes<HTMLDivElement>, ['style']);
          return (
            <div
              {...restRoot}
              ref={ref}
              className={cn('w-72 max-w-full flex flex-col', className)}
              {...props}
            >
              <StandaloneOpenContext.Provider value={openValues}>
                {children}
              </StandaloneOpenContext.Provider>
            </div>
          );
        }}
      />
    );

    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
  },
);

Accordion.displayName = 'Accordion';

const StandaloneOpenContext = createContext<Set<string>>(new Set());

// ─── AccordionItem ───────────────────────────────────────────────────────────

interface AccordionItemProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  index?: number;
  disabled?: boolean;
  /** What an open item tints (see AccordionGroup). Ignored inside a group.
   *  @default "item" */
  highlight?: 'trigger' | 'item';
  children: ReactNode;
}

const AccordionItem = forwardRef<HTMLDivElement, AccordionItemProps>(
  ({ value, index, disabled, highlight = 'item', children, className, ...props }, ref) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const groupCtx = useAccordionGroup();
    const standaloneOpen = useContext(StandaloneOpenContext);
    const shape = useShape();

    const isOpen = groupCtx?.grouped ? groupCtx.openValues.has(value) : standaloneOpen.has(value);

    const triggerRef = useRef<HTMLDivElement>(null);

    useRegisterFluidHoverItem(
      groupCtx?.grouped ? groupCtx.registerItem : undefined,
      index,
      triggerRef,
    );

    useEffect(() => {
      if (groupCtx?.grouped && index !== undefined) {
        if (isOpen) {
          groupCtx.registerFullItem(index, internalRef.current);
        } else {
          groupCtx.registerFullItem(index, null);
        }
        return () => groupCtx.registerFullItem(index, null);
      }
    }, [index, groupCtx, isOpen]);

    return (
      <AccordionItemContext.Provider value={{ index, value, isOpen, triggerRef, highlight }}>
        <AccordionPrimitive.Item
          value={value}
          disabled={disabled}
          render={(itemProps) => {
            const restItem = omit(itemProps as React.HTMLAttributes<HTMLDivElement>, ['style']);
            return (
              <div
                {...restItem}
                ref={(node) => {
                  (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
                  if (typeof ref === 'function') ref(node);
                  else if (ref)
                    (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
                }}
                data-fluid-hover-index={index}
                className={cn(!groupCtx?.grouped && 'relative', className)}
                {...props}
              >
                {/* Standalone open tint; for highlight="trigger" it lives in
                    AccordionTrigger instead. */}
                {!groupCtx?.grouped && highlight === 'item' && (
                  <AnimatePresence>
                    {isOpen && (
                      <motion.div
                        className={`absolute inset-0 ${shape.bg} bg-accent/20 dark:bg-accent/12 pointer-events-none`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, transition: spring.moderate.exit }}
                        transition={{ duration: 0.12 }}
                      />
                    )}
                  </AnimatePresence>
                )}
                {children}
              </div>
            );
          }}
        />
      </AccordionItemContext.Provider>
    );
  },
);

AccordionItem.displayName = 'AccordionItem';

// ─── AccordionTrigger ────────────────────────────────────────────────────────

interface AccordionTriggerProps extends HTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

const AccordionTrigger = forwardRef<HTMLButtonElement, AccordionTriggerProps>(
  ({ children, className, ...props }, ref) => {
    const icons = useIcons();
    const ChevronRight = icons['chevron-right'];
    const groupCtx = useAccordionGroup();
    const { index, isOpen, triggerRef, highlight } = useAccordionItemContext();
    const shape = useShape();
    const sizeClasses = useSize();
    const [isHovered, setIsHovered] = useState(false);

    const isActive = groupCtx?.grouped ? groupCtx.activeIndex === index : isHovered;

    const triggerContent = (
      // Header renders a <div>: the default <h3> breaks the ancestor
      // selectors the styles rely on.
      <AccordionPrimitive.Header render={<div />}>
        <AccordionPrimitive.Trigger
          ref={ref as React.Ref<HTMLElement>}
          className={cn(
            `relative z-10 flex items-center ${sizeClasses.gap} ${shape.item} ${sizeClasses.px} ${sizeClasses.variant === 'compact' ? 'py-1' : 'py-2'} w-full cursor-pointer outline-none select-none`,
            !groupCtx?.grouped &&
              'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] focus-visible:ring-offset-0',
            className,
          )}
          {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        >
          {/* Invisible semibold copy reserves the width, so the weight
              change doesn't shift layout */}
          <span className={cn('inline-grid flex-1 text-left', sizeClasses.text)}>
            <span
              className="col-start-1 row-start-1 invisible"
              style={{ fontVariationSettings: fontWeights.semibold }}
              aria-hidden="true"
            >
              {children}
            </span>
            <span
              className={cn(
                'col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80',
                isOpen || isActive ? 'text-foreground' : 'text-muted-foreground',
              )}
              style={{
                fontVariationSettings: isOpen ? fontWeights.semibold : fontWeights.normal,
              }}
            >
              {children}
            </span>
          </span>

          <motion.span
            className="shrink-0 inline-flex items-center justify-center"
            animate={{ rotate: isOpen ? 90 : 0 }}
            transition={spring.fast}
          >
            <ChevronRight
              size={sizeClasses.icon}
              strokeWidth={isOpen || isActive ? 2 : 1.5}
              className={cn(
                'transition-[color,stroke-width] duration-80',
                isOpen || isActive ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
          </motion.span>
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
    );

    if (groupCtx?.grouped) {
      return <div ref={triggerRef}>{triggerContent}</div>;
    }

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Pointer handlers only track the trigger's decorative hover background.
      <div
        className="relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Open tint scoped to this row; the panel keeps the page surface. */}
        <AnimatePresence>
          {isOpen && highlight === 'trigger' && isHovered && (
            <motion.div
              className={`absolute inset-0 ${shape.bg} bg-accent/20 dark:bg-accent/12 pointer-events-none`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              // Moderate tier: it marks a state, unlike the fast hover fill.
              exit={{ opacity: 0, transition: spring.moderate.exit }}
              transition={{ duration: 0.12 }}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {isHovered && (
            <motion.div
              className={`absolute inset-0 ${shape.bg} bg-hover pointer-events-none`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: spring.fast.exit }}
              transition={{ duration: 0.08 }}
            />
          )}
        </AnimatePresence>
        {triggerContent}
      </div>
    );
  },
);

AccordionTrigger.displayName = 'AccordionTrigger';

// ─── AccordionContent ────────────────────────────────────────────────────────

interface AccordionContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

const AccordionContent = forwardRef<HTMLDivElement, AccordionContentProps>(
  ({ children, className, ...props }, ref) => {
    const groupCtx = useAccordionGroup();
    const { isOpen } = useAccordionItemContext();
    const sizeClasses = useSize();
    // Read here, not from a MotionConfig the app may lack: height is
    // positional, so Motion would animate it even under reduced motion.
    const reduceMotion = useReducedMotion() ?? false;

    // Animate to a measured layout height, not "auto": Motion measures
    // "auto" visually, so under a scaled ancestor it overshoots and snaps
    // back. offsetHeight and ResizeObserver ignore transforms.
    const innerRef = useRef<HTMLDivElement | null>(null);
    const roRef = useRef<ResizeObserver | null>(null);
    const [contentHeight, setContentHeight] = useState<number | null>(null);
    // Height springs only when this panel toggles. Content-height changes
    // (e.g. a nested collapsible) snap, or the spring would chase the
    // child's animation and lag. The mount-time "auto" → pixel hand-off
    // snaps too.
    const [prevOpen, setPrevOpen] = useState(isOpen);
    const [toggling, setToggling] = useState(false);
    if (prevOpen !== isOpen) {
      setPrevOpen(isOpen);
      setToggling(true);
    }

    const measureRef = useCallback((el: HTMLDivElement | null) => {
      roRef.current?.disconnect();
      roRef.current = null;
      innerRef.current = el;
      if (!el) return;
      if (el.offsetHeight > 0) setContentHeight(el.offsetHeight);
      const ro = new ResizeObserver(() => {
        // Ignore the 0 that fires while the panel is display:none.
        if (el.offsetHeight > 0) setContentHeight(el.offsetHeight);
      });
      ro.observe(el);
      roRef.current = ro;
    }, []);

    // Re-measure pre-paint on open so the spring targets a fresh height.
    useIsoLayoutEffect(() => {
      if (isOpen && innerRef.current && innerRef.current.offsetHeight > 0) {
        setContentHeight(innerRef.current.offsetHeight);
      }
    }, [isOpen]);

    // Base UI's Panel sets `hidden` as soon as it closes (it sees no CSS
    // animation), which would freeze the exit mid-flight. We own `hidden`
    // and apply it once the Motion exit completes.
    const [exitComplete, setExitComplete] = useState(!isOpen);
    if (isOpen && exitComplete) {
      // Reset during render so the opening's first paint is visible.
      setExitComplete(false);
    }

    // keepMounted keeps the panel (role="region" and the id the Trigger's
    // aria-controls points to) through the exit; the height animation lives
    // inside it, with content mounted so it can be measured.
    return (
      <AccordionPrimitive.Panel
        keepMounted
        render={(panelProps) => {
          const restPanel = omit(panelProps as React.HTMLAttributes<HTMLDivElement>, [
            // Set too early for the exit animation; applied below instead.
            'hidden',
            // Only --accordion-panel-height/width, which stay 'auto' here.
            'style',
          ]);
          return (
            <div {...restPanel} hidden={!isOpen && exitComplete}>
              <motion.div
                ref={ref}
                className={cn('overflow-hidden', className)}
                initial={{ height: isOpen ? 'auto' : 0 }}
                animate={{ height: isOpen ? (contentHeight ?? 0) : 0, opacity: isOpen ? 1 : 0 }}
                // spring.fast lands with the chevron (bounce 0, so height
                // can't overshoot); a close takes the quicker exit tier.
                // Opacity leads the height so the body dissolves instead of
                // being sliced by the clip edge.
                transition={
                  reduceMotion || !toggling
                    ? { duration: 0 }
                    : isOpen
                      ? { ...spring.fast, opacity: { duration: 0.06 } }
                      : { ...spring.fast.exit, opacity: { duration: 0.04 } }
                }
                onUpdate={() => {
                  groupCtx?.remeasure();
                }}
                onAnimationComplete={() => {
                  setToggling(false);
                  groupCtx?.remeasure();
                  if (!isOpen) setExitComplete(true);
                }}
                // biome-ignore lint/suspicious/noExplicitAny: Preserve the source kit's DOM prop forwarding across Motion's conflicting event types.
                {...(props as any)}
              >
                <div
                  ref={measureRef}
                  className={cn(
                    'pt-1 text-muted-foreground',
                    sizeClasses.px,
                    sizeClasses.text,
                    sizeClasses.variant === 'compact' ? 'pb-2.5' : 'pb-3',
                  )}
                >
                  {children}
                </div>
              </motion.div>
            </div>
          );
        }}
      />
    );
  },
);

AccordionContent.displayName = 'AccordionContent';

export { Accordion, AccordionContent, AccordionGroup, AccordionItem, AccordionTrigger };
export default Accordion;
