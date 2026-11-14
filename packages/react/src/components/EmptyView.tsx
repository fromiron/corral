import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';
import { Button, cn, EmptyState } from '../design-kit/index.ts';

/** The one next step an empty view offers. */
export interface EmptyViewAction {
  label: string;
  onClick?: () => void;
  /** The element the button renders as, such as a router link. */
  render?: ReactElement;
  disabled?: boolean;
  /** The button, for a page that returns focus to it. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * An empty list or view: the kit EmptyState, with at most one next step as a secondary button at
 * the foot of its dashed frame. Every empty part of a view uses this, so they share alignment,
 * title size and spacing. Without text it is the title alone.
 */
export function EmptyView({
  title,
  titleAction,
  text,
  action,
  className,
  ...props
}: {
  title: string;
  /** Drawn right after the title, on its line (a term's info icon). */
  titleAction?: ReactNode;
  text?: string | undefined;
  action?: EmptyViewAction | undefined;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div data-slot="empty-view" className={cn('grid', className)} {...props}>
      <EmptyState
        title={title}
        titleAction={titleAction}
        text={text}
        action={
          action ? (
            <Button
              ref={action.ref}
              variant="secondary"
              size="compact"
              className="mt-2"
              disabled={action.disabled}
              onClick={action.onClick}
              render={action.render}
            >
              {action.label}
            </Button>
          ) : null
        }
      />
    </div>
  );
}
