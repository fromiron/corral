'use client';

import type { ComponentProps, ReactNode } from 'react';
import { Tooltip as KitTooltip } from '../components/ui/tooltip.tsx';
import { cn } from '../lib/utils.ts';

export { TooltipProvider } from '../components/ui/tooltip.tsx';

export function Tooltip({
  content,
  shortcut,
  ...props
}: ComponentProps<typeof KitTooltip> & { shortcut?: string }) {
  return (
    <KitTooltip
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
