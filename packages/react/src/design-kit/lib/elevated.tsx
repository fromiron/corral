'use client';

import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from 'react';
import { surfaceClasses } from './surface-classes.ts';
import { SurfaceProvider, useSurface } from './surface-context.tsx';
import { cn } from './utils.ts';

interface ElevatedProps extends ComponentPropsWithoutRef<'div'> {
  /**
   * Steps above the current surface; the level (`min(surface + offset, 8)`) is
   * re-provided to descendants. Conventionally 2 for menus, 4 for dialogs.
   */
  offset: number;
  /**
   * Shadow level override. By default the shadow follows the raise (`1 + offset`, never above the
   * surface level), so a card nested in a card casts the same shadow as one on the page while its
   * background still steps up. The ladder's deep drops stay for surfaces raised that far.
   */
  shadowLevel?: number;
  children?: ReactNode;
}

const Elevated = forwardRef<HTMLDivElement, ElevatedProps>(
  ({ offset, shadowLevel, className, children, ...props }, ref) => {
    const substrate = useSurface();
    const level = Math.min(substrate + offset, 8);
    return (
      <SurfaceProvider value={level}>
        <div
          ref={ref}
          className={cn(
            surfaceClasses(level, shadowLevel ?? Math.min(level, 1 + offset)),
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </SurfaceProvider>
    );
  },
);
Elevated.displayName = 'Elevated';

export { Elevated };
