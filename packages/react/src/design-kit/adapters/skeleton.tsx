import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils.ts';

const skeletonVariants = cva('bg-(--tint) motion-safe:animate-skeleton', {
  variants: {
    shape: {
      block: 'rounded-[var(--shape-input-radius)]',
      card: 'rounded-[var(--shape-panel-radius)]',
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
