import type { CapabilityLink } from '@corral/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  addNode,
  type CapabilityRejection,
  type ConnectionRejection,
  type ConnectionRequest,
  checkConnection,
  connect,
  connectCapability,
  duplicateNode,
  type EditorDraft,
  type EditorNodeType,
  emptyDraft,
  moveNode,
  type NodeChange,
  type Point,
  removeEdge,
  removeLink,
  removeNode,
  resizeNode,
  setBrief,
  setLoopMembership,
  setName,
  setViewport,
  updateNode,
} from './model.ts';

export type EditorNotice =
  | { kind: 'rejected'; reason: ConnectionRejection | CapabilityRejection }
  | { kind: 'connected'; source: string; target: string };

const HISTORY_LIMIT = 100;

export interface EditorState {
  draft: EditorDraft;
  selectedNodeId: string | null;
  notice: EditorNotice | null;
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

  addNode(type: EditorNodeType, position: Point): string;
  duplicateNode(nodeId: string): string;
  moveNode(nodeId: string, position: Point): void;
  resizeNode(nodeId: string, box: { x?: number; y?: number; width: number; height: number }): void;
  setViewport(viewport: EditorDraft['viewport']): void;
  setLoopMembership(nodeId: string, loopId: string | null): void;
  updateNode(nodeId: string, change: NodeChange): void;
  setBrief(brief: string): void;
  setName(name: string): void;
  removeNode(nodeId: string): void;
  removeEdge(edgeId: string): void;
  removeLink(linkId: string): void;
  connect(request: ConnectionRequest): boolean;
  connectCapability(source: string, target: string, kind: CapabilityLink['kind']): boolean;
  explainRejectedConnection(request: ConnectionRequest): void;
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
      notice: null,
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
        set({ draft, selectedNodeId: null, notice: null, ...history([], []) });
      },

      addNode(type, position) {
        const added = addNode(get().draft, type, position);
        apply(added.draft);
        set({ selectedNodeId: added.nodeId });
        return added.nodeId;
      },
      duplicateNode(nodeId) {
        const copy = duplicateNode(get().draft, nodeId);
        apply(copy.draft);
        set({ selectedNodeId: copy.nodeId });
        return copy.nodeId;
      },
      moveNode: (nodeId, position) => apply(moveNode(get().draft, nodeId, position)),
      resizeNode: (nodeId, box) => apply(resizeNode(get().draft, nodeId, box)),
      // Panning and zooming are not edits: they never enter the undo history.
      setViewport: (viewport) => set({ draft: setViewport(get().draft, viewport) }),
      setLoopMembership: (nodeId, loopId) => apply(setLoopMembership(get().draft, nodeId, loopId)),
      updateNode: (nodeId, change) => apply(updateNode(get().draft, nodeId, change)),
      setBrief: (brief) => apply(setBrief(get().draft, brief)),
      setName: (name) => apply(setName(get().draft, name)),
      removeNode(nodeId) {
        apply(removeNode(get().draft, nodeId));
        if (get().selectedNodeId === nodeId) set({ selectedNodeId: null });
      },
      removeEdge: (edgeId) => apply(removeEdge(get().draft, edgeId)),
      removeLink: (linkId) => apply(removeLink(get().draft, linkId)),
      connect(request) {
        const result = connect(get().draft, request);
        if (!result.ok) {
          set({ notice: { kind: 'rejected', reason: result.reason } });
          return false;
        }
        apply(result.draft);
        set({ notice: { kind: 'connected', source: request.source, target: request.target } });
        return true;
      },
      connectCapability(source, target, kind) {
        const result = connectCapability(get().draft, source, target, kind);
        if (!result.ok) {
          set({ notice: { kind: 'rejected', reason: result.reason } });
          return false;
        }
        apply(result.draft);
        set({ notice: { kind: 'connected', source, target } });
        return true;
      },
      explainRejectedConnection(request) {
        const check = checkConnection(get().draft, request);
        if (!check.ok) set({ notice: { kind: 'rejected', reason: check.reason } });
      },
      select(nodeId) {
        if (get().selectedNodeId !== nodeId) set({ selectedNodeId: nodeId });
      },
    };
  });
}
