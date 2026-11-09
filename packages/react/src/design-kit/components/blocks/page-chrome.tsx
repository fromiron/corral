'use client';

// Page chrome extracted from the kit's sample screens: path bar, page stack,
// section label and empty state. Visual values come from the kit (type roles,
// shape, surfaces). Section labels stay sentence case.

import type { ReactNode } from 'react';
import { fontWeights } from '../../lib/font-weight.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';

export interface PathBarLabels {
  /** Accessible name of the breadcrumb navigation. */
  breadcrumb: string;
}

const defaultPathBarLabels: PathBarLabels = { breadcrumb: 'Breadcrumb' };

export function PathBar({
  crumbs,
  children,
  labels,
}: {
  crumbs: { label: string; onClick?: () => void }[];
  children?: ReactNode;
  /** Localized accessible names; the source English is the default. */
  labels?: Partial<PathBarLabels>;
}) {
  const size = useSize();
  const { breadcrumb } = { ...defaultPathBarLabels, ...labels };
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <nav
        aria-label={breadcrumb}
        className={cn(size.type.body, 'flex min-w-0 flex-1 items-center gap-2')}
      >
        {crumbs.map((crumb, index) => (
          <span key={crumb.label} className="flex min-w-0 items-center gap-2">
            {index > 0 && (
              <span aria-hidden className="text-muted-foreground">
                /
              </span>
            )}
            {crumb.onClick ? (
              <button
                type="button"
                className="truncate text-muted-foreground hover:text-foreground"
                onClick={crumb.onClick}
              >
                {crumb.label}
              </button>
            ) : (
              <span
                className="truncate text-foreground"
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      {children}
    </header>
  );
}

export function Page({
  title,
  description,
  toolbar,
  children,
  width = 'wide',
}: {
  title: string;
  description?: string;
  toolbar?: ReactNode;
  children: ReactNode;
  width?: 'wide' | 'narrow';
}) {
  const size = useSize();
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div
        className={cn(
          'grid gap-6 px-6 py-6',
          width === 'narrow' ? 'mx-auto w-full max-w-[720px]' : 'mx-auto w-full max-w-5xl',
        )}
      >
        <header className="grid gap-1">
          <h1
            className={cn(size.type.display, 'm-0 text-foreground')}
            style={{ fontVariationSettings: fontWeights.bold }}
          >
            {title}
          </h1>
          {description && (
            <p className={cn(size.type.body, 'm-0 text-muted-foreground')}>{description}</p>
          )}
        </header>
        {toolbar}
        {children}
      </div>
    </div>
  );
}

export function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  const size = useSize();
  return (
    <h2
      className={cn(size.type.caption, 'm-0 flex items-center gap-2 text-muted-foreground')}
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {children}
      {count !== undefined && <span className="tabular-nums">{count}</span>}
    </h2>
  );
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  const size = useSize();
  const shape = useShape();
  return (
    <div
      className={cn(
        shape.container,
        'grid justify-items-center gap-1 border border-dashed border-border px-6 py-10 text-center',
      )}
    >
      <b
        className={cn(size.type.body, 'text-foreground')}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {title}
      </b>
      <p className={cn(size.type.caption, 'm-0 max-w-sm text-muted-foreground')}>{text}</p>
    </div>
  );
}
