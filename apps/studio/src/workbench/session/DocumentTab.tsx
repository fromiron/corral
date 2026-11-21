// A 문서 tab of the conversation's Paddock (features/session-panel.md 문서 탭): the file's editor
// as the dock showed it, now hosted by its panel tab. The tab knows the file by its path and, once
// read, by the copy it belongs to; until then the conversation's current copy is read for it.
import type { TextAttachment, TextRange, WorkspaceTarget } from '@corral/contracts';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { AttachmentCapture } from '../context/bridge.ts';
import { DockDocumentPanel } from '../DockDocumentPanel.tsx';
import { type DocumentStore, documentKey } from '../documents/store.ts';
import type { FileReference } from '../FilePanel.tsx';
import type { CopyIdentity } from '../panel/tabs.ts';

/** The view a 문서 tab holds on its buffer, one per conversation and path. */
export const documentViewId = (sessionId: string, path: string) =>
  `panel-document:${sessionId}:${path}`;

export function DocumentTab({
  owner,
  hostId,
  projectId,
  sessionId,
  path,
  copy,
  reveal,
  onCopy,
  onKey,
  onAttach,
  onReference,
}: {
  owner: DocumentStore;
  hostId: string | undefined;
  projectId: string;
  sessionId: string;
  path: string;
  /** The copy the tab was read from, once it was. */
  copy: CopyIdentity | undefined;
  /** A place inside the file a way pointed at. */
  reveal?: TextRange | undefined;
  /** The file was read: the copy it belongs to. */
  onCopy: (copy: CopyIdentity) => void;
  /** The buffer's key this tab shows, once known (its close asks the buffer). */
  onKey: (key: string | null) => void;
  onAttach?: (attachment: TextAttachment, capture: AttachmentCapture) => void | Promise<void>;
  onReference?: (reference: FileReference) => void;
}) {
  const t = useTranslations('Documents');
  const known: WorkspaceTarget | null =
    copy && hostId
      ? {
          hostId,
          projectId,
          bindingId: copy.bindingId,
          sessionId,
          copyGeneration: copy.generation,
        }
      : null;
  const [read, setRead] = useState<{
    path: string;
    target: WorkspaceTarget | null;
    failed: string | null;
  }>({
    path,
    target: null,
    failed: null,
  });
  const unread = known === null;
  // A tab not yet read: the conversation's current copy holds its file.
  useEffect(() => {
    if (!unread) return;
    let live = true;
    void owner.open(sessionId, path).then(
      (key) => {
        const entry = owner.getState().documents[key];
        if (!live || !entry) return;
        setRead({ path, target: entry.target, failed: null });
      },
      (error: unknown) => {
        if (live)
          setRead({
            path,
            target: null,
            failed: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [owner, sessionId, path, unread]);
  const target = known ?? (read.path === path ? read.target : null);
  const key = target ? documentKey(target, path) : null;
  const exists = useStore(owner, (state) => (key ? Boolean(state.documents[key]) : false));
  // The copy the file was read from goes on the tab, and the tab holds its view of the buffer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the callbacks are the page's latest
  useEffect(() => {
    const entry = key ? owner.getState().documents[key] : undefined;
    if (!entry) return;
    onCopy({ bindingId: entry.target.bindingId, generation: entry.target.copyGeneration });
  }, [key, exists, owner]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the callback is the page's latest
  useEffect(() => {
    onKey(key);
    return () => onKey(null);
  }, [key]);
  useEffect(() => {
    if (!key || !exists) return;
    return owner.retainView(key, documentViewId(sessionId, path));
  }, [owner, key, exists, sessionId, path]);
  if (!target) {
    const failed = read.path === path ? read.failed : null;
    return (
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2">
        <p
          role={failed ? 'alert' : 'status'}
          className={failed ? 'text-caption text-danger' : 'text-caption text-muted-foreground'}
        >
          {failed ?? t('loading')}
        </p>
      </div>
    );
  }
  return (
    <DockDocumentPanel
      owner={owner}
      target={target}
      path={path}
      viewId={documentViewId(sessionId, path)}
      revealSelection={reveal}
      onAttach={onAttach}
      onReference={onReference}
    />
  );
}
