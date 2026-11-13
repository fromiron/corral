import { createContext, type ReactNode, type Ref, useContext } from 'react';
import { useStore } from 'zustand';
import { AgentStatusIcon, fontWeights, SizeScope } from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { RowAction } from './FirstRow.tsx';

/**
 * The one card grammar of a waiting request (an approval, a question, an extension prompt), on the
 * kit's `AgentCard`: a head row of the waiting icon and the title with who asks under it, a body
 * indented to the title, and a foot row of the answers at its end, above a rule.
 */
export const requestCard = {
  head: 'flex items-start gap-2.5 px-4 pt-3.5 pr-3.5',
  body: 'flex min-w-0 flex-col gap-2 py-3 pr-4 pl-10',
  foot: 'flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 pt-3 pb-4',
} as const;

/** The head row: the waiting icon, the title, who asks; `aside` is a secondary control at its end. */
export function RequestCardHead({
  title,
  titleId,
  titleRef,
  owner,
  aside,
  action,
}: {
  title: ReactNode;
  titleId?: string;
  /** The title takes focus when a stepped request moves to another step. */
  titleRef?: Ref<HTMLParagraphElement>;
  owner?: ReactNode;
  aside?: ReactNode;
  /** A control of the host's frame (see `RowAction`). */
  action?: ReactNode;
}) {
  return (
    <div data-request-head className={requestCard.head}>
      <RowAction action={action} />
      <AgentStatusIcon status="waiting" size={14} className="mt-0.5 self-start" />
      <div className="grid min-w-0 flex-1">
        <p
          ref={titleRef}
          id={titleId}
          tabIndex={titleRef ? -1 : undefined}
          className="text-body text-foreground outline-none [overflow-wrap:anywhere]"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {title}
        </p>
        {owner ? (
          <span data-request-owner className="truncate text-muted-foreground">
            {owner}
          </span>
        ) : null}
      </div>
      {aside ? <span className="-my-1 flex shrink-0">{aside}</span> : null}
    </div>
  );
}

/**
 * The run a response place names on each of its cards, when it holds several runs' requests
 * (a conversation's needed-now tray with two runs waiting): its name in the session ("Run #2").
 */
export const RequestRunContext = createContext<string | null>(null);

/**
 * Who a request comes from, as its card's head names it: the role (the agent node) where the run
 * has more than one, and the run as well where the response place holds several runs' requests.
 * A lone conversation run's request names nobody: the run's row already says whose it is.
 */
export function useRequestOwner(session: RunSessionStore) {
  const run = useContext(RequestRunContext);
  const nodes = useStore(session, (s) => s.definition?.nodes);
  const executions = useStore(session, (s) => s.projection?.executions);
  // The roles the run schedules, or more where its callable ones (a conversation's helper) ran.
  const scheduled =
    nodes?.filter((node) => node.type === 'agent' && node.invocation !== 'callable').length ?? 0;
  const ran = new Set(Object.values(executions ?? {}).map((execution) => execution.nodeId)).size;
  const roles = Math.max(scheduled, ran);
  return ({ executionId, nodeId }: { executionId?: string | null; nodeId?: string | null }) => {
    const id = nodeId ?? (executionId ? executions?.[executionId]?.nodeId : undefined);
    const role = id ? (nodes?.find((node) => node.id === id)?.label ?? id) : null;
    const parts = [run, run || roles > 1 ? role : null].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  };
}

/** The foot row: the answers at its end, compact at every density as the approval's decisions are. */
export function RequestCardFoot({ children }: { children: ReactNode }) {
  return (
    <div data-request-foot className={requestCard.foot}>
      <SizeScope size="compact">{children}</SizeScope>
    </div>
  );
}
