import { type CanvasLayout, CorralDefinition } from '@corral/contracts';
import { compileDefinition, definitionHash, planRun } from '@corral/core';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../examples/research-team.layout.json' with { type: 'json' };
import {
  addNode,
  checkConnection,
  compileDraft,
  connect,
  connectCapability,
  draftFromDefinition,
  draftToDefinition,
  duplicateNode,
  type EditorDraft,
  emptyDraft,
  exportDocuments,
  importDocuments,
  moveNode,
  removeNode,
  setLoopMembership,
  updateNode,
} from '../src/editor/model.ts';

const team = () => CorralDefinition.parse(researchTeam);
const layout = () => researchLayout as unknown as CanvasLayout;

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}
function add(draft: EditorDraft, type: Parameters<typeof addNode>[1], x = 0, y = 0) {
  return addNode(draft, type, { x, y });
}
const control = (
  draft: EditorDraft,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
) => ok(connect(draft, { source, sourcePort, target, targetPort } as never)).draft;

describe('editor model: drawing a definition', () => {
  it('gives each dropped node a fresh, valid identifier', () => {
    let draft = emptyDraft();
    const ids: string[] = [];
    for (const type of ['agent', 'agent', 'decision', 'loop', 'output'] as const) {
      const added = add(draft, type);
      draft = added.draft;
      ids.push(added.nodeId);
    }
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
  });

  it('[TC-CAN-001-H] an empty canvas with Agent → Output compiles and is runnable', () => {
    let draft = emptyDraft();
    const a = add(draft, 'agent');
    const o = add(a.draft, 'output', 300);
    draft = control(o.draft, a.nodeId, 'out', o.nodeId, 'in');
    const result = compileDraft(draft);
    expect(result.diagnostics).toEqual([]);
    expect(result.runnable).toBe(true);
    expect(CorralDefinition.safeParse(result.definition).success).toBe(true);
  });

  it('builds the whole research → review loop → approval team from canvas gestures', () => {
    let draft = emptyDraft();
    const step = (type: Parameters<typeof addNode>[1]) => {
      const added = add(draft, type);
      draft = added.draft;
      return added.nodeId;
    };
    const research = step('agent');
    const loop = step('loop');
    const writer = step('agent');
    const reviewer = step('agent');
    const decision = step('decision');
    const approval = step('decision');
    const output = step('output');
    const helper = step('agent');
    for (const member of [writer, reviewer, decision])
      draft = setLoopMembership(draft, member, loop);
    draft = updateNode(draft, reviewer, { outputContract: 'review' });
    draft = updateNode(draft, approval, { mode: 'approval' });
    draft = updateNode(draft, helper, { invocation: 'callable' });

    draft = control(draft, research, 'out', loop, 'enter');
    draft = control(draft, loop, 'body', writer, 'in');
    draft = control(draft, writer, 'out', reviewer, 'in');
    draft = control(draft, reviewer, 'out', decision, 'in');
    draft = control(draft, decision, 'revise', loop, 'repeat');
    draft = control(draft, decision, 'pass', loop, 'exit');
    draft = control(draft, loop, 'next', approval, 'in');
    draft = control(draft, approval, 'approve', output, 'in');
    draft = ok(connectCapability(draft, research, helper, 'delegate')).draft;

    const result = compileDraft(draft);
    expect(result.diagnostics).toEqual([]);
    const definition = result.definition as CorralDefinition;
    const compiled = compileDefinition(definition);
    if (!compiled.ok) throw new Error('expected ok');
    expect(compiled.plan.order).toEqual([
      research,
      loop,
      writer,
      reviewer,
      decision,
      approval,
      output,
    ]);
    expect(compiled.plan.callables[research]).toEqual({ delegate: [helper], question: [] });
    // The review decision reads the reviewer, and the Output receives the writer's draft.
    const outputNode = definition.nodes.find((n) => n.id === output);
    expect(outputNode?.type === 'output' && outputNode.inputBindings).toEqual([
      { kind: 'task_output', name: 'text', sourceNodeId: writer },
    ]);
    // Loops run, but Decisions wait for reviews and approvals (P5): say which nodes.
    expect(result.runnable).toBe(false);
    expect(result.runtimeLimits.map((issue) => issue.nodeId)).toEqual([decision, approval]);
  });
});

describe('editor model: connection rules come from the compiler port table', () => {
  function sample() {
    let draft = emptyDraft();
    const ids: Record<string, string> = {};
    for (const [name, type] of [
      ['a', 'agent'],
      ['b', 'agent'],
      ['loop', 'loop'],
      ['inner', 'agent'],
      ['decision', 'decision'],
      ['out', 'output'],
      ['callable', 'agent'],
    ] as const) {
      const added = add(draft, type);
      draft = added.draft;
      ids[name] = added.nodeId;
    }
    draft = setLoopMembership(draft, ids.inner as string, ids.loop as string);
    draft = updateNode(draft, ids.callable as string, { invocation: 'callable' });
    draft = control(draft, ids.a as string, 'out', ids.b as string, 'in');
    return { draft, ids: ids as Record<string, string> };
  }

  it.each([
    ['output → agent', 'out', 'in', 'a', 'in', 'invalidSourcePort'],
    ['agent → itself', 'a', 'out', 'a', 'in', 'selfConnection'],
    ['a second next step from one port', 'a', 'out', 'out', 'in', 'duplicateOutgoing'],
    [
      'a decision port the mode does not have',
      'decision',
      'approve',
      'out',
      'in',
      'invalidSourcePort',
    ],
    ['into a callable agent', 'b', 'out', 'callable', 'in', 'callableInControlFlow'],
    ['from outside straight into a loop member', 'b', 'out', 'inner', 'in', 'loopBoundary'],
    ['back into an earlier step', 'b', 'out', 'a', 'in', 'cycle'],
  ])('refuses %s with a reason', (_name, source, sourcePort, target, targetPort, reason) => {
    const { draft, ids } = sample();
    const connection = {
      source: ids[source] ?? source,
      sourcePort,
      target: ids[target] ?? target,
      targetPort,
    };
    expect(checkConnection(draft, connection as never)).toEqual({ ok: false, reason });
  });

  it('[TC-CAN-003-H] a delegate link is a separate kind of connection that grants the call', () => {
    const { draft, ids } = sample();
    const linked = ok(
      connectCapability(draft, ids.a as string, ids.callable as string, 'delegate'),
    );
    const definition = draftToDefinition(linked.draft);
    expect(definition.capabilityLinks).toEqual([
      { id: linked.linkId, kind: 'delegate', sourceNodeId: ids.a, targetNodeId: ids.callable },
    ]);
    expect(definition.controlEdges.some((e) => e.target === ids.callable)).toBe(false);
    const role = definition.roles.find((r) => r.id === `${ids.a}_role`);
    expect(role?.allowedCollaborationTools).toEqual(
      expect.arrayContaining(['spawn_subagents', 'await_tasks']),
    );
    expect(connectCapability(draft, ids.a as string, ids.b as string, 'delegate')).toEqual({
      ok: false,
      reason: 'targetNotCallable',
    });
  });
});

describe('editor model: layout versus definition', () => {
  it('[TC-CAN-002-H] moving nodes or the Loop area changes the layout, not the definition', () => {
    const draft = draftFromDefinition(team(), layout());
    const before = definitionHash(draftToDefinition(draft));
    const movedNode = moveNode(draft, 'research', { x: 999, y: 10 });
    const movedLoop = moveNode(draft, 'review_loop', { x: 420, y: 180 });
    expect(definitionHash(draftToDefinition(movedNode))).toBe(before);
    expect(definitionHash(draftToDefinition(movedLoop))).toBe(before);
    // Members travel with the Loop area.
    expect(movedLoop.layout.write).toEqual({ x: 370 + 100, y: 160 + 100 });

    const moved = setLoopMembership(draft, 'review', null);
    expect(definitionHash(draftToDefinition(moved))).not.toBe(before);
  });

  it('round-trips a definition and its layout without changing them', () => {
    const draft = draftFromDefinition(team(), layout());
    expect(draftToDefinition(draft)).toEqual(team());
    const exported = exportDocuments(draft, 3);
    expect(JSON.parse(exported.definition)).toEqual(team());
    expect(JSON.parse(exported.layout)).toEqual({ ...layout(), layoutRevision: 3 });
  });

  it('[TC-CAN-005-N] a duplicated node gets new IDs that collide with nothing', () => {
    const draft = draftFromDefinition(team(), layout());
    const copy = duplicateNode(draft, 'write');
    const definition = draftToDefinition(copy.draft);
    const ids = definition.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const node = definition.nodes.find((n) => n.id === copy.nodeId);
    expect(node?.type === 'agent' && node.roleId).not.toBe('writer');
    expect(definition.roles.map((r) => r.id)).toContain(node?.type === 'agent' ? node.roleId : '');
    expect(
      definition.controlEdges.some((e) => e.source === copy.nodeId || e.target === copy.nodeId),
    ).toBe(false);
  });

  it('removing a node removes its connections, inputs that read it, and its unused role', () => {
    const draft = draftFromDefinition(team(), layout());
    const definition = draftToDefinition(removeNode(draft, 'review'));
    expect(definition.nodes.some((n) => n.id === 'review')).toBe(false);
    expect(
      definition.controlEdges.some((e) => e.source === 'review' || e.target === 'review'),
    ).toBe(false);
    const decision = definition.nodes.find((n) => n.id === 'review_decision');
    expect(decision?.type === 'decision' && decision.inputBindings).toEqual([]);
    expect(definition.roles.some((r) => r.id === 'reviewer')).toBe(false);
  });

  it('changing a decision mode updates its rule and drops branches that no longer exist', () => {
    const draft = draftFromDefinition(team(), layout());
    const changed = draftToDefinition(updateNode(draft, 'review_decision', { mode: 'approval' }));
    const decision = changed.nodes.find((n) => n.id === 'review_decision');
    expect(decision?.type === 'decision' && decision.rule).toBe('human_approval');
    expect(changed.controlEdges.some((e) => e.source === 'review_decision')).toBe(false);
  });
});

describe('editor model: import and export', () => {
  it('[TC-CAN-004-N] refuses files it does not understand', () => {
    expect(importDocuments('not json').ok).toBe(false);
    const unknownField = { ...team(), owner: 'someone' };
    expect(importDocuments(JSON.stringify(unknownField)).ok).toBe(false);
    const newer = { ...team(), schemaVersion: '0.2' };
    expect(importDocuments(JSON.stringify(newer)).ok).toBe(false);
    expect(importDocuments('x'.repeat(1024 * 1024 + 1)).ok).toBe(false);
  });

  it('imports a definition with or without a layout', () => {
    const withLayout = ok(importDocuments(JSON.stringify(team()), JSON.stringify(layout())));
    expect(withLayout.draft.layout.research).toEqual({ x: 40, y: 160 });
    const without = ok(importDocuments(JSON.stringify(team())));
    expect(Object.keys(without.draft.layout).sort()).toEqual(
      team()
        .nodes.map((n) => n.id)
        .sort(),
    );
    expect(planRun(draftToDefinition(without.draft)).ok).toBe(false);
  });
});
