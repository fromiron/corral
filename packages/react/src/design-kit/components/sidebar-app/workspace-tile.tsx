'use client';

import type { ReactNode } from 'react';
import { fontWeights } from '../../lib/font-weight.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { cn } from '../../lib/utils.ts';

/** 20px letter tile for the workspace switcher, rounded per the shape system. */
export function WorkspaceTile({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const shape = useShape();
  return (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center bg-foreground text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)] text-background',
        shape.bgRadius >= 20 ? 'rounded-full' : 'rounded-md',
        className,
      )}
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {children}
    </span>
  );
}
