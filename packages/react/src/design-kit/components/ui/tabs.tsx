'use client';

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { AnimatePresence, motion } from 'motion/react';
import {
  Children,
  type ComponentPropsWithoutRef,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useFluidHover } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import type { IconComponent } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { surfaceClasses } from '../../lib/surface-classes.ts';
import { useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';

// ---------------------------------------------------------------------------
// Tabs is a segmented control. The selected pill, hover pill and focus ring
// are absolutely positioned layers that travel across the tab rects measured
// by useFluidHover; the tabs themselves stay transparent.
// ---------------------------------------------------------------------------

/* ─────────────────────── Contexts ─────────────────────── */

interface TabsValueOrderContextValue {
  valueOrder: string[];
  setValueOrder: (order: string[]) => void;
  selectedValue: string | undefined;
}

const TabsValueOrderContext = createContext<TabsValueOrderContextValue | null>(null);

interface TabsListContextValue {
  registerTab: (index: number, value: string, el: HTMLElement | null) => void;
  hoveredIndex: number | null;
  selectedValue: string | undefined;
  /** Optimistically set selectedIdx so the indicator moves immediately on click. */
  setOptimisticIdx: (index: number) => void;
}

const TabsListContext = createContext<TabsListContextValue | null>(null);

function useTabsList() {
  const ctx = useContext(TabsListContext);
  if (!ctx) throw new Error('TabItem must be used within a TabsList');
  return ctx;
}

/* ─────────────────────── Tabs (Root) ─────────────────────── */

interface TabsProps
  extends Omit<
    ComponentPropsWithoutRef<typeof TabsPrimitive.Root>,
    'onValueChange' | 'value' | 'defaultValue' | 'onSelect'
  > {
  /** Controlled value (takes precedence over selectedIndex). */
  value?: string;
  /** Called when the active tab changes. */
  onValueChange?: (value: string) => void;
  /** Index-based controlled alternative. */
  selectedIndex?: number;
  /** Called with the new index when the active tab changes. */
  onSelect?: (index: number) => void;
  defaultValue?: string;
  /** Control size (default 36px, compact 28px). Omitted, follows the SizeProvider. */
  size?: SizeVariant;
}

const Tabs = forwardRef<HTMLDivElement, TabsProps>(
  (
    { value, onValueChange, selectedIndex, onSelect, defaultValue, size, children, ...props },
    ref,
  ) => {
    const [valueOrder, setValueOrder] = useState<string[]>([]);
    const [uncontrolledValue, setUncontrolledValue] = useState<string | undefined>(defaultValue);
    // Keep the same array when unchanged so React bails out of the re-render.
    const updateValueOrder = useCallback((order: string[]) => {
      setValueOrder((current) => {
        if (current.length === order.length && current.every((v, i) => v === order[i])) {
          return current;
        }
        return order;
      });
    }, []);

    // value > selectedIndex > uncontrolled state > first tab.
    const resolvedValue =
      value ??
      (selectedIndex != null ? valueOrder[selectedIndex] : (uncontrolledValue ?? valueOrder[0]));

    const handleValueChange = useCallback(
      (newValue: unknown) => {
        const v = newValue as string;
        if (value === undefined && selectedIndex == null) {
          setUncontrolledValue(v);
        }
        onValueChange?.(v);
        if (onSelect) {
          const idx = valueOrder.indexOf(v);
          if (idx !== -1) onSelect(idx);
        }
      },
      [onValueChange, onSelect, valueOrder, value, selectedIndex],
    );

    const root = (
      <TabsValueOrderContext.Provider
        value={{
          valueOrder,
          setValueOrder: updateValueOrder,
          selectedValue: resolvedValue,
        }}
      >
        {/* Always controlled (Base UI warns on undefined → defined). The ""
            sentinel is corrected pre-paint once TabsList reports valueOrder. */}
        <TabsPrimitive.Root
          ref={ref}
          value={resolvedValue ?? ''}
          onValueChange={handleValueChange}
          {...props}
        >
          {children}
        </TabsPrimitive.Root>
      </TabsValueOrderContext.Provider>
    );

    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
  },
);

Tabs.displayName = 'Tabs';

/* ─────────────────────── TabsList ─────────────────────── */

type TabsListProps = ComponentPropsWithoutRef<typeof TabsPrimitive.List>;

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ children, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Pointer-over-list flag: a ref for blur, state for the hover pill's exit.
    const isMouseInside = useRef(false);
    const [mouseInside, setMouseInside] = useState(false);
    const shape = useShape();
    const sizeClasses = useSize();
    const substrate = useSurface();
    // Active pill sits 3 surface levels above its substrate (page 1 → 4).
    const indicatorLevel = Math.min(substrate + 3, 8);
    const valueOrderCtx = useContext(TabsValueOrderContext);

    const values = Children.toArray(children)
      .filter(isValidElement)
      .map((child) => (child.props as { value?: string }).value)
      .filter((v): v is string => typeof v === 'string');
    // Serialized so the effect only re-reports on a real change.
    const valueOrderKey = JSON.stringify(values);
    const setValueOrder = valueOrderCtx?.setValueOrder;

    useLayoutEffect(() => {
      setValueOrder?.(JSON.parse(valueOrderKey) as string[]);
    }, [setValueOrder, valueOrderKey]);

    // axis "x": the nearest tab horizontally wins, so padding never leaves
    // the hover pill without a target.
    const {
      activeIndex: hoveredIndex,
      setActiveIndex: setHoveredIndex,
      itemRects,
      handlers,
      registerItem,
      measureItems,
    } = useFluidHover(containerRef, { axis: 'x' });

    const registerTab = useCallback(
      (index: number, _value: string, el: HTMLElement | null) => {
        registerItem(index, el);
      },
      [registerItem],
    );

    // Resizes are covered by useFluidHover's own ResizeObserver.
    // biome-ignore lint/correctness/useExhaustiveDependencies: Preserve source remeasurement when tab children change.
    useEffect(() => {
      measureItems();
    }, [measureItems, children]);

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        isMouseInside.current = true;
        setMouseInside(true);
        handlers.onMouseMove(e);
      },
      [handlers],
    );

    // Flip the flag before clearing the hover index: the pill's exit reads it.
    const handleMouseLeave = useCallback(() => {
      isMouseInside.current = false;
      setMouseInside(false);
      handlers.onMouseLeave();
    }, [handlers]);

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const selectedValue = valueOrderCtx?.selectedValue;
    const selectedIdx = selectedValue !== undefined ? values.indexOf(selectedValue) : -1;

    // The pills follow optimisticIdx: a click moves them before controlled
    // state round-trips, and it resyncs during render when selection changes.
    const [optimisticIdx, setOptimisticIdx] = useState<number | null>(null);
    const [syncedIdx, setSyncedIdx] = useState<number | undefined>(undefined);
    if (syncedIdx !== selectedIdx) {
      setSyncedIdx(selectedIdx);
      setOptimisticIdx(selectedIdx >= 0 ? selectedIdx : null);
    }

    const activeSelectedIdx = optimisticIdx;
    const selectedRect = activeSelectedIdx !== null ? itemRects[activeSelectedIdx] : null;
    const hoverRect = hoveredIndex !== null ? itemRects[hoveredIndex] : null;
    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    const isHoveringSelected = hoveredIndex === activeSelectedIdx;
    const isHovering = hoveredIndex !== null && !isHoveringSelected;

    // Skip DOM elements: _index on a <div> triggers React's unknown-prop warning.
    const indexedChildren = Children.map(children, (child, i) => {
      if (isValidElement(child) && typeof child.type !== 'string') {
        return cloneElement(child, { _index: i } as Record<string, unknown>);
      }
      return child;
    });

    return (
      <TabsListContext.Provider
        value={{
          registerTab,
          hoveredIndex,
          selectedValue,
          setOptimisticIdx,
        }}
      >
        <TabsPrimitive.List
          activateOnFocus
          ref={(node) => {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          // Focus shares the hover index; the ring only draws on :focus-visible.
          onFocus={(e) => {
            const trigger = (e.target as HTMLElement).closest('[role="tab"]');
            if (!trigger) return;
            const indexAttr = trigger.getAttribute('data-fluid-hover-index');
            if (indexAttr != null) {
              const idx = Number(indexAttr);
              setHoveredIndex(idx);
              setFocusedIndex((e.target as HTMLElement).matches(':focus-visible') ? idx : null);
            }
          }}
          // Leaving the list drops the ring; hover stays while the mouse is inside.
          onBlur={(e) => {
            if (containerRef.current?.contains(e.relatedTarget as Node)) return;
            setFocusedIndex(null);
            if (isMouseInside.current) return;
            setHoveredIndex(null);
          }}
          className={cn(
            // segmentPad + segmentItem = the control height, matching buttons
            // and inputs beside it.
            'relative inline-flex items-center select-none bg-muted',
            sizeClasses.segmentPad,
            shape.container,
            className,
          )}
          {...props}
        >
          {/* Active segment indicator */}
          {selectedRect && (
            <motion.div
              className={cn(
                'absolute pointer-events-none',
                surfaceClasses(indicatorLevel),
                shape.bg,
              )}
              initial={false}
              animate={{
                left: selectedRect.left,
                width: selectedRect.width,
                top: selectedRect.top,
                height: selectedRect.height,
                // Dims while another tab is hovered.
                opacity: isHovering ? 0.85 : 1,
              }}
              transition={{
                ...spring.moderate,
                opacity: { duration: 0.08 },
              }}
            />
          )}

          {/* Hover indicator */}
          <AnimatePresence>
            {/* Starts at the selected pill and slides out to the hovered tab. */}
            {hoverRect && !isHoveringSelected && selectedRect && (
              <motion.div
                className={cn('absolute pointer-events-none bg-hover', shape.bg)}
                initial={{
                  left: selectedRect.left,
                  width: selectedRect.width,
                  top: selectedRect.top,
                  height: selectedRect.height,
                  opacity: 0,
                }}
                animate={{
                  left: hoverRect.left,
                  width: hoverRect.width,
                  top: hoverRect.top,
                  height: hoverRect.height,
                  opacity: 0.4,
                }}
                // Mouse left the list: slide back into the selected pill.
                // Still inside (over the selected tab): fade in place.
                exit={
                  !mouseInside && selectedRect
                    ? {
                        left: selectedRect.left,
                        width: selectedRect.width,
                        top: selectedRect.top,
                        height: selectedRect.height,
                        opacity: 0,
                        transition: {
                          ...spring.moderate,
                          opacity: { duration: 0.06 },
                        },
                      }
                    : { opacity: 0, transition: spring.fast.exit }
                }
                transition={{
                  ...spring.fast,
                  opacity: { duration: 0.08 },
                }}
              />
            )}
          </AnimatePresence>

          {/* Focus ring */}
          <AnimatePresence>
            {/* One shared ring, 2px outside the focused tab. */}
            {focusRect && (
              <motion.div
                className={cn(
                  'absolute pointer-events-none z-20 border border-[color:var(--focus-ring,#6B97FF)]',
                  shape.focusRing,
                )}
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

          {indexedChildren}
        </TabsPrimitive.List>
      </TabsListContext.Provider>
    );
  },
);

TabsList.displayName = 'TabsList';

/* ─────────────────────── TabItem ─────────────────────── */

interface TabItemProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Tab> {
  /** Unique value for this tab. */
  value: string;
  /** Optional leading icon. */
  icon?: IconComponent;
  /** Text label. */
  label: string;
  /** @internal Auto-assigned by TabsList. */
  _index?: number;
}

const TabItem = forwardRef<HTMLButtonElement, TabItemProps>(
  ({ value, icon: Icon, label, _index = 0, className, onClick, ...props }, ref) => {
    const internalRef = useRef<HTMLButtonElement>(null);
    const sizeClasses = useSize();
    const { registerTab, hoveredIndex, selectedValue, setOptimisticIdx } = useTabsList();

    useEffect(() => {
      registerTab(_index, value, internalRef.current);
      return () => registerTab(_index, value, null);
    }, [_index, value, registerTab]);

    const isSelected = selectedValue === value;
    // Hover or selection brightens color; only selection changes weight.
    const isActive = hoveredIndex === _index || isSelected;

    return (
      <TabsPrimitive.Tab
        // Composed so a consumer onClick can't replace the optimistic jump.
        onClick={(e) => {
          setOptimisticIdx(_index);
          onClick?.(e);
        }}
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLElement | null>).current =
            node as HTMLButtonElement | null;
          if (typeof ref === 'function') ref(node as HTMLButtonElement);
          else if (ref)
            (ref as React.MutableRefObject<HTMLButtonElement | null>).current =
              node as HTMLButtonElement | null;
        }}
        value={value}
        // Read back by the list's onFocus.
        data-fluid-hover-index={_index}
        className={cn(
          // outline-none: the list draws a shared ring. Fixed height so the
          // text-box trim doesn't shrink the tab.
          'relative z-10 flex items-center px-3 cursor-pointer bg-transparent border-none outline-none',
          sizeClasses.segmentItem,
          sizeClasses.gap,
          className,
        )}
        {...props}
      >
        {Icon && (
          <Icon
            size={sizeClasses.icon}
            strokeWidth={isActive ? 2 : 1.5}
            className={cn(
              'transition-[color,stroke-width] duration-80',
              isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
          />
        )}
        <span className={cn('inline-grid whitespace-nowrap', sizeClasses.text)}>
          {/* Invisible semibold sizer: the tab doesn't widen when selected.
              Both spans share the text-box trim. */}
          <span
            className="col-start-1 row-start-1 invisible [text-box:trim-both_cap_alphabetic]"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {label}
          </span>
          <span
            className={cn(
              'col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]',
              isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
            style={{
              fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
            }}
          >
            {label}
          </span>
        </span>
      </TabsPrimitive.Tab>
    );
  },
);

TabItem.displayName = 'TabItem';

/* ─────────────────────── TabPanel ─────────────────────── */

interface TabPanelProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Panel> {
  /** Must match a TabItem value. */
  value: string;
}

const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(({ className, ...props }, ref) => {
  return <TabsPrimitive.Panel ref={ref} className={cn('outline-none', className)} {...props} />;
});

TabPanel.displayName = 'TabPanel';

/* ─────────────────────── Exports ─────────────────────── */

export type { TabItemProps, TabPanelProps, TabsListProps, TabsProps };
export { TabItem, TabPanel, Tabs, TabsList };
