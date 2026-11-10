import type { HTMLAttributes, ReactElement } from 'react';
import { Button, cn, EmptyState } from '../design-kit/index.ts';

/** The one next step an empty view offers. */
export interface EmptyViewAction {
  label: string;
  onClick?: () => void;
  /** The element the button renders as, such as a router link. */
  render?: ReactElement;
  disabled?: boolean;
}

/**
 * An empty list or view: the kit EmptyState, and under it at most one next step as a secondary
 * button. The kit state has no action slot, so the action follows it. Every empty part of a view
 * uses this, so they share alignment, title size and spacing. Without text it is the title alone.
 */
export function EmptyView({
  title,
  text,
  action,
  className,
  ...props
}: {
  title: string;
  text?: string | undefined;
  action?: EmptyViewAction | undefined;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div data-slot="empty-view" className={cn('grid gap-3', className)} {...props}>
      <EmptyState title={title} text={text} />
      {action ? (
        <Button
          variant="secondary"
          size="compact"
          className="justify-self-center"
          disabled={action.disabled}
          onClick={action.onClick}
          render={action.render}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
