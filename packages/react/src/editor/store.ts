import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  addNode,
  type ConnectionRejection,
  checkConnection,
  connect,
  type EditorDraft,
  type EditorNode,
  type EditorNodeType,
  emptyDraft,
  moveNode,
  type Point,
  removeEdge,
  removeNode,
  updateNode,
} from './model.ts';

export type EditorNotice =
  | { kind: 'rejected'; reason: ConnectionRejection }
  | { kind: 'connected'; source: string; target: string };

export interface EditorState {
  draft: EditorDraft;
  selectedNodeId: string | null;
  notice: EditorNotice | null;
  addNode(type: EditorNodeType, position: Point): string;
  moveNode(nodeId: string, position: Point): void;
  removeNode(nodeId: string): void;
  removeEdge(edgeId: string): void;
  connect(source: string, target: string): boolean;
  explainRejectedConnection(source: string, target: string): void;
  updateNode(nodeId: string, change: Partial<Pick<EditorNode, 'label' | 'prompt'>>): void;
  setBrief(brief: string): void;
  select(nodeId: string | null): void;
}

export type EditorStore = StoreApi<EditorState>;

export function createEditorStore(initial: EditorDraft = emptyDraft()): EditorStore {
  return createStore<EditorState>((set, get) => ({
    draft: initial,
    selectedNodeId: null,
    notice: null,

    addNode(type, position) {
      const added = addNode(get().draft, type, position);
      set({ draft: added.draft, selectedNodeId: added.nodeId });
      return added.nodeId;
    },
    moveNode(nodeId, position) {
      set({ draft: moveNode(get().draft, nodeId, position) });
    },
    removeNode(nodeId) {
      const selected = get().selectedNodeId;
      set({
        draft: removeNode(get().draft, nodeId),
        selectedNodeId: selected === nodeId ? null : selected,
      });
    },
    removeEdge(edgeId) {
      set({ draft: removeEdge(get().draft, edgeId) });
    },
    connect(source, target) {
      const result = connect(get().draft, source, target);
      if (!result.ok) {
        set({ notice: { kind: 'rejected', reason: result.reason } });
        return false;
      }
      set({ draft: result.draft, notice: { kind: 'connected', source, target } });
      return true;
    },
    explainRejectedConnection(source, target) {
      const check = checkConnection(get().draft, source, target);
      if (!check.ok) set({ notice: { kind: 'rejected', reason: check.reason } });
    },
    updateNode(nodeId, change) {
      set({ draft: updateNode(get().draft, nodeId, change) });
    },
    setBrief(brief) {
      set({ draft: { ...get().draft, brief } });
    },
    select(nodeId) {
      if (get().selectedNodeId !== nodeId) set({ selectedNodeId: nodeId });
    },
  }));
}
