// Which of the panel's tabs hold work not saved (features/session-panel.md 문서 탭, 팀 그래프 탭): a
// copy's 문서 tab whose buffer has changes or a save whose result is not known, and a 팀 그래프 tab
// whose team draft is not saved. The tab wears the unsaved mark and says which in its
// description.
import type { CorralRepository } from '@corral/core';
import { useCallback, useSyncExternalStore } from 'react';
import { type DocumentBuffer, type DocumentStore, documentKey } from '../documents/store.ts';
import { editorCopyDirty, subscribeEditorCopies } from '../editorDraft.ts';
import type { OpenTab } from '../panel/model.ts';
import { type TabKey, tabKey } from '../panel/tabs.ts';

const noDocuments: Record<string, DocumentBuffer> = {};
const noSubscription = () => () => {};

export function useUnsavedTabs({
  tabs,
  documents,
  repository,
  hostId,
  projectId,
  sessionId,
}: {
  tabs: readonly OpenTab[];
  documents: DocumentStore | null | undefined;
  repository: CorralRepository;
  hostId: string | undefined;
  projectId: string;
  sessionId: string;
}): Partial<Record<TabKey, 'unsaved' | 'pending'>> {
  const buffers = useSyncExternalStore(
    documents?.subscribe ?? noSubscription,
    () => documents?.getState().documents ?? noDocuments,
    () => noDocuments,
  );
  // The graph tabs whose team draft is not saved, re-read whenever a team draft changes.
  const graphs = tabs.flatMap((tab) => (tab.kind === 'graph' ? [tab.corralId] : []));
  const dirtyGraphs = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeEditorCopies(repository, listener),
      [repository],
    ),
    () => graphs.filter((corralId) => editorCopyDirty(repository, projectId, corralId)).join('\n'),
    () => '',
  ).split('\n');
  const unsaved: Partial<Record<TabKey, 'unsaved' | 'pending'>> = {};
  for (const tab of tabs) {
    if (tab.kind === 'graph') {
      if (dirtyGraphs.includes(tab.corralId)) unsaved[tabKey(tab)] = 'unsaved';
      continue;
    }
    if (tab.kind !== 'document' || tab.source !== 'copy' || !tab.copy || !hostId) continue;
    const entry =
      buffers[
        documentKey(
          {
            hostId,
            projectId,
            sessionId,
            bindingId: tab.copy.bindingId,
            copyGeneration: tab.copy.generation,
          },
          tab.path,
        )
      ];
    if (!entry) continue;
    if (entry.pendingSave && !entry.saving) unsaved[tabKey(tab)] = 'pending';
    else if (entry.dirty || entry.pendingSave) unsaved[tabKey(tab)] = 'unsaved';
  }
  return unsaved;
}
