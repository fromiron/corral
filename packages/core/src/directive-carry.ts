import type { TextAttachment } from '@corral/contracts';
import type { RunProjection } from './projection.ts';
import type { NewSessionEntry, WorkSession } from './repository/index.ts';

// A person's directive its target never read, because the target succeeded first, is carried
// into the session's queue as a request of its own (features/reins.md, "읽히지 못한 지시의
// 넘겨받기"). The directive's own record stays expired; only the session gains an entry.

export interface CarriedDirective {
  directiveId: string;
  text: string;
  attachments?: TextAttachment[];
}

/**
 * The person's directives of this run that expired unread on a target that succeeded, in the
 * order they were sent. Each is carried when it expires; one still waiting holds nothing back.
 */
export function carriedDirectives(projection: RunProjection): CarriedDirective[] {
  const carried: CarriedDirective[] = [];
  for (const directiveId of projection.directiveOrder) {
    const directive = projection.directives[directiveId];
    // Only the person's own words are carried; advice and system notices are not requests.
    if (!directive || directive.origin !== 'user') continue;
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
