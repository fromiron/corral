// The tree's Refresh reads a conversation's open source-folder 문서 tabs again (workbench.md
// Paddock의 수동 파일 변경): nothing outside Corral says the source folder changed, so an edit made
// there shows once the person refreshes. A file gone on that read drops its tab as a restored 문서
// tab's missing file does, and a read that fails keeps it (features/session-panel.md 주소와 기억).
import type { WorkspacesApi } from '@corral/client';
import { useEffect, useRef } from 'react';
import type { DocumentAwaited, OpenTab, PanelEvent, PanelState } from '../panel/model.ts';
import { tabKey } from '../panel/tabs.ts';
import { noFile } from './useDocumentRestore.ts';

const listeners = new Map<string, Set<() => void>>();

/** Listens for a refresh of this conversation's tree; the returned function stops listening. */
export function onSourceReread(sessionId: string, listener: () => void): () => void {
  let own = listeners.get(sessionId);
  if (!own) {
    own = new Set();
    listeners.set(sessionId, own);
  }
  own.add(listener);
  return () => {
    own.delete(listener);
    if (own.size === 0 && listeners.get(sessionId) === own) listeners.delete(sessionId);
  };
}

/** Asks this conversation's open source-folder 문서 tabs to read their files again. */
export function readSourceFilesAgain(sessionId: string) {
  for (const listener of [...(listeners.get(sessionId) ?? [])]) listener();
}

export interface SourceRereadInput {
  sessionId: string;
  projectId: string;
  workspaces: Pick<WorkspacesApi, 'readFile'> | undefined;
  state: PanelState;
  dispatch: (event: PanelEvent) => void;
  /** The conversation now (an answer for one left is dropped). */
  current: () => string;
}

type SourceTab = Extract<OpenTab, { kind: 'document' }>;

/**
 * On each refresh of the conversation's tree, reads every open source-folder 문서 tab's file, on
 * screen or not, and drops the tabs whose files are gone. A tab on screen reads its own content
 * again (OriginalDocumentTab).
 */
export function useSourceReread(input: SourceRereadInput) {
  const latest = useRef(input);
  latest.current = input;
  const { sessionId } = input;
  useEffect(
    () =>
      onSourceReread(sessionId, () => {
        const { workspaces, projectId, state } = latest.current;
        if (!workspaces) return;
        const open = state.tabs.filter(
          (tab): tab is SourceTab => tab.kind === 'document' && tab.source === 'original',
        );
        if (open.length === 0) return;
        void Promise.all(
          open.map(async (tab) => {
            try {
              const file = await workspaces.readFile({ kind: 'project', id: projectId }, tab.path);
              return file.content.kind === 'absent';
            } catch (error) {
              return noFile(error);
            }
          }),
        ).then((missing) => {
          if (latest.current.current() !== sessionId) return;
          const tabs: DocumentAwaited[] = open
            .filter((_, index) => missing[index])
            .map((tab) => ({ key: tabKey(tab), instance: tab.instance }));
          if (tabs.length > 0) latest.current.dispatch({ type: 'sourceFilesGone', tabs });
        });
      }),
    [sessionId],
  );
}
