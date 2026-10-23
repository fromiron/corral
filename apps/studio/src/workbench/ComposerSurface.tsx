import { cn } from '@corral/react/design-kit';
import type { ComponentProps } from 'react';

function Shell({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-shell"
      className={cn(
        '@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)',
        className,
      )}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        'relative z-10 w-full rounded-[var(--shape-panel-radius)] bg-surface-2 shadow-composer transition-colors has-[textarea:focus-visible]:ring-1 has-[textarea:focus-visible]:ring-focus-ring',
        className,
      )}
      {...props}
    />
  );
}

function ContextStrip({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        'relative mx-auto flex w-[calc(100%-2rem)] items-center gap-2 rounded-b-xl bg-raised px-3 py-1.5 text-xs text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, ContextStrip };
