'use client';

import { Tabs } from '@base-ui/react/tabs';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useFluidHover } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import type { IconComponent } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring, tween } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';

interface TabsSubtleContextValue {
  registerTab: (index: number, element: HTMLElement | null) => void;
  hoveredIndex: number | null;
  selectedIndex: number;
  idPrefix: string | undefined;
  activeLabel: boolean;
}

const TabsSubtleContext = createContext<TabsSubtleContextValue | null>(null);

function useTabsSubtle() {
  const ctx = useContext(TabsSubtleContext);
  if (!ctx) throw new Error('useTabsSubtle must be used within a TabsSubtle');
  return ctx;
}

interface TabsSubtleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  children: ReactNode;
  selectedIndex: number;
  onSelect: (index: number) => void;
  idPrefix?: string;
  /** When true, only the selected tab shows its text label. Requires icons on tabs. */
  activeLabel?: boolean;
  /** Size step (default 36px, compact 28px). Omitted, follows the
   *  surrounding SizeProvider. */
  size?: SizeVariant;
}

const TabsSubtle = forwardRef<HTMLDivElement, TabsSubtleProps>(
  (
    { children, selectedIndex, onSelect, idPrefix, activeLabel = false, size, className, ...props },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Pointer-inside flag: the ref is read synchronously by blur, the state
    // drives the hover pill's exit. Both flip together.
    const isMouseInside = useRef(false);
    const [mouseInside, setMouseInside] = useState(false);
    const shape = useShape();

    const {
      activeIndex: hoveredIndex,
      setActiveIndex: setHoveredIndex,
      itemRects: tabRects,
      handlers,
      registerItem,
      measureItems: measureTabs,
    } = useFluidHover(containerRef, { axis: 'x' });

    const tabElementsRef = useRef(new Map<number, HTMLElement>());
    const registerTab = useCallback(
      (index: number, element: HTMLElement | null) => {
        registerItem(index, element);
        if (element) {
          tabElementsRef.current.set(index, element);
        } else {
          tabElementsRef.current.delete(index);
        }
      },
      [registerItem],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: Preserve source remeasurement when tab children change.
    useEffect(() => {
      measureTabs();
    }, [measureTabs, children]);

    // Re-measure when a tab resizes (label expand/collapse in activeLabel mode).
    // biome-ignore lint/correctness/useExhaustiveDependencies: Preserve source re-observation when tab children change.
    useEffect(() => {
      const elements = tabElementsRef.current;
      if (elements.size === 0) return;
      const ro = new ResizeObserver(() => measureTabs());
      for (const el of elements.values()) ro.observe(el);
      return () => ro.disconnect();
    }, [measureTabs, children]);

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        isMouseInside.current = true;
        setMouseInside(true);
        handlers.onMouseMove(e);
      },
      [handlers],
    );

    const handleMouseLeave = useCallback(() => {
      isMouseInside.current = false;
      setMouseInside(false);
      handlers.onMouseLeave();
    }, [handlers]);

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    const selectedRect = tabRects[selectedIndex];
    const hoverRect = hoveredIndex !== null ? tabRects[hoveredIndex] : null;
    const focusRect = focusedIndex !== null ? tabRects[focusedIndex] : null;
    const isHoveringSelected = hoveredIndex === selectedIndex;
    const isHovering = hoveredIndex !== null && !isHoveringSelected;

    const root = (
      <TabsSubtleContext.Provider
        value={{ registerTab, hoveredIndex, selectedIndex, idPrefix, activeLabel }}
      >
        {/* Root is merged into List via `render` to emit a single <div>.
            `activateOnFocus={false}`: arrows move focus, Enter/Space selects. */}
        <Tabs.Root
          value={selectedIndex}
          onValueChange={(value) => {
            if (typeof value === 'number') onSelect(value);
          }}
          render={
            <Tabs.List
              activateOnFocus={false}
              ref={(node: HTMLDivElement | null) => {
                containerRef.current = node;
                if (typeof ref === 'function') ref(node);
                else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
              }}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              onFocus={(e: React.FocusEvent<HTMLDivElement>) => {
                const indexAttr = (e.target as HTMLElement)
                  .closest('[data-fluid-hover-index]')
                  ?.getAttribute('data-fluid-hover-index');
                if (indexAttr != null) {
                  const idx = Number(indexAttr);
                  setHoveredIndex(idx);
                  setFocusedIndex((e.target as HTMLElement).matches(':focus-visible') ? idx : null);
                }
              }}
              onBlur={(e: React.FocusEvent<HTMLDivElement>) => {
                if (containerRef.current?.contains(e.relatedTarget as Node)) return;
                setFocusedIndex(null);
                if (isMouseInside.current) return;
                setHoveredIndex(null);
              }}
              className={cn(
                // Negative margin + padding give the 2px-outset focus ring room
                // inside overflow-x-auto; max-width adds back the 8px the
                // margins remove so the edge tabs' rings aren't clipped.
                'relative flex items-center select-none overflow-x-auto max-w-[calc(100%_+_8px)] scrollbar-hide -mx-1 px-1 -my-1 py-1',
                className,
              )}
              {...props}
            >
              {/* Selected pill */}
              {selectedRect && (
                <motion.div
                  className={cn('absolute bg-active pointer-events-none', shape.bg)}
                  initial={false}
                  animate={{
                    left: selectedRect.left,
                    width: selectedRect.width,
                    top: selectedRect.top,
                    height: selectedRect.height,
                    opacity: isHovering ? 0.8 : 1,
                  }}
                  transition={{
                    ...spring.moderate,
                    opacity: tween.fast,
                  }}
                />
              )}

              {/* Hover pill */}
              <AnimatePresence>
                {hoverRect && !isHoveringSelected && selectedRect && (
                  <motion.div
                    className={cn('absolute bg-active pointer-events-none', shape.bg)}
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
                    exit={
                      !mouseInside && selectedRect
                        ? {
                            left: selectedRect.left,
                            width: selectedRect.width,
                            top: selectedRect.top,
                            height: selectedRect.height,
                            opacity: 0,
                            transition: { ...spring.moderate, opacity: tween.fast.exit },
                          }
                        : { opacity: 0, transition: spring.fast.exit }
                    }
                    transition={{
                      ...spring.fast,
                      opacity: tween.fast,
                    }}
                  />
                )}
              </AnimatePresence>

              {/* Focus ring */}
              <AnimatePresence>
                {focusRect && (
                  <motion.div
                    className={cn(
                      'absolute pointer-events-none z-20 border-2 border-[color:var(--focus-ring)]',
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
                      opacity: tween.fast,
                    }}
                  />
                )}
              </AnimatePresence>

              {children}
            </Tabs.List>
          }
        />
      </TabsSubtleContext.Provider>
    );

    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
  },
);

TabsSubtle.displayName = 'TabsSubtle';

interface TabsSubtleItemProps extends HTMLAttributes<HTMLButtonElement> {
  icon?: IconComponent;
  label: string;
  index: number;
}

const TabsSubtleItem = forwardRef<HTMLButtonElement, TabsSubtleItemProps>(
  ({ icon: Icon, label, index, className, ...props }, ref) => {
    const internalRef = useRef<HTMLButtonElement | null>(null);
    // The collapsing label animates to a measured width, not "auto": Motion
    // resolves "auto" from the transformed size, which is wrong under a
    // scaled ancestor. offsetWidth/ResizeObserver ignore transforms.
    const [labelWidth, setLabelWidth] = useState<number | null>(null);
    const labelRoRef = useRef<ResizeObserver | null>(null);
    const measureLabel = useCallback((el: HTMLSpanElement | null) => {
      labelRoRef.current?.disconnect();
      labelRoRef.current = null;
      if (!el) return;
      const update = () => setLabelWidth(el.offsetWidth);
      update();
      labelRoRef.current = new ResizeObserver(update);
      labelRoRef.current.observe(el);
    }, []);
    const shape = useShape();
    const sizeClasses = useSize();
    const { registerTab, hoveredIndex, selectedIndex, idPrefix, activeLabel } = useTabsSubtle();

    useEffect(() => {
      registerTab(index, internalRef.current);
      return () => registerTab(index, null);
    }, [index, registerTab]);

    const isSelected = selectedIndex === index;
    const isActive = hoveredIndex === index || isSelected;
    const collapseLabel = activeLabel && !!Icon;
    const showLabel = !collapseLabel || isSelected;

    const labelContent = (
      // Both stacked spans carry the text-box trim so the invisible bold
      // sizer and the visible label keep identical boxes.
      <span ref={measureLabel} className={cn('inline-grid whitespace-nowrap', sizeClasses.text)}>
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
    );

    return (
      // id/aria-controls are overridden only with an idPrefix, so externally
      // rendered TabsSubtlePanel elements stay linked.
      <Tabs.Tab
        ref={(node: HTMLElement | null) => {
          const button = node as HTMLButtonElement | null;
          internalRef.current = button;
          if (typeof ref === 'function') ref(button);
          else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = button;
        }}
        value={index}
        data-fluid-hover-index={index}
        id={idPrefix ? `${idPrefix}-tab-${index}` : undefined}
        aria-controls={idPrefix ? `${idPrefix}-panel-${index}` : undefined}
        aria-label={collapseLabel && !showLabel ? label : undefined}
        className={cn(
          // Fixed height so the label's text-box trim doesn't shrink the tab.
          'relative z-10 flex items-center cursor-pointer bg-transparent border-none outline-none',
          sizeClasses.control,
          sizeClasses.px,
          !collapseLabel && sizeClasses.gap,
          shape.bg,
          className,
        )}
        {...props}
      >
        {Icon && (
          <Icon
            size={sizeClasses.icon}
            strokeWidth={isActive ? 2 : 1.5}
            className={cn(
              'shrink-0 transition-[color,stroke-width] duration-80',
              isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
          />
        )}
        {collapseLabel ? (
          <AnimatePresence initial={false}>
            {showLabel && (
              <motion.span
                key="label"
                className="overflow-hidden"
                // Until measured, use CSS auto rather than animating to "auto"
                // (see above), which would pulse the tab under a scaled ancestor.
                style={labelWidth == null ? { width: 'auto' } : undefined}
                initial={{ width: 0, opacity: 0, marginLeft: 0 }}
                animate={{
                  ...(labelWidth != null ? { width: labelWidth } : null),
                  opacity: 1,
                  // Matches the icon-to-label gap (8px; 6px compact).
                  marginLeft: sizeClasses.variant === 'compact' ? 6 : 8,
                }}
                exit={{ width: 0, opacity: 0, marginLeft: 0 }}
                transition={{
                  ...spring.fast,
                  opacity: tween.fast.exit,
                }}
              >
                {labelContent}
              </motion.span>
            )}
          </AnimatePresence>
        ) : (
          labelContent
        )}
      </Tabs.Tab>
    );
  },
);

TabsSubtleItem.displayName = 'TabsSubtleItem';

interface TabsSubtlePanelProps extends HTMLAttributes<HTMLDivElement> {
  index: number;
  selectedIndex: number;
  idPrefix: string;
  children: ReactNode;
}

// Rendered outside <TabsSubtle>, so it can't use Tabs.Panel (needs Tabs.Root
// context); a plain tabpanel linked to its tab via idPrefix.
const TabsSubtlePanel = forwardRef<HTMLDivElement, TabsSubtlePanelProps>(
  ({ index, selectedIndex, idPrefix, children, className, ...props }, ref) => {
    const isSelected = selectedIndex === index;

    return (
      <div
        ref={ref}
        id={`${idPrefix}-panel-${index}`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${index}`}
        hidden={!isSelected}
        tabIndex={-1}
        className={cn('outline-none', className)}
        {...props}
      >
        {isSelected && children}
      </div>
    );
  },
);

TabsSubtlePanel.displayName = 'TabsSubtlePanel';

export { TabsSubtle, TabsSubtleItem, TabsSubtlePanel };
export default TabsSubtle;
