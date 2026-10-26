import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../src/editor/store.ts';

function withAgentAndOutput() {
  const store = createEditorStore();
  const agent = store.getState().addNode('agent', { x: 0, y: 0 });
  const output = store.getState().addNode('output', { x: 300, y: 0 });
  return { store, agent, output };
}

describe('editor store history', () => {
  it('one drag is one undo step', () => {
    const { store, agent } = withAgentAndOutput();
    store.getState().beginBatch();
    for (let x = 10; x <= 200; x += 10) store.getState().moveNode(agent, { x, y: 5 });
    store.getState().endBatch();
    expect(store.getState().draft.layout[agent]).toEqual({ x: 200, y: 5 });

    store.getState().undo();
    expect(store.getState().draft.layout[agent]).toEqual({ x: 0, y: 0 });
    store.getState().redo();
    expect(store.getState().draft.layout[agent]).toEqual({ x: 200, y: 5 });
  });

  it('undoes and redoes structural edits, and a new edit clears redo', () => {
    const { store, agent, output } = withAgentAndOutput();
    expect(
      store
        .getState()
        .connect({ source: agent, sourcePort: 'out', target: output, targetPort: 'in' }),
    ).toBe(true);
    expect(store.getState().draft.definition.controlEdges).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().draft.definition.controlEdges).toHaveLength(0);
    expect(store.getState().canRedo).toBe(true);
    store.getState().addNode('agent', { x: 0, y: 200 });
    expect(store.getState().canRedo).toBe(false);
  });

  it('a typing session in one field is one undo step', () => {
    const { store, agent } = withAgentAndOutput();
    store.getState().beginBatch();
    for (const label of ['W', 'Wr', 'Wri', 'Writ', 'Write', 'Writer'])
      store.getState().updateNode(agent, { label });
    store.getState().endBatch();
    store.getState().undo();
    expect(store.getState().draft.definition.nodes.find((n) => n.id === agent)?.label).toBe(
      'Agent 1',
    );
  });

  it('an empty batch adds nothing to undo', () => {
    const { store } = withAgentAndOutput();
    const before = store.getState().past.length;
    store.getState().beginBatch();
    store.getState().endBatch();
    expect(store.getState().past.length).toBe(before);
  });

  it('explains a refused connection without changing the draft', () => {
    const { store, agent } = withAgentAndOutput();
    const draft = store.getState().draft;
    expect(
      store
        .getState()
        .connect({ source: agent, sourcePort: 'out', target: agent, targetPort: 'in' }),
    ).toBe(false);
    expect(store.getState().notice).toEqual({ kind: 'rejected', reason: 'selfConnection' });
    expect(store.getState().draft).toBe(draft);
  });

  it('loading another draft starts a fresh history', () => {
    const { store } = withAgentAndOutput();
    store.getState().replaceDraft(createEditorStore().getState().draft);
    expect(store.getState().canUndo).toBe(false);
    expect(store.getState().draft.definition.nodes).toEqual([]);
  });
});
