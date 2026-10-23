import type { InboxItemView } from '@corral/client';

export type NotificationTarget = Pick<InboxItemView, 'kind' | 'sessionId' | 'runId'>;
const key = (item: NotificationTarget) => JSON.stringify([item.kind, item.sessionId, item.runId]);

/** Identity, never the session title or request body, crosses the native bridge. */
export function inboxNotificationTargets(
  items: readonly InboxItemView[],
  previous: readonly NotificationTarget[] = [],
): NotificationTarget[] {
  const seen = new Set(previous.map(key));
  return items.flatMap(({ kind, sessionId, runId }) => {
    const target = { kind, sessionId, runId };
    if (seen.has(key(target))) return [];
    seen.add(key(target));
    return [target];
  });
}

/** Re-read the originating session's inbox: an old notification grants no action. */
export async function notificationDestination(
  target: NotificationTarget,
  source: {
    getSession(id: string): Promise<{ projectId: string; archivedAt: string | null } | null>;
    inbox(projectId: string): Promise<InboxItemView[]>;
  },
): Promise<string | null> {
  const session = await source.getSession(target.sessionId);
  if (!session || session.archivedAt) return null;
  const items = await source.inbox(session.projectId);
  if (!items.some((item) => key(item) === key(target))) return null;
  const sessionPath = `/sessions/${encodeURIComponent(target.sessionId)}`;
  if ((target.kind === 'decision' || target.kind === 'recipe_stopped') && target.runId)
    return `${sessionPath}?panel=run&view=run&run=${encodeURIComponent(target.runId)}`;
  return target.kind === 'queued' ? sessionPath : `${sessionPath}/review`;
}
