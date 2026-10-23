'use client';

import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import {
  SelectionBackgrounds,
  useMergeSplitBlocks,
  useSelectionRuns,
} from '../../hooks/use-merge-split.tsx';
import { fontWeights } from '../../lib/font-weight.ts';
import { omit } from '../../lib/omit.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';

// ---------------------------------------------------------------------------
// CheckboxGroup — CheckboxItem rows sharing one fluid-hover scope. The group
// paints the merged checked backgrounds, hover highlight and focus ring; each
// row is the focusable role="checkbox". The parent owns state.
// ---------------------------------------------------------------------------

// Set while mousedown focuses a row: Chrome reports script focus() as
// :focus-visible, which would draw the keyboard ring on every click.
let pointerFocusRedirect = false;

interface CheckboxGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
}

const CheckboxGroupContext = createContext<CheckboxGroupContextValue | null>(null);

function useCheckboxGroup() {
  const ctx = useContext(CheckboxGroupContext);
  if (!ctx) throw new Error('useCheckboxGroup must be used within a CheckboxGroup');
  return ctx;
}

interface CheckboxGroupProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Checked row indices, used to merge contiguous rows into one background. */
  checkedIndices: Set<number>;
  /** Pins rows to a size step (default 36px, compact 28px). Omitted, follows
   *  the surrounding SizeProvider. */
  size?: SizeVariant;
}

const CheckboxGroup = forwardRef<HTMLDivElement, CheckboxGroupProps>(
  ({ children, checkedIndices, size, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);

    const hover = useFluidHover(containerRef);
    const { activeIndex, setActiveIndex, itemRects, handlers, registerItem } = hover;

    // Stable run IDs let a block grow in place when a neighbour is checked.
    const checkedGroups = useSelectionRuns([...checkedIndices]);

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    const shape = useShape();

    const blocks = useMergeSplitBlocks(checkedGroups, itemRects, shape.mergedRadius);

    const group = (
      <CheckboxGroupContext.Provider value={{ registerItem, activeIndex }}>
        {/* biome-ignore lint/a11y/useSemanticElements: The source kit groups custom checkbox rows without fieldset styling. */}
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
          // Focus drives activeIndex like hover; the ring is keyboard-only.
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
            // Don't clear hover when focus moves to another item within the group
            if (containerRef.current?.contains(e.relatedTarget as Node)) return;
            setFocusedIndex(null);
            setActiveIndex(null);
          }}
          onKeyDown={(e) => {
            // Not [role="checkbox"]: the inner primitive has that role too.
            const items = Array.from(
              containerRef.current?.querySelectorAll('[data-fluid-hover-index]') ?? [],
            ) as HTMLElement[];
            const currentIdx = items.indexOf(e.target as HTMLElement);
            if (currentIdx === -1) return;

            if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
              e.preventDefault();
              const next =
                e.key === 'ArrowDown'
                  ? (currentIdx + 1) % items.length
                  : (currentIdx - 1 + items.length) % items.length;
              // biome-ignore lint/style/noNonNullAssertion: The current row exists and the wrapped index stays within items.
              items[next]!.focus();
            } else if (e.key === 'Home') {
              e.preventDefault();
              items[0]?.focus();
            } else if (e.key === 'End') {
              e.preventDefault();
              items[items.length - 1]?.focus();
            }
          }}
          role="group"
          // select-none keeps rapid clicks on rows from selecting the label text.
          className={cn('relative flex flex-col w-72 max-w-full select-none', className)}
          {...props}
        >
          <SelectionBackgrounds blocks={blocks} />

          <FluidHoverHighlight hover={hover} className={shape.bg} />

          {/* Shared focus ring, 2px outside the row with radius + 2px so the
              corners stay concentric. */}
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
      </CheckboxGroupContext.Provider>
    );

    return size ? <SizeProvider size={size}>{group}</SizeProvider> : group;
  },
);

CheckboxGroup.displayName = 'CheckboxGroup';

interface CheckboxItemProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  index: number;
  checked: boolean;
  onToggle: () => void;
}

const CheckboxItem = forwardRef<HTMLDivElement, CheckboxItemProps>(
  ({ label, index, checked, onToggle, className, ...props }, ref) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const { registerItem, activeIndex } = useCheckboxGroup();

    useRegisterFluidHoverItem(registerItem, index, internalRef);

    const isActive = activeIndex === index;
    const shape = useShape();
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';

    return (
      // biome-ignore lint/a11y/useSemanticElements: The focusable row owns the checked state and keyboard controls; the primitive is hidden from AT.
      <div
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        data-fluid-hover-index={index}
        // Every row is a tab stop (no roving tabindex) and carries the role.
        tabIndex={0}
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        onMouseDown={(e) => {
          // Clicking the square would focus the hidden primitive and break
          // arrow-key nav, so focus the row instead (unless an interactive
          // child was clicked).
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
            onToggle();
          }
        }}
        className={cn(
          // Fixed height so text-box trim on the label can't shrink the row.
          `relative z-10 flex ${sizeClasses.control} items-center ${sizeClasses.gap} ${shape.item} ${sizeClasses.px} cursor-pointer outline-none`,
          className,
        )}
        {...props}
      >
        <CheckboxPrimitive.Root
          checked={checked}
          // Hidden from AT and tab order: the row is already the checkbox.
          tabIndex={-1}
          aria-hidden
          className={cn(
            'relative shrink-0 appearance-none bg-transparent p-0 border-0 outline-none cursor-pointer',
            compact ? 'w-[14px] h-[14px]' : 'w-[16px] h-[16px]',
          )}
          // No onCheckedChange: the click bubbles to the row's onClick, and
          // handling both would toggle twice.
        >
          {/* Border: transparent when checked, darker on hover/focus. */}
          <div
            className={cn(
              'absolute inset-0 border-solid transition-all duration-80',
              compact ? 'rounded-[4px]' : 'rounded-[5px]',
              checked
                ? 'border-[1.5px] border-transparent'
                : isActive
                  ? 'border-[1.5px] border-neutral-400 dark:border-neutral-500'
                  : 'border-[1.5px] border-border',
            )}
          />
          {/* keepMounted lets AnimatePresence play the retract; initial={false}
              keeps default selections from animating on mount. */}
          <AnimatePresence initial={false}>
            {checked && (
              <CheckboxPrimitive.Indicator
                keepMounted
                render={(indicatorProps) => {
                  const rest = omit(indicatorProps as React.HTMLAttributes<SVGSVGElement>, [
                    'style',
                    'onDrag',
                    'onDragStart',
                    'onDragEnd',
                    'onAnimationStart',
                    'onAnimationEnd',
                    'onAnimationIteration',
                  ]);
                  return (
                    <motion.svg
                      {...rest}
                      width={compact ? 16 : 18}
                      height={compact ? 16 : 18}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-foreground"
                      initial={{ opacity: 1 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 1 }}
                    >
                      <motion.path
                        d="M6 12L10 16L18 8"
                        initial={{ pathLength: 0 }}
                        animate={{
                          pathLength: 1,
                          transition: { duration: 0.08, ease: 'easeOut' },
                        }}
                        exit={{
                          pathLength: 0,
                          transition: { duration: 0.04, ease: 'easeIn' },
                        }}
                      />
                    </motion.svg>
                  );
                }}
              />
            )}
          </AnimatePresence>
        </CheckboxPrimitive.Root>

        {/* An invisible semibold sizer reserves width so the row never shifts
            when the label gains weight; both spans share the text-box trim. */}
        <span className={cn('inline-grid', sizeClasses.text)}>
          <span
            className="col-start-1 row-start-1 invisible [text-box:trim-both_cap_alphabetic]"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {label}
          </span>
          {/* Weight marks checked state; color also lights on hover/focus. */}
          <span
            className={cn(
              'col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]',
              checked || isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
            style={{
              fontVariationSettings: checked ? fontWeights.semibold : fontWeights.normal,
            }}
          >
            {label}
          </span>
        </span>
      </div>
    );
  },
);

CheckboxItem.displayName = 'CheckboxItem';

export { CheckboxGroup, CheckboxItem };
export default CheckboxGroup;
