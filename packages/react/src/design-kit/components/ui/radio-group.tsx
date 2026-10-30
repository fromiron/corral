'use client';

import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { AnimatePresence, motion } from 'motion/react';
import {
  Children,
  createContext,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';

// ---------------------------------------------------------------------------
// RadioGroup: rows share one fluid hover scope; the group paints the shared
// selected background, hover highlight and focus ring. Selection API: `value`
// + `onValueChange`, `selectedIndex`, or per-item `selected` + `onSelect`.
// ---------------------------------------------------------------------------

// Set while a row's mousedown calls focus(): Chrome reports script focus as
// :focus-visible, so without it every click would draw the focus ring.
let pointerFocusRedirect = false;

interface RadioGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  selectedIndex: number | null;
  selectedValue?: string;
  onValueChange?: (value: string) => void;
  /** With no selection, the first item stays tabbable so the group is reachable. */
  hasSelection: boolean;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

function useRadioGroupContext() {
  const ctx = useContext(RadioGroupContext);
  if (!ctx) throw new Error('useRadioGroup must be used within a RadioGroup');
  return ctx;
}

interface RadioGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  children: ReactNode;
  selectedIndex?: number;
  value?: string;
  onValueChange?: (value: string) => void;
  /** Row size (default 36px, compact 28px). Omitted, follows the SizeProvider. */
  size?: SizeVariant;
}

const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ children, selectedIndex, value, onValueChange, size, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Maps `value` to the row index the selected background sits on.
    const childValues = Children.toArray(children)
      .filter(isValidElement)
      .map((child) => (child.props as { value?: string }).value);
    const hover = useFluidHover(containerRef);
    const { activeIndex, setActiveIndex, itemRects, handlers, registerItem } = hover;

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    // -1 when nothing matches, which hides the selected background.
    const resolvedSelectedIndex =
      value !== undefined ? childValues.indexOf(value) : (selectedIndex ?? -1);
    // Covers all three selection APIs: value, selectedIndex, per-item selected.
    const hasSelection =
      resolvedSelectedIndex >= 0 ||
      Children.toArray(children)
        .filter(isValidElement)
        .some((child) => (child.props as { selected?: boolean }).selected === true);

    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    const selectedRect = resolvedSelectedIndex >= 0 ? itemRects[resolvedSelectedIndex] : null;
    const shape = useShape();

    const content = (
      <div
        ref={(node) => {
          (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        onMouseEnter={handlers.onMouseEnter}
        onMouseMove={handlers.onMouseMove}
        onMouseLeave={handlers.onMouseLeave}
        onClick={handlers.onClick}
        // Focus drives the same activeIndex as hover; the ring is keyboard-only.
        onFocus={(e) => {
          const indexAttr = (e.target as HTMLElement)
            .closest('[data-fluid-hover-index]')
            ?.getAttribute('data-fluid-hover-index');
          if (indexAttr != null) {
            const idx = Number(indexAttr);
            setActiveIndex(idx);
            setFocusedIndex(
              !pointerFocusRedirect && (e.target as HTMLElement).matches(':focus-visible')
                ? idx
                : null,
            );
          }
        }}
        onBlur={(e) => {
          if (containerRef.current?.contains(e.relatedTarget as Node)) return;
          setFocusedIndex(null);
          setActiveIndex(null);
        }}
        onKeyDown={(e) => {
          // Not [role="radio"]: the hidden primitive carries that role too.
          const items = Array.from(
            containerRef.current?.querySelectorAll('[data-fluid-hover-index]') ?? [],
          ) as HTMLElement[];
          const currentIdx = items.indexOf(e.target as HTMLElement);
          if (currentIdx === -1) return;

          // In value mode Base UI's composite handler shares this element;
          // suppress its roving focus, which targets the hidden radios.
          const preventBaseUI = (e as unknown as { preventBaseUIHandler?: () => void })
            .preventBaseUIHandler;

          // Arrows (wrapping) and Home/End move focus and select, like native
          // radios, via the row's click.
          if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
            e.preventDefault();
            preventBaseUI?.();
            const next = ['ArrowDown', 'ArrowRight'].includes(e.key)
              ? (currentIdx + 1) % items.length
              : (currentIdx - 1 + items.length) % items.length;
            // biome-ignore lint/style/noNonNullAssertion: The current row exists and the wrapped index stays within items.
            const nextItem = items[next]!;
            nextItem.focus();
            nextItem.click();
          } else if (e.key === 'Home') {
            e.preventDefault();
            preventBaseUI?.();
            items[0]?.focus();
            items[0]?.click();
          } else if (e.key === 'End') {
            e.preventDefault();
            preventBaseUI?.();
            items[items.length - 1]?.focus();
            items[items.length - 1]?.click();
          }
        }}
        role="radiogroup"
        // select-none keeps rapid clicks on rows from selecting the label text.
        className={cn('relative flex flex-col w-72 max-w-full select-none', className)}
        {...props}
      >
        {/* Selected background, shared across rows */}
        {selectedRect && (
          <motion.div
            className={`absolute ${shape.bg} bg-active pointer-events-none`}
            initial={false}
            animate={{
              top: selectedRect.top,
              left: selectedRect.left,
              width: selectedRect.width,
              height: selectedRect.height,
              opacity: 1,
            }}
            transition={{
              ...spring.moderate,
              opacity: { duration: 0.08 },
            }}
          />
        )}

        {/* Hover background */}
        <FluidHoverHighlight hover={hover} className={shape.bg} />

        {/* Focus ring: 2px outside the row, with shape.focusRing = row radius
            + 2px so the corners stay concentric. */}
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

    // Value mode always needs the Base UI RadioGroup wrapper, even without
    // `onValueChange`: each RadioItem's RadioPrimitive.Root requires its context.
    const withSize = (node: ReactNode) =>
      size ? <SizeProvider size={size}>{node}</SizeProvider> : node;

    if (value !== undefined) {
      return withSize(
        <RadioGroupContext.Provider
          value={{
            registerItem,
            activeIndex,
            selectedIndex: resolvedSelectedIndex >= 0 ? resolvedSelectedIndex : null,
            selectedValue: value,
            onValueChange,
            hasSelection,
          }}
        >
          {/* render merges the primitive onto the container: no wrapper div. */}
          <RadioGroupPrimitive
            value={value}
            onValueChange={(v) => onValueChange?.(v as string)}
            render={content}
          />
        </RadioGroupContext.Provider>,
      );
    }

    return withSize(
      <RadioGroupContext.Provider
        value={{
          registerItem,
          activeIndex,
          selectedIndex: selectedIndex ?? null,
          hasSelection,
        }}
      >
        {content}
      </RadioGroupContext.Provider>,
    );
  },
);

RadioGroup.displayName = 'RadioGroup';

interface RadioItemProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  index: number;
  selected?: boolean;
  onSelect?: () => void;
  value?: string;
}

const RadioItem = forwardRef<HTMLDivElement, RadioItemProps>(
  ({ label, index, selected, onSelect, value, className, ...props }, ref) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const { registerItem, activeIndex, selectedIndex, selectedValue, onValueChange, hasSelection } =
      useRadioGroupContext();

    useRegisterFluidHoverItem(registerItem, index, internalRef);

    const isActive = activeIndex === index;
    const shape = useShape();
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    // Value equality when both sides have one; else `selected`, then selectedIndex.
    const isSelected =
      value !== undefined && selectedValue !== undefined
        ? selectedValue === value
        : (selected ?? selectedIndex === index);

    const handleSelect = () => {
      if (value !== undefined) {
        onValueChange?.(value);
      }
      onSelect?.();
    };

    return (
      // biome-ignore lint/a11y/useSemanticElements: The focusable row owns selection and keyboard controls; the primitive is hidden from AT.
      <div
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        data-fluid-hover-index={index}
        // Roving tabindex: the selected item, else the first.
        tabIndex={isSelected ? 0 : !hasSelection && index === 0 ? 0 : -1}
        // The row, not the primitive, takes focus, so it carries role and state.
        role="radio"
        aria-checked={isSelected}
        aria-label={label}
        onClick={handleSelect}
        onMouseDown={(e) => {
          // Pin focus to the row (arrow nav only targets rows), unless the press
          // lands on an interactive child.
          const interactive = (e.target as HTMLElement).closest(
            'button:not([tabindex="-1"]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (interactive && interactive !== e.currentTarget) return;
          e.preventDefault();
          pointerFocusRedirect = true;
          try {
            e.currentTarget.focus();
          } finally {
            pointerFocusRedirect = false;
          }
        }}
        // preventDefault keeps Space from scrolling the page.
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleSelect();
          }
        }}
        className={cn(
          // Fixed height so the label's text-box trim doesn't shrink the row.
          `relative z-10 flex ${sizeClasses.control} items-center ${sizeClasses.gap} ${shape.item} ${sizeClasses.px} cursor-pointer outline-none`,
          className,
        )}
        {...props}
      >
        {/* Radio circle */}
        <div
          className={cn('relative shrink-0', compact ? 'w-[14px] h-[14px]' : 'w-[16px] h-[16px]')}
        >
          {/* Border: transparent when selected (the dot marks it). */}
          <div
            className={cn(
              'absolute inset-0 rounded-full border-solid transition-all duration-80',
              isSelected
                ? 'border-[1.5px] border-transparent'
                : isActive
                  ? 'border-[1.5px] border-neutral-400 dark:border-neutral-500'
                  : 'border-[1.5px] border-border',
            )}
          />
          {/* Dot. initial={false}: a default selection doesn't pop in on load. */}
          <AnimatePresence initial={false}>
            {isSelected && (
              <motion.div
                className="absolute inset-0 flex items-center justify-center"
                initial={{
                  opacity: 0,
                  scale: 0.3,
                }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.3, transition: { duration: 0.04 } }}
                transition={spring.fast}
              >
                <div
                  className={cn(
                    'rounded-full bg-foreground',
                    compact ? 'w-[7px] h-[7px]' : 'w-[8px] h-[8px]',
                  )}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <span className={cn('inline-grid', sizeClasses.text)}>
          {/* Invisible semibold sizer: the row never shifts when the label
              gains weight. Both spans share the text-box trim. */}
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
              isSelected || isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
            style={{
              fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
            }}
          >
            {label}
          </span>
        </span>

        {/* The public row owns focus and semantics. Hide the entire primitive
            subtree, including Base UI's generated input, while keeping value plumbing. */}
        {value !== undefined && (
          <span hidden aria-hidden="true">
            <RadioPrimitive.Root value={value} tabIndex={-1} />
          </span>
        )}
      </div>
    );
  },
);

RadioItem.displayName = 'RadioItem';

export { RadioGroup, RadioItem };
export default RadioGroup;
