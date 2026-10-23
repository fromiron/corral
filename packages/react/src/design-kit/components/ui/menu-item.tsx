'use client';

import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import type { IconComponent } from '../../lib/icon-context.tsx';
import { shapeMap } from '../../lib/shape-context.tsx';
import { useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';

// Dropdown opts out of the global pill shape (see dropdown.tsx).
const shape = shapeMap.rounded;

// ---------------------------------------------------------------------------
// Dropdown context — defined here so MenuItem stays primitive-free;
// dropdown.tsx re-exports useDropdown.
// ---------------------------------------------------------------------------

/** What MenuItem hands the popup's primitive wrapper: the styled row
 *  `element` and its `children`, wrapped in the dropdown's Item primitive. */
export interface MenuItemRenderOptions {
  /** Radio-style option (boolean `checked` on MenuItem) vs plain action item. */
  radio: boolean;
  /** Checkbox-style option in a multiple-selection dropdown; beats `radio`. */
  checkbox: boolean;
  /** The item's checked state (radio and checkbox items). */
  checked?: boolean;
  /** The item's index — doubles as the radio value. */
  value: number;
  disabled?: boolean;
  label: string;
  closeOnClick: boolean;
  /** Activation handler; pass it to the primitive item's `onClick`, not to
   *  `element`, since Base UI's Enter/Space dispatches no DOM click. */
  onActivate?: (e: React.MouseEvent<HTMLDivElement>) => void;
  element: ReactElement;
  children: ReactNode;
}

export interface DropdownContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  checkedIndex?: number;
  /** Multiple selection: rows are checkboxes and stay open on activation. */
  multiple?: boolean;
  checkedIndices?: number[];
  /** True inside a Menu popup, where the primitive owns roles and activation. */
  inMenu?: boolean;
  /** Popup-only: wraps the styled div in the menu-item primitive. Absent in
   *  the inline panel, where MenuItem renders its own menuitem div. */
  renderMenuItem?: (opts: MenuItemRenderOptions) => ReactElement;
  /** Popup-only: keeps a sub-trigger row lit while its submenu is open. */
  onSubmenuOpenChange?: (index: number, open: boolean) => void;
}

export const DropdownContext = createContext<DropdownContextValue | null>(null);

export function useDropdown() {
  const ctx = useContext(DropdownContext);
  if (!ctx) throw new Error('useDropdown must be used within a Dropdown');
  return ctx;
}

/** Null-safe context read for callers that render outside a provider. */
export function useDropdownMaybe() {
  return useContext(DropdownContext);
}

/** Controllable open state. The primitive always gets a controlled value so
 *  the popup can play its exit animation before unmounting. */
export function useControllableOpen(
  openProp: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange?: (open: boolean) => void,
) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = openProp !== undefined ? openProp : internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  return [open, setOpen] as const;
}

export interface MenuItemProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional leading icon; omitted, no icon column is reserved. */
  icon?: IconComponent;
  label: string;
  /** Visible label content; label remains the accessible name and typeahead text. */
  labelContent?: ReactNode;
  index: number;
  /** A boolean makes a radio-style option; undefined is a plain action item. */
  checked?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  /** Popup-only: whether activating closes the menu. @default true */
  closeOnClick?: boolean;
}

const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(
  (
    {
      icon: Icon,
      label,
      labelContent,
      index,
      checked,
      onSelect,
      disabled,
      closeOnClick,
      className,
      onClick,
      ...props
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const { registerItem, activeIndex, checkedIndex, multiple, checkedIndices, renderMenuItem } =
      useDropdown();
    const isCheckbox = !!multiple && typeof checked === 'boolean';

    useRegisterFluidHoverItem(registerItem, index, internalRef);

    const isActive = activeIndex === index;
    const sizeClasses = useSize();

    const mergeRef = (node: HTMLDivElement | null) => {
      (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    };

    const handleActivate = disabled
      ? undefined
      : (e: React.MouseEvent<HTMLDivElement>) => {
          onClick?.(e);
          onSelect?.();
        };

    const itemClassName = cn(
      // Fixed height so text-box trim can't shrink the row; shrink-0 so a
      // long list scrolls instead of compressing rows.
      `relative z-10 flex ${sizeClasses.control} shrink-0 items-center ${sizeClasses.gap} ${shape.item} ${sizeClasses.itemPx} cursor-pointer outline-none`,
      disabled && 'opacity-50 pointer-events-none',
      className,
    );

    const content = (
      <>
        {Icon && (
          <span className="inline-grid">
            <span className="col-start-1 row-start-1 invisible">
              <Icon size={sizeClasses.icon} strokeWidth={2} />
            </span>
            <Icon
              size={sizeClasses.icon}
              strokeWidth={isActive || checked ? 2 : 1.5}
              className={cn(
                'col-start-1 row-start-1 transition-[color,stroke-width] duration-80',
                isActive || checked ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
          </span>
        )}
        {/* Invisible semibold sizer; both spans share the text-box trim. */}
        <span className={cn('inline-grid flex-1', sizeClasses.text)}>
          <span
            className="col-start-1 row-start-1 invisible [text-box:trim-both_cap_alphabetic]"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {labelContent ?? label}
          </span>
          <span
            className={cn(
              'col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]',
              isActive || checked ? 'text-foreground' : 'text-muted-foreground',
            )}
            style={{
              fontVariationSettings: checked ? fontWeights.semibold : fontWeights.normal,
            }}
          >
            {labelContent ?? label}
          </span>
        </span>
        {/* initial={false}: default selections don't animate on mount. */}
        <AnimatePresence initial={false}>
          {checked && (
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
              className="text-foreground shrink-0"
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
      </>
    );

    if (renderMenuItem) {
      // In a popup the primitive owns role, focus and activation; the styled
      // div only carries visuals and fluid-hover registration.
      return renderMenuItem({
        radio: !isCheckbox && typeof checked === 'boolean',
        checkbox: isCheckbox,
        checked,
        value: index,
        disabled,
        label,
        // Toggling one of several stays open; picking one of one closes.
        closeOnClick: closeOnClick ?? !multiple,
        onActivate: handleActivate,
        element: (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: The menu primitive supplies the role to this render element.
          <div
            ref={mergeRef}
            data-fluid-hover-index={index}
            aria-label={label}
            className={itemClassName}
            {...props}
          />
        ),
        children: content,
      });
    }

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Every computed role below is an interactive menu item.
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is present only for the computed radio or checkbox role.
      <div
        ref={mergeRef}
        data-fluid-hover-index={index}
        // Disabled items are never the roving tab stop.
        tabIndex={!disabled && index === (checkedIndex ?? checkedIndices?.[0] ?? 0) ? 0 : -1}
        role={
          isCheckbox
            ? 'menuitemcheckbox'
            : typeof checked === 'boolean'
              ? 'menuitemradio'
              : 'menuitem'
        }
        aria-checked={typeof checked === 'boolean' ? checked : undefined}
        aria-disabled={disabled || undefined}
        aria-label={label}
        onClick={handleActivate}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onSelect?.();
          }
        }}
        className={itemClassName}
        {...props}
      >
        {content}
      </div>
    );
  },
);

MenuItem.displayName = 'MenuItem';

export { MenuItem };
export default MenuItem;
