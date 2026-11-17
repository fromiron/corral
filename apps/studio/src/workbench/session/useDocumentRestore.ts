// The restored 문서 tabs' reads after entering a conversation (features/session-panel.md 주소와
// 기억): a tab stays until its file is read; a file gone, or a copy no longer the Paddock, drops
// it; a read that fails keeps it. Each restored tab is read once, whether or not it is on screen,
// with the lightest read the host has (the file itself; no buffer, editor model or view).
import { ApiError, type WorkspacesApi } from '@corral/client';
import { useEffect, useRef } from 'react';
import type { DocumentStore } from '../documents/store.ts';
import type { DocumentChecked, OpenTab, PanelEvent, PanelState } from '../panel/model.ts';
import type { CopyIdentity } from '../panel/tabs.ts';
import { tabKey } from '../panel/tabs.ts';

export interface DocumentRestoreInput {
  sessionId: string;
  projectId: string;
  hostId: string | undefined;
  workspaces:
    | (Pick<WorkspacesApi, 'readFile'> & Partial<Pick<WorkspacesApi, 'readDocument'>>)
    | undefined;
  /** The conversation's copy documents, where the host keeps any (a local backend). */
  documents: DocumentStore | undefined;
  /** The frame has entered this conversation. */
  entered: boolean;
  state: PanelState;
  /** The conversation's Paddock as last read. */
  copy: { known: boolean; copy: CopyIdentity | null };
  dispatch: (event: PanelEvent) => void;
  /** The conversation now (a late answer for one left is dropped). */
  current: () => string;
}

/**
 * A source-folder read that says the file is not there: the host refuses a path that is no file
 * as an invalid request, or answers that it was not found.
 */
const noFile = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 404 || error.code === 'TARGET_NOT_FOUND' || error.code === 'SCHEMA_INVALID');

export function useDocumentRestore(input: DocumentRestoreInput) {
  const latest = useRef(input);
  latest.current = input;
  const awaited = input.state.awaiting?.documents ?? [];
  const awaitedKey = awaited.map((item) => `${item.key}#${item.instance}`).join('|');
  const asked = useRef<string | null>(null);
  const { entered, sessionId } = input;
  const known = input.copy.known;
  // A copy's tab is read once the Paddock is known; a source-folder tab needs only the folder.
  const copies = awaited.some((item) =>
    input.state.tabs.some(
      (tab) =>
        tabKey(tab) === item.key &&
        tab.instance === item.instance &&
        tab.kind === 'document' &&
        tab.source === 'copy',
    ),
  );
  useEffect(() => {
    const now = latest.current;
    if (!entered || !awaitedKey || !now.workspaces) return;
    if (copies && (!known || !now.documents || !now.workspaces.readDocument)) return;
    const marker = `${sessionId}|${awaitedKey}`;
    if (asked.current === marker) return;
    asked.current = marker;
    const { workspaces, documents, state, copy, hostId, projectId } = now;
    const items = state.awaiting?.documents ?? [];
    const tabOf = (key: string, instance: number) =>
      state.tabs.find((tab) => tabKey(tab) === key && tab.instance === instance);
    void (async () => {
      const drafts =
        hostId && documents
          ? await documents.sessionRecoveries({ hostId, projectId, sessionId }).catch(() => [])
          : [];
      const buffers = documents ? Object.values(documents.getState().documents) : [];
      const draftFor = (path: string) =>
        drafts.some((draft) => draft.path === path) ||
        buffers.some(
          (entry) =>
            entry.target.sessionId === sessionId &&
            entry.path === path &&
            (entry.dirty || Boolean(entry.pendingSave)),
        );
      const results = await Promise.all(
        items.map(async (item): Promise<DocumentChecked> => {
          const tab: OpenTab | undefined = tabOf(item.key, item.instance);
          const keep = { ...item, outcome: 'keep' as const, draft: false };
          if (tab?.kind !== 'document') return keep;
          if (tab.source === 'original')
            try {
              const file = await workspaces.readFile({ kind: 'project', id: projectId }, tab.path);
              return { ...keep, outcome: file.content.kind === 'absent' ? 'drop' : 'keep' };
            } catch (error) {
              return { ...keep, outcome: noFile(error) ? 'drop' : 'keep' };
            }
          const draft = draftFor(tab.path);
          if (!workspaces.readDocument) return keep;
          const paddock = copy.copy;
          if (
            !paddock ||
            (tab.copy &&
              (tab.copy.bindingId !== paddock.bindingId ||
                tab.copy.generation !== paddock.generation))
          )
            return { ...item, outcome: 'drop', draft };
          try {
            const file = await workspaces.readDocument(sessionId, tab.path);
            return { ...item, outcome: file.content.kind === 'absent' ? 'drop' : 'keep', draft };
          } catch {
            // A read that fails keeps the tab: it shows why when it is opened.
            return { ...keep, draft };
          }
        }),
      );
      if (latest.current.current() !== sessionId) return;
      latest.current.dispatch({ type: 'documentsChecked', results });
    })();
  }, [entered, sessionId, awaitedKey, known, copies]);
}
