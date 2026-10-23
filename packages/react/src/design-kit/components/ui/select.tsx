'use client';

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cva, type VariantProps } from 'class-variance-authority';
import { AnimatePresence, motion } from 'motion/react';
import {
  Children,
  type ComponentProps,
  createContext,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { useKeyboardNavGate } from '../../hooks/use-keyboard-nav-gate.ts';
import { Elevated } from '../../lib/elevated.tsx';
import type { IconComponent } from '../../lib/icon-context.tsx';
import {
  isDisabledRow,
  popupMotionClass,
  popupScrollAreaClass,
  popupViewportClass,
} from '../../lib/popup.ts';
import { shapeMap, useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { exitFallbackMs, spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';
import { ScrollArea } from './scroll-area.tsx';

// ---------------------------------------------------------------------------
// Select context
//
// Every close calls preventUnmountOnClose; SelectContent releases the unmount
// through actionsRef once the exit spring ends.
// ---------------------------------------------------------------------------

// How long a picked item holds the popup open, so the checkmark and selected
// background are seen. Escape and outside presses still close immediately.
const selectionAckMs = 300;

interface SelectContextValue {
  value: string;
  open: boolean;
  actionsRef: React.RefObject<{ unmount: () => void; close: () => void } | null>;
}

const SelectContext = createContext<SelectContextValue | null>(null);

function useSelectContext() {
  const ctx = useContext(SelectContext);
  if (!ctx) throw new Error('Select compound components must be inside <Select>');
  return ctx;
}

// Content context for fluid hover
interface SelectContentContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  checkedIndex?: number;
}

const SelectContentContext = createContext<SelectContentContextValue | null>(null);

// ---------------------------------------------------------------------------
// Select (root)
// ---------------------------------------------------------------------------

// The popup always uses "rounded" radii: pill corners would break the
// concentric fit of the rows' hover and selection backgrounds.
const popupShape = shapeMap.rounded;

interface SelectProps {
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  items?: readonly { value: string; label: ReactNode }[];
  disabled?: boolean;
  name?: string;
  required?: boolean;
  /** Size step for trigger and popup (default 36px, compact 28px). Omitted,
   *  both follow the surrounding SizeProvider. */
  size?: SizeVariant;
}

/**
 * Walk the children tree collecting `{ value, label }` pairs from SelectItem
 * elements. Passed to Base UI's `items` prop so the trigger can resolve the
 * label of an initial value before the popup has ever mounted (items only
 * render while open). Non-string labels fall back to the raw value.
 */
function collectSelectItems(node: ReactNode, out: { value: string; label: ReactNode }[] = []) {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { value?: unknown; children?: ReactNode };
    if (typeof props.value === 'string') {
      out.push({
        value: props.value,
        label: typeof props.children === 'string' ? props.children : props.value,
      });
    } else if (props.children) {
      collectSelectItems(props.children, out);
    }
  });
  return out;
}

function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  open: controlledOpen,
  onOpenChange,
  items: suppliedItems,
  disabled = false,
  name,
  required,
  size,
}: SelectProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? '');
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );
  const actionsRef = useRef<{ unmount: () => void; close: () => void } | null>(null);
  const currentValue = value !== undefined ? value : internalValue;

  const items = useMemo(
    () => suppliedItems ?? collectSelectItems(children),
    [children, suppliedItems],
  );

  const handleValueChange = useCallback(
    (next: string | null) => {
      const v = next ?? '';
      if (value === undefined) setInternalValue(v);
      onValueChange?.(v);
    },
    [value, onValueChange],
  );

  const ackTimeoutRef = useRef<number | null>(null);
  const cancelAckClose = useCallback(() => {
    if (ackTimeoutRef.current !== null) {
      clearTimeout(ackTimeoutRef.current);
      ackTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => cancelAckClose, [cancelAckClose]);

  // An item pick defers the close by selectionAckMs; any other close reason
  // closes immediately and cancels a pending one. Every close holds Base UI's
  // unmount for the exit spring (the opt-out carries over to a deferred close).
  const handleOpenChange = useCallback(
    (nextOpen: boolean, eventDetails: { reason: string; preventUnmountOnClose: () => void }) => {
      if (!nextOpen) eventDetails.preventUnmountOnClose();
      if (!nextOpen && eventDetails.reason === 'item-press') {
        cancelAckClose();
        ackTimeoutRef.current = window.setTimeout(() => {
          ackTimeoutRef.current = null;
          setOpen(false);
        }, selectionAckMs);
        return;
      }
      cancelAckClose();
      setOpen(nextOpen);
    },
    [cancelAckClose, setOpen],
  );

  const ctx = useMemo(() => ({ value: currentValue, open, actionsRef }), [currentValue, open]);

  // React context crosses portals, so a size prop also reaches the popup.
  const root = (
    <SelectContext.Provider value={ctx}>
      <SelectPrimitive.Root
        // Always controlled; "" (no selection) maps to Base UI's null.
        value={currentValue === '' ? null : currentValue}
        onValueChange={handleValueChange}
        open={open}
        onOpenChange={handleOpenChange}
        actionsRef={actionsRef}
        items={items}
        disabled={disabled}
        name={name}
        required={required}
        // Non-modal: the page keeps scrolling and the popup follows its trigger.
        modal={false}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectContext.Provider>
  );

  return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
}

Select.displayName = 'Select';

// ---------------------------------------------------------------------------
// SelectTrigger
// ---------------------------------------------------------------------------

const triggerVariants = cva(
  [
    'group inline-flex items-center justify-between outline-none cursor-pointer',
    'transition-all duration-80',
    'disabled:opacity-50 disabled:pointer-events-none',
    'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
  ],
  {
    variants: {
      variant: {
        bordered: 'border border-border bg-transparent text-foreground hover:bg-hover',
        borderless: 'border border-transparent bg-transparent text-foreground hover:bg-hover',
      },
    },
    defaultVariants: {
      variant: 'bordered',
    },
  },
);

interface SelectTriggerProps
  extends Omit<HTMLAttributes<HTMLButtonElement>, 'children'>,
    VariantProps<typeof triggerVariants> {
  icon?: IconComponent;
  placeholder?: ReactNode;
  leadingContent?: ReactNode;
  error?: string;
  /** Size override for the trigger alone. Prefer the `size` prop on <Select>
   *  (or a surrounding SizeProvider) so the popup matches. */
  size?: SizeVariant;
}

const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  (
    {
      className,
      variant,
      icon: Icon,
      placeholder = 'Select…',
      leadingContent,
      error,
      size,
      ...props
    },
    ref,
  ) => {
    const shape = useShape();
    const sizeClasses = useSize(size);
    const compact = sizeClasses.variant === 'compact';

    return (
      <div className="flex flex-col gap-1">
        <SelectPrimitive.Trigger
          ref={ref}
          aria-invalid={!!error || undefined}
          className={cn(
            triggerVariants({ variant }),
            sizeClasses.control,
            sizeClasses.text,
            sizeClasses.px,
            sizeClasses.gap,
            compact ? 'min-w-[128px]' : 'min-w-[160px]',
            shape.input,
            error && 'border-destructive/50 hover:border-destructive/50',
            className,
          )}
          {...props}
        >
          <span className={cn('flex items-center min-w-0 flex-1', sizeClasses.gap)}>
            {leadingContent}
            {Icon && (
              <Icon
                size={sizeClasses.icon}
                strokeWidth={1.5}
                className="shrink-0 text-muted-foreground transition-[color,stroke-width] duration-80 group-hover:text-foreground group-hover:stroke-[2]"
              />
            )}
            <SelectPrimitive.Value
              placeholder={placeholder}
              // py-1/-my-1 keeps truncate's overflow:hidden from clipping
              // ascenders/descenders outside the trimmed box.
              className="min-w-0 flex-1 text-left truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1 data-[placeholder]:text-muted-foreground"
            />
          </span>

          <svg
            aria-hidden="true"
            width={sizeClasses.icon}
            height={sizeClasses.icon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-muted-foreground transition-colors duration-80 group-hover:text-foreground"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </SelectPrimitive.Trigger>
        {error && (
          <span className="text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] text-destructive pl-3">
            {error}
          </span>
        )}
      </div>
    );
  },
);

SelectTrigger.displayName = 'SelectTrigger';

// ---------------------------------------------------------------------------
// SelectContent
// ---------------------------------------------------------------------------

interface SelectContentProps {
  align?: ComponentProps<typeof SelectPrimitive.Positioner>['align'];
  className?: string;
  children: ReactNode;
}

const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(
  ({ className, children, align = 'start' }, ref) => {
    const { open, value, actionsRef } = useSelectContext();
    const shape = popupShape;
    const containerRef = useRef<HTMLDivElement>(null);

    const hover = useFluidHover(containerRef, { isItemDisabled: isDisabledRow });
    const {
      activeIndex,
      setActiveIndex,
      itemRects,
      isMeasured,
      handlers,
      registerItem,
      remeasure,
    } = hover;

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    // Keyboard focus ring gate: seeded from the trigger's :focus-visible at
    // open, earned by navigation keys inside the popup.
    const { keyboardNavRef, trackKeyboardNav } = useKeyboardNavGate(open);
    const [checkedIndex, setCheckedIndex] = useState<number | undefined>(undefined);

    // Fallback unmount for when onAnimationComplete stalls (throttled or
    // background tabs).
    useEffect(() => {
      if (open) return;
      const id = setTimeout(() => actionsRef.current?.unmount(), exitFallbackMs(spring.fast));
      return () => clearTimeout(id);
    }, [open, actionsRef]);

    // Fresh rects once per open: items stay registered while the popup is
    // hidden, so registration alone wouldn't trigger a pass on reopen.
    useEffect(() => {
      if (!open) return;
      remeasure();
    }, [open, remeasure]);

    // Detect the checked row. Deliberately no remeasure here, so the selected
    // marker springs from the old row to the picked one.
    useEffect(() => {
      if (!open) return;
      // Double rAF: first waits for React commit, second for layout
      let inner: number;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          const container = containerRef.current;
          if (container) {
            const items = Array.from(
              container.querySelectorAll('[data-fluid-hover-index]'),
            ) as HTMLElement[];
            const idx = items.findIndex((el) => el.getAttribute('data-value') === value);
            setCheckedIndex(idx !== -1 ? idx : undefined);
          }
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }, [open, value]);

    // Reset overlay indexes as the close begins: the popup stays mounted
    // through the exit, so leftovers would spring from the old row on reopen.
    const [overlaysOpen, setOverlaysOpen] = useState(open);
    if (overlaysOpen !== open) {
      setOverlaysOpen(open);
      if (!open) {
        setCheckedIndex(undefined);
        setActiveIndex(null);
        setFocusedIndex(null);
      }
    }

    // Overlays wait for a full measurement; a partial pass would mount one at
    // the wrong row and then spring it across the list.
    const checkedRect = isMeasured && checkedIndex != null ? itemRects[checkedIndex] : null;
    const focusRect = isMeasured && focusedIndex !== null ? itemRects[focusedIndex] : null;

    const contentCtx = useMemo(
      () => ({ registerItem, activeIndex, checkedIndex }),
      [registerItem, activeIndex, checkedIndex],
    );

    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          side="bottom"
          align={align}
          sideOffset={6}
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <motion.div
            className={popupMotionClass}
            initial={{ opacity: 0, y: 'var(--popup-enter-y)', scaleY: 0.96 }}
            animate={
              open
                ? { opacity: 1, y: 0, scaleY: 1 }
                : { opacity: 0, y: 'var(--popup-enter-y)', scaleY: 0.96 }
            }
            transition={open ? spring.fast : spring.fast.exit}
            // Release the unmount held by preventUnmountOnClose.
            onAnimationComplete={() => {
              if (!open) actionsRef.current?.unmount();
            }}
          >
            <SelectContentContext.Provider value={contentCtx}>
              <SelectPrimitive.Popup
                data-slot="select-popup"
                render={<Elevated offset={2} shadowLevel={3} ref={ref} />}
                // Capture phase: the primitive moves focus during its own keydown
                // handling, so the nav flag must be set before then.
                onKeyDownCapture={trackKeyboardNav}
                onMouseEnter={() => {
                  handlers.onMouseEnter();
                  setFocusedIndex(null);
                }}
                onMouseMove={handlers.onMouseMove}
                onMouseLeave={handlers.onMouseLeave}
                onClick={handlers.onClick}
                onFocus={(e) => {
                  const indexAttr = (e.target as HTMLElement)
                    .closest('[data-fluid-hover-index]')
                    ?.getAttribute('data-fluid-hover-index');
                  if (indexAttr != null) {
                    const idx = Number(indexAttr);
                    setActiveIndex(idx);
                    setFocusedIndex(
                      keyboardNavRef.current && (e.target as HTMLElement).matches(':focus-visible')
                        ? idx
                        : null,
                    );
                  }
                }}
                onBlur={(e) => {
                  // The popup itself takes focus when the pointer leaves a row; only a
                  // departure from the whole popup ends the hover session.
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  setFocusedIndex(null);
                  setActiveIndex(null);
                }}
                className={cn(
                  // min-w tracks the trigger via the Positioner's --anchor-width.
                  `flex flex-col min-w-[var(--anchor-width)] max-h-[min(300px,var(--available-height))] overflow-hidden ${shape.container} select-none outline-none`,
                  className,
                )}
              >
                {/* The list scrolls inside a ScrollArea; this wrapper is the rows'
                    offsetParent, so the overlays scroll with them. */}
                <ScrollArea
                  className={popupScrollAreaClass}
                  viewportClassName={cn(popupViewportClass, 'scroll-fade')}
                >
                  <div ref={containerRef} className="relative flex flex-col p-1">
                    {/* Overlays unmount as the close begins instead of exiting: one
                    still mounted on reopen would slide from its old row. */}
                    {/* Selected background */}
                    {open && (
                      <AnimatePresence>
                        {checkedRect && (
                          <motion.div
                            className={`absolute ${shape.bg} bg-active pointer-events-none`}
                            // Position lives in `animate` so a value change while
                            // open springs the marker to the picked row.
                            initial={false}
                            animate={{
                              top: checkedRect.top,
                              left: checkedRect.left,
                              width: checkedRect.width,
                              height: checkedRect.height,
                              opacity: 1,
                            }}
                            exit={{ opacity: 0, transition: spring.moderate.exit }}
                            transition={{
                              ...spring.moderate,
                              opacity: { duration: 0.08 },
                            }}
                          />
                        )}
                      </AnimatePresence>
                    )}

                    {/* Hover background */}
                    <FluidHoverHighlight hover={hover} hidden={!open} className={shape.bg} />

                    {/* Focus ring */}
                    {open && (
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
                    )}

                    {children}
                  </div>
                </ScrollArea>
              </SelectPrimitive.Popup>
            </SelectContentContext.Provider>
          </motion.div>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    );
  },
);

SelectContent.displayName = 'SelectContent';

// ---------------------------------------------------------------------------
// SelectItem
// ---------------------------------------------------------------------------

interface SelectItemProps extends HTMLAttributes<HTMLDivElement> {
  icon?: IconComponent;
  index: number;
  value: string;
  disabled?: boolean;
}

const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(
  ({ className, children, icon: Icon, value, index, disabled = false, ...props }, ref) => {
    const selectCtx = useSelectContext();
    const contentCtx = useContext(SelectContentContext);
    const internalRef = useRef<HTMLDivElement>(null);
    const shape = popupShape;
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';

    // Use the stable registerItem, not the whole context (rebuilt on every
    // activeIndex change), so rows don't re-register on every mousemove.
    const registerItem = contentCtx?.registerItem;
    useRegisterFluidHoverItem(registerItem, index, internalRef);

    const isActive = contentCtx?.activeIndex === index;
    const isChecked = selectCtx.value === value;

    return (
      <SelectPrimitive.Item
        value={value}
        disabled={disabled}
        label={typeof children === 'string' ? children : undefined}
        render={
          <div
            ref={(node: HTMLDivElement | null) => {
              (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
              if (typeof ref === 'function') ref(node);
              else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
            }}
            data-fluid-hover-index={index}
            data-value={value}
            className={cn(
              // Fixed height so the text-box trim doesn't shrink the row;
              // shrink-0 so a long list scrolls instead of compressing rows.
              `relative z-10 flex ${sizeClasses.control} shrink-0 items-center ${sizeClasses.gap} ${shape.item} ${sizeClasses.itemPx} ${sizeClasses.text} cursor-pointer outline-none select-none`,
              'transition-[color] duration-80',
              isActive || isChecked ? 'text-foreground' : 'text-muted-foreground',
              disabled && 'opacity-50 pointer-events-none',
              className,
            )}
            {...props}
          />
        }
      >
        {Icon && (
          <Icon
            size={sizeClasses.icon}
            strokeWidth={isActive || isChecked ? 2 : 1.5}
            className="shrink-0 transition-[color,stroke-width] duration-80"
          />
        )}

        <SelectPrimitive.ItemText
          // py-1/-my-1 keeps truncate's overflow:hidden from clipping
          // ascenders/descenders outside the trimmed box.
          render={
            <span className="flex-1 min-w-0 truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1" />
          }
        >
          {children}
        </SelectPrimitive.ItemText>

        {/* Fixed slot so the check toggling never resizes the popup. */}
        <span aria-hidden className={cn('shrink-0', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')}>
          {/* initial={false}: a row checked at mount doesn't draw the check. */}
          <AnimatePresence initial={false}>
            {isChecked && (
              <motion.svg
                key="check"
                width={sizeClasses.icon}
                height={sizeClasses.icon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-foreground"
                initial={{ opacity: 1 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 1 }}
              >
                <motion.path
                  d="M4 12L9 17L20 6"
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
            )}
          </AnimatePresence>
        </span>
      </SelectPrimitive.Item>
    );
  },
);

SelectItem.displayName = 'SelectItem';

// ---------------------------------------------------------------------------
// SelectGroup + SelectLabel + SelectSeparator
// ---------------------------------------------------------------------------

function SelectGroup({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: These listbox option groups are not form fieldsets.
    <div role="group" className={className} {...props}>
      {children}
    </div>
  );
}

SelectGroup.displayName = 'SelectGroup';

const SelectLabel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const compact = useSize().variant === 'compact';
    return (
      <div
        ref={ref}
        className={cn(
          'px-2 py-1.5 shrink-0 text-muted-foreground',
          typeClass('caption', compact ? 'compact' : 'default'),
          className,
        )}
        {...props}
      />
    );
  },
);

SelectLabel.displayName = 'SelectLabel';

const SelectSeparator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: Preserve the kit's div ref contract for listbox separators.
    <div
      ref={ref}
      role="separator"
      className={cn('my-1 -mx-1 h-px shrink-0 bg-border/60', className)}
      {...props}
    />
  ),
);

SelectSeparator.displayName = 'SelectSeparator';

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type { SelectContentProps, SelectItemProps, SelectProps, SelectTriggerProps };
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  triggerVariants,
};
