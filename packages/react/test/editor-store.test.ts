import { describe, expect, it } from 'vitest';
import { addNode, connect } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import { addAgent } from '../src/team-editor/commands.ts';

function withAgentAndOutput() {
  const store = createEditorStore();
  const agent = addNode(store.getState().draft, 'agent');
  store.getState().applyDraft(agent.draft);
  const output = addNode(store.getState().draft, 'output');
  store.getState().applyDraft(output.draft);
  return { store, agent: agent.nodeId, output: output.nodeId };
}

describe('editor store history', () => {
  it('restores the empty team in one undo after adding its first agent and result', () => {
    const store = createEditorStore();
    const before = store.getState().draft;
    const result = addAgent(
      before,
      {
        role: {
          name: 'Planner',
          prompt: 'Make a plan.',
          modelProfile: 'model-a',
          outputContract: 'text',
          allowedWorkTools: [],
          allowedCollaborationTools: ['submit_result'],
        },
      },
      { kind: 'empty' },
    );
    if (!result.ok) throw new Error(result.reason);
    store.getState().applyDraft(result.draft);
    const { nodes, controlEdges } = store.getState().draft.definition;
    expect(nodes).toMatchObject([
      { type: 'agent', label: 'Planner' },
      { type: 'output', inputBindings: [{ kind: 'task_output', sourceNodeId: result.nodeId }] },
    ]);
    expect(controlEdges).toMatchObject([{ source: result.nodeId, target: nodes[1]?.id }]);
    store.getState().undo();
    expect(store.getState().draft).toBe(before);
    expect(store.getState().canUndo).toBe(false);
  });

  it('undoes and redoes structural edits, and a new edit clears redo', () => {
    const { store, agent, output } = withAgentAndOutput();
    const connected = connect(store.getState().draft, {
      source: agent,
      sourcePort: 'out',
      target: output,
      targetPort: 'in',
    });
    if (!connected.ok) throw new Error(connected.reason);
    store.getState().applyDraft(connected.draft);
    expect(store.getState().draft.definition.controlEdges).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().draft.definition.controlEdges).toHaveLength(0);
    expect(store.getState().canRedo).toBe(true);
    store.getState().applyDraft(addNode(store.getState().draft, 'agent').draft);
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

  it('loading another draft starts a fresh history', () => {
    const { store } = withAgentAndOutput();
    store.getState().replaceDraft(createEditorStore().getState().draft);
    expect(store.getState().canUndo).toBe(false);
    expect(store.getState().draft.definition.nodes).toEqual([]);
  });
});
