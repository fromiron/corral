'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { motion } from 'motion/react';
import {
  type ButtonHTMLAttributes,
  createContext,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { omit } from '../../lib/omit.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { typeClass, useSize, useSizeVariant } from '../../lib/size-context.tsx';
import { exitFallbackMs, spring } from '../../lib/springs.ts';
import { surfaceClasses } from '../../lib/surface-classes.ts';
import { SurfaceProvider, useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';
import { Button } from './button.tsx';

const DIALOG_OFFSET = 4;

interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: DialogPrimitive.Root.Props['onOpenChange'];
  modal?: boolean;
  children?: ReactNode;
}

type DialogActions = DialogPrimitive.Root.Actions;

// Base UI can't detect the Motion exit spring and would cut it. Closes hold
// the unmount via preventUnmountOnClose() until the content calls
// actionsRef.unmount(); a controlled close (setting `open`) skips
// onOpenChange, so it's replayed through actionsRef.close().
function usePopupExit(
  open: boolean,
  setOpen: (open: boolean, details: DialogPrimitive.Root.ChangeEventDetails) => void,
) {
  const actionsRef = useRef<DialogActions | null>(null);
  const [rootOpen, setRootOpen] = useState(open);
  if (open && !rootOpen) setRootOpen(true);
  useLayoutEffect(() => {
    if (open || !rootOpen) return;
    // Without actionsRef, close straight away rather than stay open.
    if (actionsRef.current) actionsRef.current.close();
    else setRootOpen(false);
  }, [open, rootOpen]);
  const onOpenChange = (next: boolean, details: DialogPrimitive.Root.ChangeEventDetails) => {
    // Consumers can reject nested-overlay Escape or IME dismissal before the exit starts.
    if (next !== open) setOpen(next, details);
    if (details.isCanceled) return;
    if (!next) {
      details.preventUnmountOnClose();
      setRootOpen(false);
    }
  };
  return { actionsRef, rootOpen: open || rootOpen, onOpenChange };
}

// Lets DialogContent release the held unmount once its exit spring ends.
const DialogExitContext = createContext<{
  open: boolean;
  actionsRef: React.RefObject<DialogActions | null>;
} | null>(null);

function Dialog({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  modal,
}: DialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (next: boolean, details: DialogPrimitive.Root.ChangeEventDetails) => {
    onOpenChange?.(next, details);
    if (!details.isCanceled && openProp === undefined) setUncontrolledOpen(next);
  };
  const { actionsRef, rootOpen, onOpenChange: handleOpenChange } = usePopupExit(open, setOpen);
  const exit = useMemo(() => ({ open, actionsRef }), [open, actionsRef]);

  return (
    <DialogExitContext.Provider value={exit}>
      <DialogPrimitive.Root
        open={rootOpen}
        onOpenChange={handleOpenChange}
        actionsRef={actionsRef}
        modal={modal}
      >
        {children}
      </DialogPrimitive.Root>
    </DialogExitContext.Provider>
  );
}

// Trigger and Close compose via `render={<Button/>}` or `asChild` with a
// single child. Only plain button attributes are exposed; the state-typed
// render/className/style function forms stay off the public surface.
interface DialogSlotProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Element to render as the control, e.g. a Button. */
  render?: ReactElement;
  /** Compose onto the single child element instead. */
  asChild?: boolean;
}

function slotRender(
  render: ReactElement | undefined,
  asChild: boolean | undefined,
  children: ReactNode,
) {
  if (render) return render;
  return asChild && isValidElement(children) ? (children as ReactElement) : undefined;
}

const DialogTrigger = forwardRef<HTMLButtonElement, DialogSlotProps>(
  ({ render, asChild, children, ...props }, ref) => {
    const el = slotRender(render, asChild, children);
    return el ? (
      <DialogPrimitive.Trigger ref={ref} render={el} {...props} />
    ) : (
      <DialogPrimitive.Trigger ref={ref} {...props}>
        {children}
      </DialogPrimitive.Trigger>
    );
  },
);
DialogTrigger.displayName = 'DialogTrigger';

const DialogClose = forwardRef<HTMLButtonElement, DialogSlotProps>(
  ({ render, asChild, children, ...props }, ref) => {
    const el = slotRender(render, asChild, children);
    return el ? (
      <DialogPrimitive.Close ref={ref} render={el} {...props} />
    ) : (
      <DialogPrimitive.Close ref={ref} {...props}>
        {children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = 'DialogClose';

interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  initialFocus?: React.ComponentProps<typeof DialogPrimitive.Popup>['initialFocus'];
  finalFocus?: React.ComponentProps<typeof DialogPrimitive.Popup>['finalFocus'];
  /** Width: sm 400, lg 540, xl 880 (each one notch narrower in compact
   *  regions). `xl` is the canvas for composed layouts — a sidebar beside
   *  a panel — which usually pair it with `className="p-0"` and a fixed
   *  height. */
  size?: 'sm' | 'lg' | 'xl';
  /** Portal target. When set, the overlay and panel render inside this element
   *  (positioned `absolute`) instead of covering the viewport (`fixed`). Pair
   *  with a `position: relative; overflow: hidden` container — and usually
   *  `<Dialog modal={false}>` — to scope a dialog to a bounded region, e.g. a
   *  docs preview. Defaults to the document body / full-viewport behaviour. */
  container?: HTMLElement | null;
  /** The ✕ in the top-right corner. Drop it when the content has its own
   *  way out, e.g. a command menu that closes on Escape and on a pick.
   *  @default true */
  showCloseButton?: boolean;
  /** Where the panel sits: centered, or anchored 12dvh from the top so a
   *  panel whose height follows its content (a command menu) keeps its top
   *  edge still, or at the left edge for a navigation drawer. @default "center" */
  position?: 'center' | 'top' | 'left';
}

const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      size = 'sm',
      container,
      showCloseButton = true,
      position = 'center',
      initialFocus,
      finalFocus,
      ...props
    },
    ref,
  ) => {
    const icons = useIcons();
    const XIcon = icons.x;
    const shape = useShape();
    const substrate = useSurface();
    const dialogLevel = Math.min(substrate + DIALOG_OFFSET, 8);
    // Compact regions narrow the dialog one notch; padding stays the same.
    const compact = useSize().variant === 'compact';

    // onAnimationComplete releases the held unmount (see usePopupExit); this
    // timeout is the fallback for throttled tabs, where rAF callbacks stall.
    const exit = useContext(DialogExitContext);
    const exitOpen = exit?.open ?? true;
    const exitActionsRef = exit?.actionsRef;
    useEffect(() => {
      if (exitOpen) return;
      const id = setTimeout(() => exitActionsRef?.current?.unmount(), exitFallbackMs(spring.slow));
      return () => clearTimeout(id);
    }, [exitOpen, exitActionsRef]);

    return (
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop
          data-slot="dialog-backdrop"
          render={(backdropProps, state) => {
            const exiting = state.transitionStatus === 'ending';
            const rest = omit(backdropProps as React.HTMLAttributes<HTMLDivElement>, [
              'style',
              'onDrag',
              'onDragStart',
              'onDragEnd',
              'onAnimationStart',
              'onAnimationEnd',
              'onAnimationIteration',
            ]);
            return (
              <motion.div
                {...rest}
                className={cn(
                  container ? 'absolute' : 'fixed',
                  'inset-0 z-50 bg-black/40 dark:bg-black/80',
                )}
                initial={{ opacity: 0 }}
                animate={{ opacity: exiting ? 0 : 1 }}
                transition={exiting ? spring.slow.exit : spring.slow}
              />
            );
          }}
        />
        <DialogPrimitive.Popup
          ref={ref}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          render={(popupProps, state) => {
            const exiting = state.transitionStatus === 'ending';
            const { style: baseStyle, ...baseProps } =
              popupProps as React.HTMLAttributes<HTMLDivElement>;
            const rest = omit(baseProps, [
              'onDrag',
              'onDragStart',
              'onDragEnd',
              'onAnimationStart',
              'onAnimationEnd',
              'onAnimationIteration',
            ]);
            return (
              <motion.div
                // Base UI's props first, then the consumer's on top.
                {...rest}
                {...(props as Omit<
                  React.HTMLAttributes<HTMLDivElement>,
                  | 'onDrag'
                  | 'onDragStart'
                  | 'onDragEnd'
                  | 'onAnimationStart'
                  | 'onAnimationEnd'
                  | 'onAnimationIteration'
                >)}
                className={cn(
                  container ? 'absolute' : 'fixed',
                  'z-50 w-[calc(100%-2rem)]',
                  position === 'left' ? 'left-0 top-0' : 'left-1/2',
                  position === 'top' ? 'top-[12dvh]' : position === 'center' && 'top-1/2',
                  surfaceClasses(dialogLevel),
                  'p-6 focus:outline-none',
                  size === 'sm' && (compact ? 'max-w-[360px]' : 'max-w-[400px]'),
                  size === 'lg' && (compact ? 'max-w-[480px]' : 'max-w-[540px]'),
                  size === 'xl' && (compact ? 'max-w-[800px]' : 'max-w-[880px]'),
                  shape.container,
                  className,
                )}
                style={{
                  ...(baseStyle as React.CSSProperties | undefined),
                  ...(props.style as React.CSSProperties | undefined),
                }}
                initial={{
                  opacity: 0,
                  scale: 0.97,
                  x: position === 'left' ? 0 : '-50%',
                  y: position === 'center' ? '-50%' : 0,
                }}
                animate={{
                  opacity: exiting ? 0 : 1,
                  scale: exiting ? 0.97 : 1,
                  x: position === 'left' ? 0 : '-50%',
                  y: position === 'center' ? '-50%' : 0,
                }}
                transition={exiting ? spring.slow.exit : spring.slow}
                onAnimationComplete={() => {
                  if (exiting) exitActionsRef?.current?.unmount();
                }}
              >
                <SurfaceProvider value={dialogLevel}>
                  {children}
                  {showCloseButton && (
                    <DialogPrimitive.Close
                      render={
                        <Button variant="ghost" size="icon-sm" className="absolute right-3 top-3">
                          <XIcon />
                          <span className="sr-only">Close</span>
                        </Button>
                      }
                    />
                  )}
                </SurfaceProvider>
              </motion.div>
            );
          }}
        />
      </DialogPrimitive.Portal>
    );
  },
);
DialogContent.displayName = 'DialogContent';

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 mb-4', className)} {...props} />;
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex justify-end gap-2 mt-6', className)} {...props} />;
}

const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    const compact = useSizeVariant() === 'compact';
    return (
      <DialogPrimitive.Title
        ref={ref}
        className={cn(
          typeClass('title', compact ? 'compact' : 'default'),
          'text-foreground',
          className,
        )}
        style={{ fontVariationSettings: fontWeights.semibold }}
        {...props}
      />
    );
  },
);
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    const compact = useSizeVariant() === 'compact';
    return (
      <DialogPrimitive.Description
        ref={ref}
        className={cn(
          typeClass('body', compact ? 'compact' : 'default'),
          'text-muted-foreground',
          className,
        )}
        {...props}
      />
    );
  },
);
DialogDescription.displayName = 'DialogDescription';

export type { DialogSlotProps as DialogTriggerProps, DialogSlotProps as DialogCloseProps };
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
