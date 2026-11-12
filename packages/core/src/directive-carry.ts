import type { TextAttachment } from '@corral/contracts';
import type { DirectiveView, RunProjection } from './projection.ts';
import type { NewSessionEntry, WorkSession } from './repository/index.ts';

// A person's directive its target never read, because the target succeeded first, is carried
// into the session's queue as a request of its own (features/reins.md, "읽히지 못한 지시의
// 넘겨받기"). The directive's own record stays expired; only the session gains an entry.

export interface CarriedDirective {
  directiveId: string;
  text: string;
  attachments?: TextAttachment[];
}

const PENDING = new Set<DirectiveView['status']>(['accepted', 'queued', 'attached_to_request']);

/** Who made a directive; one recorded without an origin came from a person. */
function originOf(directive: DirectiveView): string {
  return (directive as DirectiveView & { origin?: string }).origin ?? 'user';
}

/**
 * The person's directives of this run that expired unread on a target that succeeded, in the
 * order they were sent. An earlier person's directive still waiting to be read holds back the
 * ones after it, so carried requests keep the send order however their targets end.
 */
export function carriedDirectives(projection: RunProjection): CarriedDirective[] {
  const carried: CarriedDirective[] = [];
  for (const directiveId of projection.directiveOrder) {
    const directive = projection.directives[directiveId];
    if (!directive || originOf(directive) !== 'user') continue;
    if (PENDING.has(directive.status)) break;
    if (directive.status !== 'expired') continue;
    if (projection.executions[directive.targetExecutionId]?.status !== 'succeeded') continue;
    carried.push({
      directiveId,
      text: directive.text,
      ...(directive.attachments?.length ? { attachments: directive.attachments } : {}),
    });
  }
  return carried;
}

/**
 * The queued request a carried directive becomes: its words and attachments, started as the
 * request that started the run was. Without that request's start snapshot the server cannot
 * start it, so nothing is carried.
 */
export function carriedEntry(
  session: WorkSession,
  runId: string,
  directive: CarriedDirective,
): NewSessionEntry | null {
  const source = session.entries.find(
    (entry) => entry.runId === runId && (entry.intent === 'next' || entry.intent === 'queue'),
  );
  if (!source?.start) return null;
  return {
    intent: 'queue',
    state: 'queued',
    text: directive.text,
    ...(directive.attachments?.length ? { attachments: directive.attachments } : {}),
    start: source.start,
    ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
    carriedFrom: directive.directiveId,
  };
}
