// Adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc. (MIT). See THIRD-PARTY-NOTICES/T3-Code.md.
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils.ts';

const skeletonVariants = cva('bg-muted-foreground/15 motion-safe:animate-skeleton', {
  variants: {
    shape: {
      block: 'rounded-sm',
      card: 'rounded-lg',
      pill: 'rounded-full',
    },
  },
  defaultVariants: { shape: 'block' },
});

function Skeleton({
  className,
  shape,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof skeletonVariants>) {
  return (
    <div className={cn(skeletonVariants({ shape }), className)} data-slot="skeleton" {...props} />
  );
}

export { Skeleton };
