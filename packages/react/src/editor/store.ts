import type { CapabilityLink } from '@corral/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  connectCapability,
  type EditorDraft,
  emptyDraft,
  type NodeChange,
  removeEdge,
  removeLink,
  removeNode,
  setBrief,
  setName,
  updateNode,
} from './model.ts';

const HISTORY_LIMIT = 100;

export interface EditorState {
  draft: EditorDraft;
  /** A step another view asks the editor to select, such as one just imported. */
  selectedNodeId: string | null;
  past: EditorDraft[];
  future: EditorDraft[];
  canUndo: boolean;
  canRedo: boolean;
  /** Groups many updates (one drag, one typing session) into one undo step. */
  beginBatch(): void;
  endBatch(): void;
  undo(): void;
  redo(): void;
  replaceDraft(draft: EditorDraft): void;
  /** A reviewed import is one reversible edit, unlike loading a saved document. */
  applyDraft(draft: EditorDraft): void;

  updateNode(nodeId: string, change: NodeChange): void;
  setBrief(brief: string): void;
  setName(name: string): void;
  removeNode(nodeId: string): void;
  removeEdge(edgeId: string): void;
  removeLink(linkId: string): void;
  connectCapability(source: string, target: string, kind: CapabilityLink['kind']): boolean;
  select(nodeId: string | null): void;
}

export type EditorStore = StoreApi<EditorState>;

export function createEditorStore(initial: EditorDraft = emptyDraft()): EditorStore {
  return createStore<EditorState>((set, get) => {
    let batchStart: EditorDraft | null = null;

    const history = (past: EditorDraft[], future: EditorDraft[]) => ({
      past,
      future,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
    });

    /** Applies an edit; outside a batch the previous draft becomes one undo step. */
    const apply = (next: EditorDraft) => {
      const { draft, past } = get();
      if (next === draft) return;
      if (batchStart) {
        set({ draft: next });
        return;
      }
      set({ draft: next, ...history([...past, draft].slice(-HISTORY_LIMIT), []) });
    };

    return {
      draft: initial,
      selectedNodeId: null,
      ...history([], []),

      beginBatch() {
        batchStart ??= get().draft;
      },
      endBatch() {
        const start = batchStart;
        batchStart = null;
        if (!start || start === get().draft) return;
        set(history([...get().past, start].slice(-HISTORY_LIMIT), []));
      },
      undo() {
        const { past, future, draft } = get();
        const previous = past.at(-1);
        if (batchStart || !previous) return;
        set({ draft: previous, ...history(past.slice(0, -1), [draft, ...future]) });
      },
      redo() {
        const { past, future, draft } = get();
        const [next, ...rest] = future;
        if (batchStart || !next) return;
        set({ draft: next, ...history([...past, draft], rest) });
      },
      replaceDraft(draft) {
        batchStart = null;
        set({ draft, selectedNodeId: null, ...history([], []) });
      },
      applyDraft: (draft) => apply(draft),

      updateNode: (nodeId, change) => apply(updateNode(get().draft, nodeId, change)),
      setBrief: (brief) => apply(setBrief(get().draft, brief)),
      setName: (name) => apply(setName(get().draft, name)),
      removeNode(nodeId) {
        apply(removeNode(get().draft, nodeId));
        if (get().selectedNodeId === nodeId) set({ selectedNodeId: null });
      },
      removeEdge: (edgeId) => apply(removeEdge(get().draft, edgeId)),
      removeLink: (linkId) => apply(removeLink(get().draft, linkId)),
      connectCapability(source, target, kind) {
        const result = connectCapability(get().draft, source, target, kind);
        if (result.ok) apply(result.draft);
        return result.ok;
      },
      select(nodeId) {
        if (get().selectedNodeId !== nodeId) set({ selectedNodeId: nodeId });
      },
    };
  });
}
