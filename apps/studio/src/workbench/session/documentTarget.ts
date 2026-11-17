// Which 문서 tab a way to a file opens (features/session-panel.md 문서 탭): a file of the
// conversation's current Paddock opens its tab by path. A file of another conversation's copy,
// or of an earlier copy of this one, has no tab here.
import type { WorkspaceTarget } from '@corral/contracts';
import type { CopyIdentity, TabKey } from '../panel/tabs.ts';

export interface ConversationCopy {
  readonly projectId: string;
  readonly sessionId: string;
  /** The Paddock as last read: `known` once a read answered, `copy` null without one. */
  readonly current: { readonly known: boolean; readonly copy: CopyIdentity | null };
}

/** The tab for `path` of `target`, or null when the target is not this conversation's copy now. */
export function documentTabFor(
  target: WorkspaceTarget,
  path: string,
  conversation: ConversationCopy,
): TabKey | null {
  if (target.sessionId !== conversation.sessionId || target.projectId !== conversation.projectId)
    return null;
  const { known, copy } = conversation.current;
  // Before the first read the target's own copy is taken; its tab shows if it went stale.
  if (
    known &&
    (!copy || copy.bindingId !== target.bindingId || copy.generation !== target.copyGeneration)
  )
    return null;
  return `document:copy:${path}`;
}
