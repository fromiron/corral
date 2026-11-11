'use client';

import type { CSSProperties } from 'react';
import { useShape } from '../../lib/shape-context.tsx';
import { cn } from '../../lib/utils.ts';

// ColorTile extracted from the source color picker. The picker panel, its popover, the swatch
// strip and the channel inputs are not imported: they carry alpha and RGB/HSL/OKLCH formats.

// 8px checkerboard behind translucent colors (the alpha rail repeats it inline).
const CHECKER_BG: CSSProperties = {
  backgroundImage:
    'conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%, var(--checker-a) 0 75%, var(--checker-b) 0)',
  backgroundSize: '8px 8px',
};

// ─── ColorTile (small colored square — checker behind alpha) ─────────────────

interface ColorTileProps {
  color: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

// The inset hairline keeps white or near-transparent colors visible.
function ColorTile({ color, size = 24, className, style }: ColorTileProps) {
  const shape = useShape();
  return (
    <span
      className={cn('inline-block relative shrink-0 overflow-hidden', shape.bg, className)}
      style={{
        width: size,
        height: size,
        ...CHECKER_BG,
        boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.25)',
        ...style,
      }}
    >
      <span className="absolute inset-0" style={{ backgroundColor: color }} />
    </span>
  );
}

export type { ColorTileProps };
export { ColorTile };
