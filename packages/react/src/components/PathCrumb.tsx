import type { ReactNode } from 'react';
import { cn, fontWeights, useSize } from '../design-kit/index.ts';

/**
 * The current item of a path, drawn as the kit PathBar draws its last crumb. Corral's top bar
 * hosts menus and page slots beside it, so it uses the crumb rather than the whole PathBar.
 */
export function PathCrumb({ children }: { children: ReactNode }) {
  const size = useSize();
  return (
    <span
      aria-current="page"
      className={cn(size.type.body, 'min-w-0 truncate px-2 text-foreground')}
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {children}
    </span>
  );
}
