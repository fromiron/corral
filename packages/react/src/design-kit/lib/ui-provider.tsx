'use client';

// Optional root wrapper that sets, for every component: reduced motion
// (follows the OS setting; fades stay), shape (rounded | pill), size
// (default | compact), and the icon set (Lucide unless overridden).
//
// In Next.js, render it from a "use client" file that imports the icon set
// itself — an icon map can't be passed as a prop from a server component.

import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { type IconComponent, type IconName, IconProvider } from './icon-context.tsx';
import { ShapeProvider, type ShapeVariant } from './shape-context.tsx';
import { SizeProvider, type SizeVariant } from './size-context.tsx';

export interface UIProviderProps {
  children: ReactNode;
  /** Initial corner style; switchable at runtime via useShapeContext(). */
  shape?: ShapeVariant;
  /** Initial size step; switchable at runtime via useSizeContext(). */
  size?: SizeVariant;
  /** Icons by slot name (omitted slots keep Lucide). Pass a module-scope
   *  object — a new object each render re-renders every icon. */
  icons?: Partial<Record<IconName, IconComponent>>;
}

export function UIProvider({
  children,
  shape = 'rounded',
  size = 'default',
  icons,
}: UIProviderProps) {
  return (
    <MotionConfig reducedMotion="user">
      <ShapeProvider defaultShape={shape}>
        <SizeProvider defaultSize={size}>
          <IconProvider icons={icons}>{children}</IconProvider>
        </SizeProvider>
      </ShapeProvider>
    </MotionConfig>
  );
}
