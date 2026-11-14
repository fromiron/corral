import type { InboxItemView } from '@corral/client';

// Needs you groups the server's inbox items (docs/specs/features/inbox.md).

type Kind = InboxItemView['kind'];

export const INBOX_GROUPS = [
  { id: 'response', kinds: ['decision', 'uncertain_write', 'uncertain_terminal'] },
  {
    id: 'review',
    kinds: ['unreviewed', 'check_failed', 'lsp_proposal', 'integration', 'advice'],
  },
  { id: 'waiting', kinds: ['queued', 'recipe_stopped'] },
] as const satisfies readonly { id: string; kinds: readonly Kind[] }[];

export type InboxGroupId = (typeof INBOX_GROUPS)[number]['id'];

/** One listed item with the project it was read from and a key that names only it. */
export interface InboxEntry {
  key: string;
  projectId: string;
  item: InboxItemView;
}

/**
 * Keys carry project, kind, session, run, terminal and an advice's execution row, so a refresh
 * can never point a selection at another run or row. Repeats (one per queued request, or more
 * than one advice for the same row) are told apart by their order.
 */
export function inboxEntries(projectId: string, items: readonly InboxItemView[]): InboxEntry[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const identity = JSON.stringify([
      projectId,
      item.kind,
      item.sessionId,
      item.runId,
      item.terminalId ?? null,
      item.executionId ?? null,
    ]);
    const repeat = seen.get(identity) ?? 0;
    seen.set(identity, repeat + 1);
    return { key: `${identity}#${repeat}`, projectId, item };
  });
}

/** The groups that have items, in the spec's order; items keep their read order. */
export function inboxGroups(
  entries: readonly InboxEntry[],
): { id: InboxGroupId; entries: InboxEntry[] }[] {
  return INBOX_GROUPS.flatMap(({ id, kinds }) => {
    const grouped = entries.filter((entry) => (kinds as readonly Kind[]).includes(entry.item.kind));
    return grouped.length ? [{ id, entries: grouped }] : [];
  });
}
