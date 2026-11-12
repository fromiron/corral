import { cn, MetaDot, useSize } from '@corral/react/design-kit';
import { Fragment, type ReactNode } from 'react';

// The run row in a conversation (docs/specs/features/composer-flow.md, "튐 없는 본문" rule 3):
// a head line, a body and a tail line, the same three from the run's start to its end. The head
// and the tail keep one line's height whatever they hold; only the body grows, downward.

/** The values of a line, a kit meta dot between each two. */
export function MetaLine({ values }: { values: { key: string; node: ReactNode }[] }) {
  return values.map(({ key, node }, index) => (
    <Fragment key={key}>
      {index ? <MetaDot /> : null}
      {node}
    </Fragment>
  ));
}

/**
 * The head: one line of fixed height that never wraps. Its values sit on the left and the run's
 * number on the right; when the line is too narrow, the values in the middle give way. The
 * composer's region announces the run, so the line says nothing on its own.
 */
export function RunHead({ children, trailing }: { children?: ReactNode; trailing?: ReactNode }) {
  const size = useSize();
  return (
    <div
      data-chat-part="head"
      aria-live="off"
      className={cn(
        size.control,
        'flex min-w-0 items-center gap-2 whitespace-nowrap text-caption text-muted-foreground',
      )}
    >
      <div className="flex h-full min-w-0 flex-1 items-center">{children}</div>
      {trailing ? <div className="flex shrink-0 items-center">{trailing}</div> : null}
    </div>
  );
}

/**
 * The tail: one line of the icon row's height, there from the run's start. The values the run
 * has, then the answer's icon actions; with neither it is an empty line.
 */
export function RunTail({
  values = [],
  children,
}: {
  values?: { key: string; node: ReactNode }[];
  children?: ReactNode;
}) {
  const size = useSize();
  return (
    <div
      data-chat-part="tail"
      aria-live="off"
      className={cn(
        size.control,
        'flex min-w-0 items-center gap-3 whitespace-nowrap text-caption text-muted-foreground',
      )}
    >
      {values.length ? (
        <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
          <MetaLine values={values} />
        </span>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Why the turn did not finish and what to do next, as the body's last block: words and buttons,
 * on no surface of their own.
 */
export function TurnEnd({
  reason,
  failure,
  actions,
}: {
  reason?: ReactNode;
  failure?: ReactNode;
  actions?: ReactNode;
}) {
  if (!reason && !failure && !actions) return null;
  return (
    <div
      data-testid="turn-end"
      className="flex min-w-0 flex-col gap-2 text-caption text-foreground"
    >
      {reason ? <p>{reason}</p> : null}
      {failure}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * The row: its head (with the work log it opens), its body and its tail, then what stands
 * outside the row (a waiting approval's card). Hovering or focusing the row shows its icon
 * actions, as hovering a message did.
 */
export function RunRow({
  head,
  tail,
  after,
  children,
}: {
  head: ReactNode;
  tail: ReactNode;
  after?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="turn-actions-scope flex min-w-0 flex-col">
        {head}
        {/* At least one line of the answer's text, so the first words take the wait's place. */}
        <div
          data-chat-part="body"
          className="mt-1 flex min-h-(--lh-title) min-w-0 flex-col gap-3 wrap-anywhere"
        >
          {children}
        </div>
        <div className="mt-1">{tail}</div>
      </div>
      {after}
    </div>
  );
}
