import { CorralDefinition } from '@corral/contracts';
import { definitionHash, planLinearRun } from '@corral/core';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  checkConnection,
  compileDraft,
  connect,
  type EditorDraft,
  emptyDraft,
  moveNode,
  removeNode,
} from '../src/editor/model.ts';

function agentToOutput(): { draft: EditorDraft; agent: string; output: string } {
  let draft = emptyDraft();
  const a = addNode(draft, 'agent', { x: 0, y: 0 });
  draft = a.draft;
  const o = addNode(draft, 'output', { x: 300, y: 0 });
  draft = o.draft;
  const c = connect(draft, a.nodeId, o.nodeId);
  if (!c.ok) throw new Error(c.reason);
  return { draft: c.draft, agent: a.nodeId, output: o.nodeId };
}

describe('editor model', () => {
  it('gives each dropped node a fresh, valid identifier', () => {
    let draft = emptyDraft();
    const ids: string[] = [];
    for (const type of ['agent', 'agent', 'output'] as const) {
      const added = addNode(draft, type, { x: 0, y: 0 });
      draft = added.draft;
      ids.push(added.nodeId);
    }
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
  });

  it('[TC-CAN-001-H] an empty canvas with Agent → Output compiles to a runnable definition', () => {
    const { draft } = agentToOutput();
    const result = compileDraft(draft);
    expect(result.issues).toEqual([]);
    expect(result.definition).toBeDefined();
    expect(CorralDefinition.safeParse(result.definition).success).toBe(true);
    expect(planLinearRun(result.definition as CorralDefinition).ok).toBe(true);
  });

  it('wires each agent to read the output of the agent before it', () => {
    let { draft, agent, output } = agentToOutput();
    const second = addNode(draft, 'agent', { x: 150, y: 0 });
    draft = removeEdgesFrom(second.draft, agent);
    const c1 = connect(draft, agent, second.nodeId);
    if (!c1.ok) throw new Error(c1.reason);
    const c2 = connect(c1.draft, second.nodeId, output);
    if (!c2.ok) throw new Error(c2.reason);
    const definition = compileDraft(c2.draft).definition as CorralDefinition;
    const node = definition.nodes.find((n) => n.id === second.nodeId);
    expect(node?.type === 'agent' && node.inputBindings).toEqual([
      { kind: 'task_output', name: 'previous', sourceNodeId: agent },
    ]);
    expect(planLinearRun(definition)).toMatchObject({ agentNodeIds: [agent, second.nodeId] });
  });

  it('[TC-CAN-002-H] moving nodes changes the layout but not the definition hash', () => {
    const { draft, agent } = agentToOutput();
    const before = definitionHash(compileDraft(draft).definition as CorralDefinition);
    const moved = moveNode(draft, agent, { x: 420, y: 180 });
    expect(moved.layout[agent]).toEqual({ x: 420, y: 180 });
    expect(definitionHash(compileDraft(moved).definition as CorralDefinition)).toBe(before);
  });

  it.each([
    ['output → agent', 'output', 'agent', 'outputHasNoOutgoingPort'],
    ['agent → itself', 'agent', 'agent', 'selfConnection'],
  ] as const)('rejects %s with a reason', (_name, from, to, reason) => {
    const { draft, agent, output } = agentToOutput();
    const ids = { agent, output };
    expect(checkConnection(draft, ids[from], ids[to])).toEqual({ ok: false, reason });
  });

  it('rejects a second next step from the same agent', () => {
    const { draft, agent } = agentToOutput();
    const other = addNode(draft, 'output', { x: 0, y: 200 });
    expect(checkConnection(other.draft, agent, other.nodeId)).toEqual({
      ok: false,
      reason: 'duplicateOutgoing',
    });
  });

  it('rejects an edge that would close a cycle', () => {
    let draft = emptyDraft();
    const a = addNode(draft, 'agent', { x: 0, y: 0 });
    const b = addNode(a.draft, 'agent', { x: 200, y: 0 });
    const ab = connect(b.draft, a.nodeId, b.nodeId);
    if (!ab.ok) throw new Error(ab.reason);
    draft = ab.draft;
    expect(checkConnection(draft, b.nodeId, a.nodeId)).toEqual({ ok: false, reason: 'cycle' });
  });

  it('reports what blocks a run and where, instead of compiling a broken graph', () => {
    const draft = addNode(emptyDraft(), 'agent', { x: 0, y: 0 }).draft;
    const result = compileDraft(draft);
    expect(result.definition).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('removing a node removes its edges', () => {
    const { draft, agent } = agentToOutput();
    const after = removeNode(draft, agent);
    expect(after.nodes.map((n) => n.id)).not.toContain(agent);
    expect(after.edges).toEqual([]);
    expect(after.layout[agent]).toBeUndefined();
  });
});

function removeEdgesFrom(draft: EditorDraft, source: string): EditorDraft {
  return { ...draft, edges: draft.edges.filter((e) => e.source !== source) };
}
