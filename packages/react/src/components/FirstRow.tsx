import type { ReactNode } from 'react';

/**
 * A control of the host's frame (the run page's close) set into a row the content already has,
 * so it never takes a row of its own. It comes first in focus order, as it did above the content,
 * and shows at the row's end. Use inside a row that is already a flex row.
 */
export function RowAction({ action }: { action?: ReactNode }) {
  if (!action) return null;
  return (
    <span data-row-action className="order-last -my-1 ml-auto flex shrink-0">
      {action}
    </span>
  );
}

/** A first row that is not a flex row yet: its content, with the host's control at its end. */
export function FirstRow({ action, children }: { action?: ReactNode; children: ReactNode }) {
  if (!action) return children;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <RowAction action={action} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
