'use client';

import type { ComponentProps } from 'react';
import { ScrollArea as KitScrollArea } from '../components/ui/scroll-area.tsx';
import { cn } from '../lib/utils.ts';

export { ScrollBar } from '../components/ui/scroll-area.tsx';

function getVirtualizedScrollFadeClassName({ top, bottom }: { top: boolean; bottom: boolean }) {
  if (!top && !bottom) return undefined;

  return cn(
    'virtualized-scroll-fade [--fade-size:1.5rem]',
    top &&
      bottom &&
      '[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size),black_calc(100%-var(--fade-size)),transparent)]',
    top &&
      !bottom &&
      '[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size))]',
    !top &&
      bottom &&
      '[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,black_calc(100%-var(--fade-size)),transparent)]',
  );
}

function ScrollArea({
  className,
  scrollFade = false,
  scrollFadePadding = true,
  scrollbarGutter = false,
  hideScrollbars = false,
  chainVerticalScroll = false,
  radius = 'inherit',
  viewportClassName,
  ...props
}: ComponentProps<typeof KitScrollArea> & {
  scrollFade?: boolean;
  scrollFadePadding?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
  chainVerticalScroll?: boolean;
  radius?: 'inherit' | 'none';
}) {
  return (
    <KitScrollArea
      orientation="both"
      className={cn(
        'size-full min-h-0',
        radius === 'none' ? 'rounded-none' : 'rounded-[inherit]',
        hideScrollbars && '[&>[data-slot=scroll-area-scrollbar]]:hidden',
        className,
      )}
      viewportClassName={cn(
        'overscroll-contain focus-visible:outline-2 focus-visible:outline-focus-ring',
        chainVerticalScroll && 'overscroll-y-auto',
        scrollFade && 'scroll-fade focus-visible:mask-none',
        scrollFade && scrollFadePadding && 'scroll-p-6',
        scrollFade && !scrollFadePadding && 'has-focus-visible:mask-none',
        scrollbarGutter && 'scrollbar-gutter-stable',
        hideScrollbars && '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        viewportClassName,
      )}
      {...props}
    />
  );
}

export { getVirtualizedScrollFadeClassName, ScrollArea };
