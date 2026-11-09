import type { ReactNode } from 'react';
import { Elevated } from '../design-kit/lib/elevated.tsx';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { useShape } from '../design-kit/lib/shape-context.tsx';
import { useSize } from '../design-kit/lib/size-context.tsx';
import { cn } from '../design-kit/lib/utils.ts';

/**
 * The kit shell's footer card (components/screens/shell.tsx): one raised surface with a short
 * title, a line of body text and an optional action. Elevated is not part of the kit's public
 * index, so the card composes it here rather than at the call site.
 */
export function SidebarStatusCard({
  title,
  marker,
  children,
  action,
  ...props
}: {
  title: ReactNode;
  /** A leading status mark beside the title, such as a tone dot. */
  marker?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  'data-testid'?: string;
}) {
  const shape = useShape();
  const size = useSize();
  return (
    <Elevated offset={1} className={cn(shape.container, 'mx-2 mb-2 grid gap-1 p-3')} {...props}>
      <span
        className={cn(size.type.caption, 'flex items-center gap-1.5 text-emphasis')}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {marker}
        {title}
      </span>
      {children ? <p className={cn(size.type.body, 'm-0 text-foreground')}>{children}</p> : null}
      {action}
    </Elevated>
  );
}
