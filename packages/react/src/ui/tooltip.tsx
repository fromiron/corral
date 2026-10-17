'use client';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type * as React from 'react';
import { cn } from './utils.ts';

// A short label for an icon-only control. The control keeps its own aria-label; the tooltip
// only repeats it for sighted pointer and keyboard users, with the shortcut when there is one.

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <TooltipPrimitive.Provider delay={500}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
  className,
}: {
  content: React.ReactNode;
  shortcut?: string;
  /** A single element that accepts a ref, usually a Button. */
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-[140]">
          <TooltipPrimitive.Popup
            className={cn(
              'flex items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-popup',
              className,
            )}
          >
            {content}
            {shortcut ? (
              <Kbd className="border-background/30 text-background/80">{shortcut}</Kbd>
            ) : null}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** A keyboard key or chord, e.g. `⌘K` or `Ctrl+K`. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-line px-1 font-sans text-2xs text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
