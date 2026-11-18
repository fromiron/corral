// The file tree's state, one per conversation (features/session-panel.md 파일 탭과 트리 열): the
// folders opened, the filter's text and mode, the results filter. The 파일 tab and the tree column
// share it within one visit, so it lives outside them in module memory and outlasts their screens
// unmounting. Entering the conversation (restored tabs start as if first opened), closing the 파일
// tab and deleting the conversation forget it, and a reload has none. The tree's source (the
// folder or the Paddock) is remembered on this device instead, until the conversation is deleted.
import { useCallback, useSyncExternalStore } from 'react';
import { forgetOnReset } from './viewMemory.ts';

const noPaths: ReadonlySet<string> = new Set();

export interface TreeState {
  readonly query: string;
  readonly searchMode: 'names' | 'contents';
  /** The folders opened, for the source listed when they were (`kind:id`). */
  readonly opened: { readonly scopeKey: string; readonly paths: ReadonlySet<string> };
  readonly resultsOn: boolean;
  /** The folders closed while filtering, for the filter they were closed under. */
  readonly filterClosed: { readonly key: string; readonly paths: ReadonlySet<string> };
}

/** The tree's source, remembered on this device per conversation. */
export const fileSourceKey = (sessionId: string) => `corral:file-source:v1:${sessionId}`;

export const FRESH_TREE: TreeState = {
  query: '',
  searchMode: 'names',
  opened: { scopeKey: '', paths: noPaths },
  resultsOn: false,
  filterClosed: { key: ':', paths: noPaths },
};

const states = new Map<string, TreeState>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
forgetOnReset(() => {
  states.clear();
  notify();
});

export function treeState(sessionId: string): TreeState {
  return states.get(sessionId) ?? FRESH_TREE;
}

export type TreeUpdate = Partial<TreeState> | ((state: TreeState) => Partial<TreeState>);

export function updateTreeState(sessionId: string, update: TreeUpdate) {
  const current = treeState(sessionId);
  const patch = typeof update === 'function' ? update(current) : update;
  const next = { ...current, ...patch };
  if ((Object.keys(patch) as (keyof TreeState)[]).every((key) => next[key] === current[key]))
    return;
  states.set(sessionId, next);
  notify();
}

/** The conversation was entered or its 파일 tab closed: its tree starts fresh. */
export function forgetTreeState(sessionId: string) {
  if (!states.delete(sessionId)) return;
  notify();
}

/** A deleted conversation's tree, and the source it remembered on this device, are gone. */
export function forgetDeletedTree(
  storage: Pick<Storage, 'removeItem'> | null,
  sessionId: string,
): void {
  forgetTreeState(sessionId);
  try {
    storage?.removeItem(fileSourceKey(sessionId));
  } catch {
    // Nothing to tell: the source stays until it is overwritten.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The conversation's tree state and its update. */
export function useTreeState(sessionId: string): [TreeState, (update: TreeUpdate) => void] {
  const state = useSyncExternalStore(
    subscribe,
    () => treeState(sessionId),
    () => treeState(sessionId),
  );
  const update = useCallback((next: TreeUpdate) => updateTreeState(sessionId, next), [sessionId]);
  return [state, update];
}
