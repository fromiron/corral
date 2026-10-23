'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { motion, useReducedMotion } from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { omit } from '../../lib/omit.ts';
import { exitFallbackMs, spring } from '../../lib/springs.ts';
import { surfaceClasses } from '../../lib/surface-classes.ts';
import { SurfaceProvider, useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';
import { ScrollArea } from './scroll-area.tsx';
import {
  type SidebarCollapsible,
  SidebarShell,
  type SidebarSide,
  type SidebarVariant,
  useSidebar,
} from './sidebar-core.tsx';

// ─── Mobile sheet ────────────────────────────────────────────────────────────
//
// Built on Base UI Dialog, not Drawer: Drawer's swipe-to-dismiss writes inline
// transforms that fight Motion on the same element. Dialog still provides
// scroll lock, focus trap/restore, and Esc + outside-click dismissal.

// Props Motion redefines with incompatible signatures; never forward them
// from Base UI's render-prop payload onto a motion.div.
type MotionSafeDivProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
>;

interface SidebarSheetProps {
  side: SidebarSide;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

function SidebarSheet({ side, open, onClose, children }: SidebarSheetProps) {
  const { widthMobile } = useSidebar();
  // Reduced motion drops the slide but keeps the scrim's opacity fade.
  const reduceMotion = useReducedMotion() ?? false;
  // The panel takes initial focus itself; otherwise the first nav row gets
  // focus (and Chrome's :focus-visible ring) and looks selected on open.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const substrate = useSurface();
  const level = Math.min(substrate + 2, 8);

  // The primitive unmounts its portal immediately on close, so the dialog is
  // held open while `closing` slides the panel out; the real close follows.
  const [closing, setClosing] = useState(false);
  const visible = open && !closing;

  const finishClose = useCallback(() => {
    setClosing(false);
    onClose();
  }, [onClose]);

  // Parent-driven closes (trigger, shortcut, route change) get the same exit.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) setClosing(true);
    wasOpen.current = open;
  }, [open]);

  // Fallback: rAF-driven animation callbacks stall in throttled tabs.
  useEffect(() => {
    if (!closing) return;
    const id = setTimeout(finishClose, exitFallbackMs(spring.moderate));
    return () => clearTimeout(id);
  }, [closing, finishClose]);

  const offscreen = side === 'left' ? '-100%' : '100%';

  return (
    <DialogPrimitive.Root
      open={open || closing}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setClosing(true);
      }}
    >
      <DialogPrimitive.Portal>
        {/* `dark:` only matches the explicit .dark class, so the /40 base
            keeps the scrim visible for system-dark users. */}
        <DialogPrimitive.Backdrop
          render={(backdropProps) => {
            const rest = omit(backdropProps as React.HTMLAttributes<HTMLDivElement>, ['style']);
            return (
              <motion.div
                {...(rest as MotionSafeDivProps)}
                className="fixed inset-0 bg-black/40 dark:bg-black/80 z-40"
                initial={{ opacity: 0 }}
                animate={{ opacity: visible ? 1 : 0 }}
                transition={visible ? { duration: spring.moderate.duration } : spring.moderate.exit}
              />
            );
          }}
        />

        <DialogPrimitive.Popup
          aria-label="Sidebar"
          initialFocus={panelRef}
          render={(popupProps) => {
            const {
              style: baseStyle,
              ref: baseRef,
              ...rest
            } = popupProps as React.HTMLAttributes<HTMLDivElement> & {
              ref?: React.Ref<HTMLDivElement>;
            };
            return (
              <motion.div
                {...(rest as MotionSafeDivProps)}
                // Merge refs: both the primitive and initialFocus need the node.
                ref={(node: HTMLDivElement | null) => {
                  panelRef.current = node;
                  if (typeof baseRef === 'function') baseRef(node);
                  else if (baseRef)
                    (baseRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
                }}
                tabIndex={-1}
                data-sidebar="sidebar"
                data-mobile="true"
                data-side={side}
                className={cn(
                  'fixed inset-y-0 z-50 flex flex-col overflow-hidden outline-none',
                  !visible && 'pointer-events-none',
                  side === 'left' ? 'left-0' : 'right-0',
                  surfaceClasses(level, 3),
                )}
                style={{
                  ...(baseStyle as CSSProperties | undefined),
                  width: widthMobile,
                }}
                initial={{ x: offscreen }}
                // Critically damped: overshoot would expose the page behind.
                animate={{ x: visible ? 0 : offscreen }}
                transition={
                  reduceMotion ? { duration: 0 } : visible ? spring.moderate : spring.moderate.exit
                }
                onAnimationComplete={() => {
                  if (closing) finishClose();
                }}
              >
                <SurfaceProvider value={level}>{children}</SurfaceProvider>
              </motion.div>
            );
          }}
        />
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export interface SidebarProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | 'onDrag'
    | 'onDragStart'
    | 'onDragEnd'
    | 'onAnimationStart'
    | 'onAnimationEnd'
    | 'onAnimationIteration'
  > {
  side?: SidebarSide;
  variant?: SidebarVariant;
  /** `"icon"` collapse is intentionally not supported — offcanvas or none. */
  collapsible?: SidebarCollapsible;
  /** The `sidebar` variant's inner-edge border. Default true. */
  bordered?: boolean;
  /** Pin the rail's tooltip open (`true`) or closed (`false`); `undefined`
   *  leaves it on hover. Dragging always hides it. */
  railTooltipOpen?: boolean;
  /** Render the built-in resize/collapse rail. Default true. */
  rail?: boolean;
}

const Sidebar = forwardRef<HTMLDivElement, SidebarProps>(
  (
    {
      side = 'left',
      variant = 'sidebar',
      collapsible = 'offcanvas',
      bordered = true,
      rail = true,
      railTooltipOpen,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const { isMobile, openMobile, setOpenMobile, width, registerSide } = useSidebar();

    // The provider uses the side for the default shortcut ("[" / "]") and rail.
    useEffect(() => registerSide(side), [side, registerSide]);

    if (collapsible === 'none') {
      return (
        <div
          ref={ref}
          data-slot="sidebar"
          data-variant={variant}
          data-side={side}
          className={cn(
            'peer sticky top-0 flex h-svh shrink-0 flex-col',
            side === 'right' && 'order-last',
            className,
          )}
          style={{ width, ...style } as CSSProperties}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className={cn(
              'flex h-full w-full min-h-0 flex-col',
              bordered &&
                variant === 'sidebar' &&
                (side === 'left' ? 'border-r border-border' : 'border-l border-border'),
            )}
          >
            {children}
          </div>
        </div>
      );
    }

    // The desktop shell stays mounted below the drawer breakpoint and is
    // hidden by its own breakpoint classes, so it fades out instead of
    // snapping away; the sheet mounts alongside it.
    return (
      <>
        {isMobile && (
          <SidebarSheet side={side} open={openMobile} onClose={() => setOpenMobile(false)}>
            {children}
          </SidebarSheet>
        )}
        <SidebarShell
          ref={ref}
          side={side}
          variant={variant}
          bordered={bordered}
          rail={rail}
          railTooltipOpen={railTooltipOpen}
          className={className}
          style={style}
          {...props}
        >
          {children}
        </SidebarShell>
      </>
    );
  },
);
Sidebar.displayName = 'Sidebar';

// ─── SidebarContent ──────────────────────────────────────────────────────────

export interface SidebarContentProps extends HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
}

const SidebarContent = forwardRef<HTMLDivElement, SidebarContentProps>(
  ({ className, viewportClassName, children, ...props }, ref) => {
    const { isMobile } = useSidebar();

    // In the mobile sheet this region scrolls natively (a nested ScrollArea
    // would double-scroll). scroll-divider sits on a wrapper because the
    // scroller's fade mask would erase the line.
    if (isMobile) {
      return (
        <div className="scroll-divider [--scroll-divider-inset:8px] flex min-h-0 w-full flex-1 flex-col">
          <div
            ref={ref}
            data-sidebar="content"
            className={cn(
              'scroll-fade flex min-h-0 w-full flex-1 flex-col overflow-y-auto',
              className,
            )}
            {...props}
          >
            {children}
          </div>
        </div>
      );
    }

    // The viewport's content-sized inner wrapper is forced back to a
    // shrinkable block so rows truncate instead of overflowing.
    return (
      <ScrollArea
        className={cn('scroll-divider min-h-0 w-full flex-1', className)}
        viewportClassName={cn('scroll-fade [&>div]:!block [&>div]:!min-w-0', viewportClassName)}
      >
        <div ref={ref} data-sidebar="content" className="flex w-full min-w-0 flex-col" {...props}>
          {children}
        </div>
      </ScrollArea>
    );
  },
);
SidebarContent.displayName = 'SidebarContent';

export type {
  SidebarCollapsible,
  SidebarContextValue,
  SidebarGroupActionProps,
  SidebarGroupLabelProps,
  SidebarInputProps,
  SidebarInsetProps,
  SidebarProviderProps,
  SidebarRailProps,
  SidebarSectionProps,
  SidebarSide,
  SidebarTriggerProps,
  SidebarVariant,
} from './sidebar-core.tsx';

// Re-export the shared parts so `sidebar` is a one-stop import.
export {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_KEYBOARD_SHORTCUT,
  SIDEBAR_KEYBOARD_SHORTCUT_RIGHT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_MOBILE,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupActions,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from './sidebar-core.tsx';
export type {
  SidebarMenuActionProps,
  SidebarMenuBadgeProps,
  SidebarMenuButtonProps,
  SidebarMenuItemProps,
  SidebarMenuProps,
  SidebarMenuSkeletonProps,
  SidebarMenuSubButtonProps,
  SidebarMenuSubItemProps,
  SidebarMenuSubProps,
} from './sidebar-menu.tsx';
export {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  sidebarMenuButtonVariants,
} from './sidebar-menu.tsx';
export { Sidebar, SidebarContent };
