'use client';

import { useDirection } from '@base-ui/react/direction-provider';
import type { MenuTriggerProps } from '@base-ui/react/menu';
import { Menu } from '@base-ui/react/menu';
import { AnimatePresence, motion } from 'motion/react';
import {
  type ComponentProps,
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
import { isOwnEvent, useFluidHover } from '../../hooks/use-fluid-hover.ts';
import {
  SelectionBackgrounds,
  useMergeSplitBlocks,
  useSelectionRuns,
} from '../../hooks/use-merge-split.tsx';
import { Elevated } from '../../lib/elevated.tsx';
import {
  isDisabledRow,
  popupMotionClass,
  popupScrollAreaClass,
  popupViewportClass,
} from '../../lib/popup.ts';
import { shapeMap } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { exitFallbackMs, spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import {
  DropdownEmpty,
  DropdownSearch,
  DropdownSearchHostContext,
  type DropdownSearchProps,
  useDropdownSearchHost,
} from './dropdown-search.tsx';
import {
  type DropdownSubTriggerProps,
  SUBMENU_ALIGN_OFFSET,
  SUBMENU_SIDE_OFFSET,
  SubmenuChevron,
  useReportSubmenu,
  useSubmenuHost,
} from './dropdown-sub.tsx';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';
import {
  DropdownContext,
  type DropdownContextValue,
  MenuItem,
  type MenuItemRenderOptions,
  useControllableOpen,
  useDropdown,
  useDropdownMaybe,
} from './menu-item.tsx';
import { ScrollArea } from './scroll-area.tsx';

// Popovers always use the "rounded" radii, whatever the global shape: pill
// corners distort perceived padding at this scale.
const shape = shapeMap.rounded;

// ---------------------------------------------------------------------------
// Panel context, shared by the inline Dropdown and the popup DropdownContent.
// Defined in menu-item.tsx so MenuItem finds whichever provider wraps it.
// ---------------------------------------------------------------------------

export type { DropdownContextValue, MenuItemRenderOptions };
export { useDropdown, useDropdownMaybe };

// ---------------------------------------------------------------------------
// Dropdown (inline panel)
//
// An always-rendered panel with no trigger or dismissal. It's a plain
// role="group" (pass `aria-label` to name it), not a menu: role="menu"
// belongs on the popup DropdownContent, which Base UI wires to a trigger.
// ---------------------------------------------------------------------------

interface DropdownProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  checkedIndex?: number;
  /** Multiple selection: the checked rows. Rows become checkbox items and
   *  contiguous runs share one merged background (see CheckboxGroup). */
  checkedIndices?: number[];
  /** Pins the rows to one size step (default 36px, compact 28px). Omitted,
   *  they follow the surrounding SizeProvider. */
  size?: SizeVariant;
}

const Dropdown = forwardRef<HTMLDivElement, DropdownProps>(
  ({ children, checkedIndex, checkedIndices, size, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const hover = useFluidHover(containerRef, { isItemDisabled: isDisabledRow });
    const { activeIndex, setActiveIndex, itemRects, handlers, registerItem } = hover;

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    const multiple = checkedIndices != null;
    const checkedRect = !multiple && checkedIndex != null ? itemRects[checkedIndex] : null;
    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    // Multiple: one merged block per contiguous run of checked rows.
    const runs = useSelectionRuns(checkedIndices ?? []);
    const blocks = useMergeSplitBlocks(runs, itemRects, shape.bgRadius);
    const panelCtx = useMemo(
      () => ({ registerItem, activeIndex, checkedIndex, multiple, checkedIndices }),
      [registerItem, activeIndex, checkedIndex, multiple, checkedIndices],
    );
    const panel = (
      <DropdownContext.Provider value={panelCtx}>
        <Elevated
          offset={2}
          shadowLevel={3}
          ref={(node) => {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          onMouseEnter={handlers.onMouseEnter}
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
              setFocusedIndex((e.target as HTMLElement).matches(':focus-visible') ? idx : null);
            }
          }}
          onBlur={(e) => {
            if (containerRef.current?.contains(e.relatedTarget as Node)) return;
            setFocusedIndex(null);
            setActiveIndex(null);
          }}
          onKeyDown={(e) => {
            const items = Array.from(
              containerRef.current?.querySelectorAll(
                '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
              ) ?? [],
            ) as HTMLElement[];
            const currentIdx = items.indexOf(e.target as HTMLElement);
            if (currentIdx === -1) return;

            if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
              e.preventDefault();
              const next = ['ArrowDown', 'ArrowRight'].includes(e.key)
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
          className={cn(
            `relative flex flex-col w-72 max-w-full ${shape.container} p-1 select-none`,
            className,
          )}
          {...props}
        >
          {/* Selected backgrounds — merged runs in multiple mode */}
          {multiple && <SelectionBackgrounds blocks={blocks} />}

          {/* Selected background */}
          <AnimatePresence>
            {checkedRect && (
              <motion.div
                className={`absolute ${shape.bg} bg-active pointer-events-none`}
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

          {/* Hover background */}
          <FluidHoverHighlight hover={hover} from={checkedRect} className={shape.bg} />

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
        </Elevated>
      </DropdownContext.Provider>
    );

    return size ? <SizeProvider size={size}>{panel}</SizeProvider> : panel;
  },
);

Dropdown.displayName = 'Dropdown';

// ---------------------------------------------------------------------------
// DropdownMenu (popup root)
//
// Base UI's Menu owns trigger wiring, positioning, dismissal, roving
// highlight, typeahead and close-on-select. This layer adds the fluid-hover
// overlays and the spring open/close (see usePopupExit).
// ---------------------------------------------------------------------------

interface DropdownMenuActions {
  unmount: () => void;
  close: () => void;
}

// Base UI unmounts a closing popup when the CSS animations it detects end,
// cutting the Motion exit. onOpenChange calls preventUnmountOnClose() and the
// content later calls actionsRef.unmount(). A close made by setting `open`
// skips onOpenChange, so it's replayed through actionsRef.close().
function usePopupExit(open: boolean, setOpen: (open: boolean) => void) {
  const actionsRef = useRef<DropdownMenuActions | null>(null);
  const [rootOpen, setRootOpen] = useState(open);
  if (open && !rootOpen) setRootOpen(true);
  useLayoutEffect(() => {
    if (open || !rootOpen) return;
    // The root fills actionsRef before this effect runs; without it, close
    // straight away rather than stay open.
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

interface DropdownMenuContextValue {
  open: boolean;
  actionsRef: React.RefObject<DropdownMenuActions | null>;
  /** Set by DropdownSub: the content is a submenu. */
  sub: boolean;
}

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(null);

function useDropdownMenuContext() {
  const ctx = useContext(DropdownMenuContext);
  if (!ctx) throw new Error('DropdownMenu compound components must be inside <DropdownMenu>');
  return ctx;
}

interface DropdownMenuProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Pins the trigger content and popup rows to one size step (default 36px,
   *  compact 28px). Omitted, they follow the surrounding SizeProvider. */
  size?: SizeVariant;
}

function DropdownMenu({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  size,
}: DropdownMenuProps) {
  const [open, setOpen] = useControllableOpen(openProp, defaultOpen, onOpenChange);
  const { actionsRef, rootOpen, onOpenChange: handleOpenChange } = usePopupExit(open, setOpen);

  const ctx = useMemo(() => ({ open, actionsRef, sub: false }), [open, actionsRef]);

  // React context crosses portals, so a size prop also reaches the popup.
  const root = (
    <DropdownMenuContext.Provider value={ctx}>
      <Menu.Root
        open={rootOpen}
        onOpenChange={handleOpenChange}
        actionsRef={actionsRef}
        disabled={disabled}
        // Non-modal: the page keeps scrolling and the Positioner tracks the
        // anchor, so the popup follows its trigger instead of detaching.
        modal={false}
      >
        {children}
      </Menu.Root>
    </DropdownMenuContext.Provider>
  );

  return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
}

DropdownMenu.displayName = 'DropdownMenu';

// ---------------------------------------------------------------------------
// DropdownTrigger
//
// Base UI's Menu.Trigger. Use `render` to make any element the trigger:
//
//   <DropdownTrigger render={<Button variant="secondary">Open</Button>} />
// ---------------------------------------------------------------------------

type DropdownTriggerProps = MenuTriggerProps;

const DropdownTrigger = Menu.Trigger;

// ---------------------------------------------------------------------------
// DropdownContent (popup panel)
//
// Portal > Positioner > Popup with the inline panel's visuals. Children sit
// in a Menu.RadioGroup so radio MenuItems get aria-checked from
// `checkedIndex`.
// ---------------------------------------------------------------------------

type MenuPositionerProps = ComponentProps<typeof Menu.Positioner>;

type LitBy = 'open' | 'pointer' | 'keyboard';

interface DropdownContentProps {
  children: ReactNode;
  className?: string;
  /** Index of the checked item. Drives the animated selected background and
   *  the radio-group value announced to assistive tech. */
  checkedIndex?: number;
  /** Multiple selection: the checked rows. Rows become checkbox items that
   *  keep the menu open when toggled, and contiguous runs share one merged
   *  background (see CheckboxGroup). */
  checkedIndices?: number[];
  side?: MenuPositionerProps['side'];
  align?: MenuPositionerProps['align'];
  sideOffset?: number;
  /** Shift along the trigger edge, in px. */
  alignOffset?: number;
}

const DropdownContent = forwardRef<HTMLDivElement, DropdownContentProps>(
  (
    {
      className,
      children,
      checkedIndex,
      checkedIndices,
      side = 'bottom',
      align = 'start',
      sideOffset = 6,
      alignOffset = 0,
    },
    ref,
  ) => {
    const { open, actionsRef, sub } = useDropdownMenuContext();
    const containerRef = useRef<HTMLDivElement>(null);

    const hover = useFluidHover(containerRef, { isItemDisabled: isDisabledRow });
    const { activeIndex, setActiveIndex, itemRects, handlers, registerItem, remeasure } = hover;

    // Submenus opened from these rows: their trigger stays lit while the
    // pointer crosses to them (see dropdown-sub.tsx).
    const submenus = useSubmenuHost(containerRef, hover, open);

    // An optional DropdownSearch child: typing on a focused row is
    // redirected into the field.
    const {
      host: searchHost,
      hasSearch,
      searchTakesFocus,
      searchMounted,
      onKeyDownCapture: redirectTypingToSearch,
    } = useDropdownSearchHost(open);

    // Focus the first enabled row (a search field focuses itself), a frame
    // after Base UI's own open autofocus. Not for submenus: hovering the
    // trigger must leave focus in the parent.
    useEffect(() => {
      if (!open || sub) return;
      let inner: number | undefined;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          if (hasSearch()) return;
          const container = containerRef.current;
          if (
            !container ||
            (container.contains(document.activeElement) && document.activeElement !== container)
          )
            return;
          const first = container.querySelector<HTMLElement>(
            '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"])',
          );
          first?.focus();
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        if (inner !== undefined) cancelAnimationFrame(inner);
      };
    }, [open, sub, hasSearch]);

    // Fallback for onAnimationComplete, which can stall in throttled
    // background tabs: release the deferred unmount after the exit.
    useEffect(() => {
      if (open) return;
      const id = setTimeout(() => actionsRef.current?.unmount(), exitFallbackMs(spring.fast));
      return () => clearTimeout(id);
    }, [open, actionsRef]);

    // Rows stay registered between opens, so re-measure once laid out.
    useEffect(() => {
      if (!open) return;
      remeasure();
    }, [open, remeasure]);

    const multiple = checkedIndices != null;
    const checkedRect = !multiple && checkedIndex != null ? itemRects[checkedIndex] : null;
    // What lit the highlight. Only a pointer highlight glides in from the
    // checked row; open and keyboard highlights fade in in place. Handlers
    // read the ref (a key press sets it before its focus lands); render
    // reads the state.
    const litByRef = useRef<LitBy>('open');
    const [litBy, setLitBy] = useState<LitBy>('open');
    const [litByOpen, setLitByOpen] = useState(open);
    if (litByOpen !== open) {
      setLitByOpen(open);
      if (open) setLitBy('open');
    }
    useEffect(() => {
      if (open) litByRef.current = 'open';
    }, [open]);
    const markLitBy = (by: LitBy) => {
      litByRef.current = by;
      setLitBy(by);
    };
    // Multiple: one merged block per contiguous run of checked rows.
    const runs = useSelectionRuns(checkedIndices ?? []);
    const blocks = useMergeSplitBlocks(runs, open ? itemRects : [], shape.bgRadius);
    // Base UI's items own role, aria-checked, highlight, typeahead and
    // activation. The handler goes on the primitive's onClick: Enter/Space
    // call it without dispatching a DOM click. The render div has the visuals.
    const renderMenuItem = useCallback(
      ({
        radio,
        checkbox,
        checked,
        value,
        disabled,
        label,
        closeOnClick,
        onActivate,
        element,
        children,
      }: MenuItemRenderOptions) =>
        checkbox ? (
          // onActivate toggles the consumer state; the primitive only owns
          // the role, aria-checked, and keyboard activation.
          <Menu.CheckboxItem
            checked={!!checked}
            disabled={disabled}
            label={label}
            closeOnClick={closeOnClick}
            onClick={onActivate}
            render={element}
          >
            {children}
          </Menu.CheckboxItem>
        ) : radio ? (
          <Menu.RadioItem
            value={value}
            disabled={disabled}
            label={label}
            closeOnClick={closeOnClick}
            onClick={onActivate}
            render={element}
          >
            {children}
          </Menu.RadioItem>
        ) : (
          <Menu.Item
            disabled={disabled}
            label={label}
            closeOnClick={closeOnClick}
            onClick={onActivate}
            render={element}
          >
            {children}
          </Menu.Item>
        ),
      [],
    );

    const contentCtx = useMemo(
      () => ({
        registerItem,
        activeIndex,
        checkedIndex,
        multiple,
        checkedIndices,
        inMenu: true,
        renderMenuItem,
        onSubmenuOpenChange: submenus.onSubmenuOpenChange,
      }),
      [
        registerItem,
        activeIndex,
        checkedIndex,
        multiple,
        checkedIndices,
        renderMenuItem,
        submenus.onSubmenuOpenChange,
      ],
    );

    return (
      <Menu.Portal>
        <Menu.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
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
            // Release the held unmount once the exit spring has finished.
            onAnimationComplete={() => {
              if (!open) actionsRef.current?.unmount();
            }}
          >
            <DropdownContext.Provider value={contentCtx}>
              <DropdownSearchHostContext.Provider value={searchHost}>
                <Menu.Popup
                  data-slot="menu-popup"
                  render={<Elevated offset={2} shadowLevel={3} ref={ref} />}
                  // Skip events from an open submenu: they bubble here through
                  // the React portal, and its row focus would light the parent
                  // row with the same index.
                  onKeyDownCapture={(e) => {
                    if (!isOwnEvent(e)) return;
                    markLitBy('keyboard');
                    redirectTypingToSearch(e);
                  }}
                  onMouseEnter={(e) => {
                    if (!isOwnEvent(e)) return;
                    markLitBy('pointer');
                    submenus.onMouseEnter();
                  }}
                  onMouseMove={(e) => {
                    if (!isOwnEvent(e)) return;
                    markLitBy('pointer');
                    submenus.onMouseMove(e);
                  }}
                  onClick={handlers.onClick}
                  onMouseLeave={(e) => {
                    if (!isOwnEvent(e)) return;
                    submenus.onMouseLeave();
                  }}
                  onFocus={(e) => {
                    if (!isOwnEvent(e)) return;
                    const indexAttr = (e.target as HTMLElement)
                      .closest('[data-fluid-hover-index]')
                      ?.getAttribute('data-fluid-hover-index');
                    // No focus ring: in a menu the highlighted row is the
                    // focus indicator.
                    if (indexAttr != null) {
                      // Base UI's open autofocus hits the first row a frame
                      // before the search field takes over: keep it unlit.
                      if (litByRef.current === 'open' && searchTakesFocus()) return;
                      setActiveIndex(Number(indexAttr));
                    } else if (e.target !== e.currentTarget) {
                      // Focus on a non-row (e.g. the search field) clears the
                      // highlight; the popup focusing itself doesn't.
                      setActiveIndex(null);
                    }
                  }}
                  onBlur={(e) => {
                    if (!isOwnEvent(e)) return;
                    // Only leaving the whole popup ends the hover session.
                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                    // Focus moving into an open submenu keeps its trigger lit.
                    if (submenus.holding()) return;
                    setActiveIndex(null);
                  }}
                  className={cn(
                    // min-w tracks the trigger (--anchor-width); a submenu,
                    // anchored to a row, keeps its own narrower width.
                    `flex flex-col ${sub ? 'w-56' : 'w-72 min-w-[var(--anchor-width)]'} max-w-full max-h-[min(480px,var(--available-height))] overflow-hidden ${shape.container} select-none outline-none`,
                    className,
                  )}
                >
                  {/* The list scrolls inside a ScrollArea; this wrapper is the rows'
                    offsetParent, so the overlays scroll with them. */}
                  <ScrollArea
                    className={popupScrollAreaClass}
                    viewportClassName={cn(popupViewportClass, !searchMounted && 'scroll-fade')}
                  >
                    <div ref={containerRef} className="relative flex flex-col p-1">
                      {/* Selected backgrounds — merged runs in multiple mode */}
                      {multiple && <SelectionBackgrounds blocks={blocks} />}

                      {/* Selected background */}
                      <AnimatePresence>
                        {checkedRect && (
                          <motion.div
                            className={`absolute ${shape.bg} bg-active pointer-events-none`}
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

                      {/* Hover background */}
                      <FluidHoverHighlight
                        hover={hover}
                        from={litBy === 'pointer' ? checkedRect : null}
                        className={shape.bg}
                      />

                      {/* display: contents keeps items direct flex children, so
                    hover measurement and layout still work. */}
                      <Menu.RadioGroup value={checkedIndex ?? null} className="contents">
                        {children}
                      </Menu.RadioGroup>
                    </div>
                  </ScrollArea>
                </Menu.Popup>
              </DropdownSearchHostContext.Provider>
            </DropdownContext.Provider>
          </motion.div>
        </Menu.Positioner>
      </Menu.Portal>
    );
  },
);

DropdownContent.displayName = 'DropdownContent';

// ---------------------------------------------------------------------------
// DropdownSub, DropdownSubTrigger, DropdownSubContent (submenus)
//
//   <DropdownSub>
//     <DropdownSubTrigger index={2} icon={Palette} label="Theme" />
//     <DropdownSubContent checkedIndex={theme}>
//       <MenuItem index={0} label="Light" checked={theme === 0} … />
//     </DropdownSubContent>
//   </DropdownSub>
//
// Base UI's SubmenuRoot owns hover-to-open, the safe area, →/← and Escape.
// DropdownSubContent is DropdownContent placed beside its trigger row. The
// trigger is indexed among its parent's rows; submenu rows index from 0.
// ---------------------------------------------------------------------------

interface DropdownSubProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function DropdownSub({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: DropdownSubProps) {
  const [open, setOpen] = useControllableOpen(openProp, defaultOpen, onOpenChange);
  const { actionsRef, rootOpen, onOpenChange: handleOpenChange } = usePopupExit(open, setOpen);

  const ctx = useMemo(() => ({ open, actionsRef, sub: true }), [open, actionsRef]);

  return (
    <DropdownMenuContext.Provider value={ctx}>
      <Menu.SubmenuRoot open={rootOpen} onOpenChange={handleOpenChange} actionsRef={actionsRef}>
        {children}
      </Menu.SubmenuRoot>
    </DropdownMenuContext.Provider>
  );
}

DropdownSub.displayName = 'DropdownSub';

const DropdownSubTrigger = forwardRef<HTMLDivElement, DropdownSubTriggerProps>(
  ({ index, ...props }, ref) => {
    const parent = useDropdown();
    const { open } = useDropdownMenuContext();
    useReportSubmenu(parent.onSubmenuOpenChange, index, open);
    const lit = parent.activeIndex === index;

    // The row renders through the parent's MenuItem, wrapped in the submenu
    // trigger primitive instead of a plain item.
    const renderMenuItem = useCallback(
      ({ disabled, label, onActivate, element, children }: MenuItemRenderOptions) => (
        <Menu.SubmenuTrigger
          disabled={disabled}
          label={label}
          onClick={onActivate}
          render={element}
        >
          {children}
          <SubmenuChevron lit={lit} />
        </Menu.SubmenuTrigger>
      ),
      [lit],
    );
    const ctx = useMemo(() => ({ ...parent, renderMenuItem }), [parent, renderMenuItem]);

    return (
      <DropdownContext.Provider value={ctx}>
        <MenuItem ref={ref} index={index} {...props} />
      </DropdownContext.Provider>
    );
  },
);

DropdownSubTrigger.displayName = 'DropdownSubTrigger';

type DropdownSubContentProps = Omit<DropdownContentProps, 'side' | 'align'>;

/** The submenu popup, beside its trigger row and opening toward the reading
 *  direction's end (a physical side, so the `data-side` animation applies). */
const DropdownSubContent = forwardRef<HTMLDivElement, DropdownSubContentProps>(
  ({ sideOffset = SUBMENU_SIDE_OFFSET, alignOffset = SUBMENU_ALIGN_OFFSET, ...props }, ref) => {
    const direction = useDirection();
    return (
      <DropdownContent
        ref={ref}
        side={direction === 'rtl' ? 'left' : 'right'}
        align="start"
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        {...props}
      />
    );
  },
);

DropdownSubContent.displayName = 'DropdownSubContent';

// ---------------------------------------------------------------------------
// DropdownLabel
// ---------------------------------------------------------------------------

const DropdownLabel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    // Group labels use the caption type role.
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

DropdownLabel.displayName = 'DropdownLabel';

// ---------------------------------------------------------------------------
// DropdownSeparator
// ---------------------------------------------------------------------------

const DropdownSeparator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: Preserve the copied kit's separator element and div ref contract.
    <div
      ref={ref}
      role="separator"
      className={cn('my-1 -mx-1 h-px shrink-0 bg-border/60', className)}
      {...props}
    />
  ),
);

DropdownSeparator.displayName = 'DropdownSeparator';

// DropdownContextValue and MenuItemRenderOptions are exported above;
// repeating them here is a duplicate-export error.
export type {
  DropdownContentProps,
  DropdownMenuProps,
  DropdownProps,
  DropdownSearchProps,
  DropdownSubContentProps,
  DropdownSubProps,
  DropdownSubTriggerProps,
  DropdownTriggerProps,
};
export {
  Dropdown,
  DropdownContent,
  DropdownEmpty,
  DropdownLabel,
  DropdownMenu,
  DropdownSearch,
  DropdownSeparator,
  DropdownSub,
  DropdownSubContent,
  DropdownSubTrigger,
  DropdownTrigger,
};
export default Dropdown;
