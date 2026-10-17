// Adapted from T3 Code ComposerSurface (MIT). See THIRD-PARTY-NOTICES/T3-Code.md.
import { cn } from '@corral/react/ui';
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
        'relative z-10 w-full rounded-3xl border border-line bg-raised shadow-composer',
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
        'relative mx-auto flex w-[calc(100%-2rem)] items-center gap-2 rounded-b-xl border border-t-0 border-line bg-surface px-3 py-1.5 text-xs text-muted',
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, ContextStrip };
