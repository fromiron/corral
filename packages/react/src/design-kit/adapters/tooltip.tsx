'use client';

import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Tooltip as KitTooltip } from '../components/ui/tooltip.tsx';
import { cn } from '../lib/utils.ts';

export { TooltipProvider } from '../components/ui/tooltip.tsx';

export function Tooltip({
  content,
  shortcut,
  escapeThrough = false,
  forceOpen,
  onOpenChange,
  ...props
}: ComponentProps<typeof KitTooltip> & {
  shortcut?: string;
  /** Escape closes the tooltip and goes on to whatever else listens for it (a drawer under it):
   *  a tooltip is not something the person opened. */
  escapeThrough?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Closed in the capture phase, before the tooltip's own dismissal sees the key: that one would
  // mark the key handled and stop it.
  useEffect(() => {
    if (!escapeThrough || !open || forceOpen !== undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      flushSync(() => setDismissed(true));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [escapeThrough, open, forceOpen]);
  return (
    <KitTooltip
      // Without escapeThrough, both pass through untouched.
      forceOpen={escapeThrough ? (forceOpen ?? (dismissed ? false : undefined)) : forceOpen}
      onOpenChange={
        escapeThrough
          ? (next) => {
              setOpen(next);
              if (next) setDismissed(false);
              onOpenChange?.(next);
            }
          : onOpenChange
      }
      content={
        // Only a shortcut needs a row beside the words. Words alone stay in the tooltip's own
        // flow: inside an inline box, the trim to the first line's letters cut every line after
        // it off the tooltip.
        shortcut ? (
          <span className="inline-flex items-center gap-2">
            {content}
            <Kbd tone="inverse">{shortcut}</Kbd>
          </span>
        ) : (
          content
        )
      }
      {...props}
    />
  );
}
export function Kbd({
  children,
  className,
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'inverse';
}) {
  return (
    <kbd data-tone={tone} className={cn('font-sans text-micro text-current', className)}>
      {children}
    </kbd>
  );
}
