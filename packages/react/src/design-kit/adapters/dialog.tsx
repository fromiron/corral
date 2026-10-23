'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import type { ComponentProps } from 'react';
import {
  DialogContent as KitDialogContent,
  DialogDescription as KitDialogDescription,
  DialogFooter as KitDialogFooter,
  DialogHeader as KitDialogHeader,
  DialogTitle as KitDialogTitle,
} from '../components/ui/dialog.tsx';
import { cn } from '../lib/utils.ts';
import { ScrollArea } from './scroll-area.tsx';

export { Dialog, DialogClose, DialogTrigger } from '../components/ui/dialog.tsx';
export const DialogPortal = DialogPrimitive.Portal;
export const DialogBackdrop = DialogPrimitive.Backdrop;
export const DialogOverlay = DialogPrimitive.Backdrop;
export const DialogViewport = DialogPrimitive.Viewport;

function DialogPopup({
  className,
  bottomStickOnMobile: _bottomStickOnMobile,
  variant = 'default',
  ...props
}: ComponentProps<typeof KitDialogContent> & {
  bottomStickOnMobile?: boolean;
  variant?: 'default' | 'media';
}) {
  return (
    <KitDialogContent
      data-slot="dialog-popup"
      className={cn(
        'max-h-[calc(100dvh-2rem)] overflow-y-auto [-webkit-app-region:no-drag]',
        variant === 'media' &&
          'z-[60] w-auto max-w-[92vw] overflow-visible bg-transparent p-0 shadow-none',
        className,
      )}
      {...props}
    />
  );
}

export { DialogPopup, DialogPopup as DialogContent };
export function DialogHeader(props: ComponentProps<typeof KitDialogHeader>) {
  return <KitDialogHeader data-slot="dialog-header" {...props} />;
}
export function DialogFooter({
  variant: _variant,
  ...props
}: ComponentProps<typeof KitDialogFooter> & { variant?: 'default' | 'bare' }) {
  return <KitDialogFooter data-slot="dialog-footer" {...props} />;
}
export function DialogTitle(props: ComponentProps<typeof KitDialogTitle>) {
  return <KitDialogTitle data-slot="dialog-title" {...props} />;
}
export function DialogDescription(props: ComponentProps<typeof KitDialogDescription>) {
  return <KitDialogDescription data-slot="dialog-description" {...props} />;
}
export function DialogPanel({
  scrollFade = true,
  ...props
}: ComponentProps<'div'> & { scrollFade?: boolean }) {
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div data-slot="dialog-panel" {...props} />
    </ScrollArea>
  );
}
