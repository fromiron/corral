import type { InboxItemView } from '@corral/client';

export type NotificationTarget = Pick<InboxItemView, 'kind' | 'sessionId' | 'runId' | 'terminalId'>;
const key = (item: NotificationTarget) =>
  JSON.stringify([item.kind, item.sessionId, item.runId, item.terminalId]);

/** Identity, never the session title or request body, crosses the native bridge. */
export function inboxNotificationTargets(
  items: readonly InboxItemView[],
  previous: readonly NotificationTarget[] = [],
): NotificationTarget[] {
  const seen = new Set(previous.map(key));
  return items.flatMap(({ kind, sessionId, runId, terminalId }) => {
    const target = {
      kind,
      sessionId,
      runId,
      ...(kind === 'uncertain_terminal' && terminalId ? { terminalId } : {}),
    };
    if (seen.has(key(target))) return [];
    seen.add(key(target));
    return [target];
  });
}

/**
 * The exact screen an inbox item opens: its run's response area, the session's review, its queue
 * or the terminal's own controls. Desktop notifications and Needs you share it.
 */
export type InboxDestination =
  | {
      to: '/sessions/$sessionId';
      params: { sessionId: string };
      search: {
        panel?: 'run' | 'terminal';
        view?: 'run';
        run?: string;
        terminal?: string;
        respond?: true;
      };
    }
  | { to: '/sessions/$sessionId/review'; params: { sessionId: string }; search: object };

export function inboxDestination(target: NotificationTarget): InboxDestination | null {
  const params = { sessionId: target.sessionId };
  if (target.kind === 'uncertain_terminal')
    return target.terminalId && target.runId === null
      ? {
          to: '/sessions/$sessionId',
          params,
          search: { panel: 'terminal', terminal: target.terminalId },
        }
      : null;
  // A decision opens its run's response area; a stopped review opens the run's record.
  if (target.kind === 'decision' && target.runId)
    return {
      to: '/sessions/$sessionId',
      params,
      search: { panel: 'run', view: 'run', run: target.runId, respond: true },
    };
  if (target.kind === 'recipe_stopped' && target.runId)
    return {
      to: '/sessions/$sessionId',
      params,
      search: { panel: 'run', view: 'run', run: target.runId },
    };
  return target.kind === 'queued'
    ? { to: '/sessions/$sessionId', params, search: {} }
    : { to: '/sessions/$sessionId/review', params, search: {} };
}

export function destinationHref(destination: InboxDestination): string {
  const path = destination.to.replace(
    '$sessionId',
    encodeURIComponent(destination.params.sessionId),
  );
  const query = Object.entries(destination.search)
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
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
  const destination = inboxDestination(target);
  return destination ? destinationHref(destination) : null;
}
