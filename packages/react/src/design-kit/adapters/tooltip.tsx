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
        <span className="inline-flex items-center gap-2">
          {content}
          {shortcut ? <Kbd tone="inverse">{shortcut}</Kbd> : null}
        </span>
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
