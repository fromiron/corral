import { CorralDefinition, type CorralNode } from '@corral/contracts';
import { compileDefinition, definitionHash, reviewCriteriaHash } from '@corral/core';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { manyNodeDefinition } from '../../contracts/test/fixtures/many-nodes.ts';
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
  exportDefinition,
  importDefinition,
  removeNode,
  updateNode,
  withDefinition,
} from '../src/editor/model.ts';

const team = () => CorralDefinition.parse(researchTeam);

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}
const add = addNode;
/** Puts a step into a Loop or takes it out. */
function inLoop(draft: EditorDraft, nodeId: string, loopId: string | null): EditorDraft {
  const nodes = draft.definition.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const { parentId: _old, ...rest } = node;
    return (loopId ? { ...rest, parentId: loopId } : rest) as CorralNode;
  });
  return withDefinition(draft, { ...draft.definition, nodes });
}
const control = (
  draft: EditorDraft,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
) => ok(connect(draft, { source, sourcePort, target, targetPort } as never)).draft;

describe('editor model: drawing a definition', () => {
  it('imports, exports and compiles more than 64 unique-role nodes without losing limits', () => {
    const definition = manyNodeDefinition();
    const imported = ok(importDefinition(JSON.stringify(definition))).draft;
    const restored = ok(importDefinition(exportDefinition(imported))).draft;
    expect(restored.definition.nodes).toHaveLength(66);
    expect(restored.definition.roles).toHaveLength(65);
    expect(restored.definition.limits).toEqual(definition.limits);
    expect(compileDraft(restored).runnable).toBe(true);
  });

  it('adds and connects more than 64 agents through the normal editor operations', () => {
    let draft = emptyDraft();
    let previous: string | null = null;
    for (let index = 0; index < 65; index++) {
      const added = add(draft, 'agent');
      draft = previous ? control(added.draft, previous, 'out', added.nodeId, 'in') : added.draft;
      previous = added.nodeId;
    }
    const output = add(draft, 'output');
    if (!previous) throw new Error('Missing editor agent.');
    draft = control(output.draft, previous, 'out', output.nodeId, 'in');
    expect(draft.definition.nodes).toHaveLength(66);
    expect(draft.definition.roles).toHaveLength(65);
    expect(compileDraft(draft).runnable).toBe(true);
    const restored = ok(importDefinition(exportDefinition(draft))).draft;
    expect(restored.definition).toEqual(draft.definition);
  });

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

  it('an empty canvas with Agent → Output compiles and is runnable', () => {
    let draft = emptyDraft();
    const a = add(draft, 'agent');
    const o = add(a.draft, 'output');
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
    for (const member of [writer, reviewer, decision]) draft = inLoop(draft, member, loop);
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
    // Since P5 the whole team runs: Loop, Decisions and the final approval.
    expect(result.runnable).toBe(true);
    expect(result.runtimeLimits).toEqual([]);
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
    draft = inLoop(draft, ids.inner as string, ids.loop as string);
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

  it('a delegate link is a separate kind of connection that grants the call', () => {
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

describe('editor model: editing a saved team', () => {
  it('round-trips a definition without changing it', () => {
    const draft = draftFromDefinition(team());
    expect(draftToDefinition(draft)).toEqual(team());
    expect(JSON.parse(exportDefinition(draft))).toEqual(team());
    expect(definitionHash(draftToDefinition(inLoop(draft, 'review', null)))).not.toBe(
      definitionHash(team()),
    );
  });

  it('a duplicated node gets new IDs that collide with nothing', () => {
    const draft = draftFromDefinition(team());
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
    const draft = draftFromDefinition(team());
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
    const draft = draftFromDefinition(team());
    const changed = draftToDefinition(updateNode(draft, 'review_decision', { mode: 'approval' }));
    const decision = changed.nodes.find((n) => n.id === 'review_decision');
    expect(decision?.type === 'decision' && 'rule' in decision && decision.rule).toBe(
      'human_approval',
    );
    expect(changed.controlEdges.some((e) => e.source === 'review_decision')).toBe(false);
  });
});

describe('editor model: import and export', () => {
  it('refuses files it does not understand', () => {
    expect(importDefinition('not json').ok).toBe(false);
    const unknownField = { ...team(), owner: 'someone' };
    expect(importDefinition(JSON.stringify(unknownField)).ok).toBe(false);
    const newer = { ...team(), schemaVersion: '0.2' };
    expect(importDefinition(JSON.stringify(newer)).ok).toBe(false);
    expect(importDefinition('x'.repeat(1024 * 1024 + 1)).ok).toBe(false);
  });
});

describe('file tools switch', () => {
  it('stores a pinned review recipe in the definition without changing an earlier draft', () => {
    const draft = draftFromDefinition(team());
    const recipe = {
      recipeId: 'quality',
      revision: 1,
      criteriaHash: reviewCriteriaHash(draft.definition.input.criteria),
      candidateNodeId: 'write',
      evaluatorRoleId: 'reviewer',
      checkIds: [],
      criteriaFiles: [],
      maxAttempts: 2,
      maxRepairs: 1,
    };
    const on = updateNode(draft, 'review_loop', { reviewRecipe: recipe });
    expect(on.definition.nodes.find((node) => node.id === 'review_loop')).toHaveProperty(
      'reviewRecipe',
      recipe,
    );
    expect(draft.definition.nodes.find((node) => node.id === 'review_loop')).not.toHaveProperty(
      'reviewRecipe',
    );
    expect(compileDraft(on).runnable).toBe(true);
    const off = updateNode(on, 'review_loop', { reviewRecipe: null });
    expect(off.definition.nodes.find((node) => node.id === 'review_loop')).not.toHaveProperty(
      'reviewRecipe',
    );
  });
  it('pins and removes a role harness without retaining a null field', () => {
    const added = addNode(emptyDraft(), 'agent');
    const binding = { profileId: 'writer', revision: 2 };
    const on = updateNode(added.draft, added.nodeId, { harness: binding });
    expect(on.definition.roles[0]?.harness).toEqual(binding);
    expect(added.draft.definition.roles[0]).not.toHaveProperty('harness');
    const off = updateNode(on, added.nodeId, { harness: null });
    expect(off.definition.roles[0]).not.toHaveProperty('harness');
    expect(off.definition.roles).toEqual(added.draft.definition.roles);
  });
  it('gives a role every file tool, and takes them all away again', () => {
    const added = addNode(emptyDraft(), 'agent');
    const roleOf = (draft: EditorDraft) => draft.definition.roles[0]?.allowedWorkTools;
    const on = updateNode(added.draft, added.nodeId, { fileTools: true });
    expect(roleOf(on)).toEqual([
      'write_artifact',
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'move_file',
    ]);
    const off = updateNode(on, added.nodeId, { fileTools: false });
    expect(roleOf(off)).toEqual(['write_artifact']);
  });
  it('keeps shell permission independent of file permission and pins explicit editing choices', () => {
    const added = addNode(emptyDraft(), 'agent');
    const on = updateNode(added.draft, added.nodeId, {
      fileTools: true,
      runCommand: true,
      editingMode: 'hashline',
    });
    expect(on.definition.roles[0]?.allowedWorkTools).toContain('run_command');
    expect(on.definition.roles[0]?.editingMode).toBe('hashline');
    expect(added.draft.definition.roles[0]).not.toHaveProperty('editingMode');
    const filesOff = updateNode(on, added.nodeId, { fileTools: false });
    expect(filesOff.definition.roles[0]?.allowedWorkTools).toEqual([
      'write_artifact',
      'run_command',
    ]);
    const shellOff = updateNode(filesOff, added.nodeId, { runCommand: false, editingMode: 'pi' });
    expect(shellOff.definition.roles[0]?.allowedWorkTools).toEqual(['write_artifact']);
    expect(shellOff.definition.roles[0]?.editingMode).toBe('pi');
  });
  it('persists image permission and profile independently of file and shell access', () => {
    const added = addNode(emptyDraft(), 'agent');
    const enabled = updateNode(added.draft, added.nodeId, {
      generateImage: true,
      imageProfile: 'image_profile',
    });
    expect(enabled.definition.roles[0]?.allowedWorkTools).toEqual([
      'write_artifact',
      'generate_image',
    ]);
    expect(enabled.definition.roles[0]?.imageProfile).toBe('image_profile');
    const disabled = updateNode(enabled, added.nodeId, { generateImage: false });
    expect(disabled.definition.roles[0]?.allowedWorkTools).toEqual(['write_artifact']);
    expect(disabled.definition.roles[0]?.imageProfile).toBe('image_profile');
    const cleared = updateNode(disabled, added.nodeId, { imageProfile: null });
    expect(cleared.definition.roles[0]).not.toHaveProperty('imageProfile');
    expect(added.draft.definition.roles[0]).not.toHaveProperty('imageProfile');
  });
  it('keeps file, service and interaction preview permissions independent', () => {
    const added = addNode(emptyDraft(), 'agent');
    const enabled = updateNode(added.draft, added.nodeId, {
      previewFile: true,
      previewApp: true,
      previewAction: true,
    });
    expect(enabled.definition.roles[0]?.allowedWorkTools).toEqual([
      'write_artifact',
      'preview_file',
      'preview_app',
      'preview_action',
    ]);
    const disabled = updateNode(enabled, added.nodeId, { previewAction: false });
    expect(disabled.definition.roles[0]?.allowedWorkTools).toEqual([
      'write_artifact',
      'preview_file',
      'preview_app',
    ]);
  });
});
