import type { AgentRole } from '@corral/contracts';
import { compileDefinition } from '@corral/core';
import { describe, expect, it } from 'vitest';
import {
  connectCapability,
  type EditorDraft,
  emptyDraft,
  updateNode,
} from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import {
  applyPattern,
  connectPorts,
  type EditResult,
  importableRoles,
  importRole,
  patchNode,
  placeStep,
  removeItems,
  type StepKind,
  setParent,
  watchAgent,
  wrapIn,
} from '../src/team-editor/commands.ts';

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}
const refused = (result: EditResult) => (result.ok ? 'accepted' : result.reason);

/** The connections as `source.port>target.port`, sorted, for comparing the wiring. */
const wiring = (draft: EditorDraft) =>
  draft.definition.controlEdges
    .map((e) => `${e.source}.${e.sourcePort}>${e.target}.${e.targetPort}`)
    .sort();
const node = (draft: EditorDraft, id: string) => draft.definition.nodes.find((n) => n.id === id);
const codes = (draft: EditorDraft) =>
  compileDefinition(draft.definition).diagnostics.map((d) => d.code);

/** agent_1 → agent_2 → agent_3, built by appending. */
function chain(length = 3): EditorDraft {
  let { draft, nodeId } = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  for (let i = 1; i < length; i++)
    ({ draft, nodeId } = ok(placeStep(draft, 'agent', { kind: 'after', nodeId })));
  return draft;
}

describe('team editor commands: adding steps', () => {
  it('appends after a step and takes over what came after it', () => {
    const draft = chain(2);
    expect(wiring(draft)).toEqual(['agent_1.out>agent_2.in']);
    const { draft: next, nodeId } = ok(
      placeStep(draft, 'review', { kind: 'after', nodeId: 'agent_1' }),
    );
    expect(wiring(next)).toEqual([`${nodeId}.pass>agent_2.in`, `agent_1.out>${nodeId}.in`].sort());
    expect(next.definition.entryNodeId).toBe('agent_1');
  });

  it('inserts on a connection and removes the old one', () => {
    const draft = chain(2);
    const edgeId = draft.definition.controlEdges[0]?.id as string;
    const { draft: next, nodeId } = ok(placeStep(draft, 'agent', { kind: 'edge', edgeId }));
    expect(wiring(next)).toEqual(['agent_1.out>agent_3.in', 'agent_3.out>agent_2.in']);
    expect(nodeId).toBe('agent_3');
    expect(next.definition.controlEdges.some((e) => e.id === edgeId)).toBe(false);
  });

  it('fans out instead when the new step has nowhere to continue', () => {
    const { draft } = ok(placeStep(chain(2), 'output', { kind: 'after', nodeId: 'agent_1' }));
    expect(wiring(draft)).toEqual(['agent_1.out>agent_2.in', 'agent_1.out>output_1.in']);
  });

  it('puts the first step into an empty box between its body and its exit', () => {
    const { draft, nodeId: loop } = ok(placeStep(emptyDraft(), 'loop', { kind: 'empty' }));
    const { draft: next, nodeId } = ok(placeStep(draft, 'agent', { kind: 'into', boxId: loop }));
    expect(node(next, nodeId)?.parentId).toBe(loop);
    expect(wiring(next)).toEqual(
      [`${loop}.body>${nodeId}.in`, `${nodeId}.out>${loop}.exit`].sort(),
    );
  });

  it('adds a later step into a box at the end of its body', () => {
    const { draft, nodeId: loop } = ok(placeStep(emptyDraft(), 'loop', { kind: 'empty' }));
    const first = ok(placeStep(draft, 'agent', { kind: 'into', boxId: loop }));
    const second = ok(placeStep(first.draft, 'agent', { kind: 'into', boxId: loop }));
    expect(node(second.draft, second.nodeId)?.parentId).toBe(loop);
    expect(wiring(second.draft)).toEqual(
      [
        `${loop}.body>${first.nodeId}.in`,
        `${first.nodeId}.out>${second.nodeId}.in`,
        `${second.nodeId}.out>${loop}.exit`,
      ].sort(),
    );
  });

  it('creates every kind of step the editor offers as a node the contract accepts', () => {
    const kinds: StepKind[] = [
      'agent',
      'observer',
      'review',
      'approval',
      'rule',
      'check',
      'router',
      'loop',
      'team',
      'join',
      'output',
    ];
    let draft = emptyDraft();
    for (const kind of kinds) draft = ok(placeStep(draft, kind, { kind: 'empty' })).draft;
    expect(draft.definition.nodes).toHaveLength(kinds.length);
    expect(codes(draft)).not.toContain('SCHEMA');
  });

  it('refuses to insert anything but a decision on a repeat connection', () => {
    let { draft, nodeId: loop } = ok(placeStep(emptyDraft(), 'loop', { kind: 'empty' }));
    const agent = ok(placeStep(draft, 'agent', { kind: 'into', boxId: loop }));
    const review = ok(placeStep(agent.draft, 'review', { kind: 'after', nodeId: agent.nodeId }));
    draft = ok(
      connectPorts(review.draft, {
        source: review.nodeId,
        sourcePort: 'revise',
        target: loop,
        targetPort: 'repeat',
      }),
    ).draft;
    const repeat = draft.definition.controlEdges.find((e) => e.targetPort === 'repeat')
      ?.id as string;
    expect(refused(placeStep(draft, 'agent', { kind: 'edge', edgeId: repeat }))).toBe(
      'repeatNeedsDecision',
    );
    expect(refused(placeStep(draft, 'approval', { kind: 'edge', edgeId: repeat }))).toBe(
      'accepted',
    );
  });

  it('refuses to continue after an output', () => {
    const { draft, nodeId } = ok(placeStep(emptyDraft(), 'output', { kind: 'empty' }));
    expect(refused(placeStep(draft, 'agent', { kind: 'after', nodeId }))).toBe('noNextStep');
  });
});

describe('team editor commands: connecting ports', () => {
  it('lets one port lead to several steps', () => {
    let draft = chain(2);
    draft = ok(placeStep(draft, 'agent', { kind: 'empty' })).draft;
    draft = ok(
      connectPorts(draft, {
        source: 'agent_1',
        sourcePort: 'out',
        target: 'agent_3',
        targetPort: 'in',
      }),
    ).draft;
    expect(wiring(draft)).toEqual(['agent_1.out>agent_2.in', 'agent_1.out>agent_3.in']);
  });

  it('says why a connection is refused', () => {
    const draft = chain(3);
    const request = (source: string, sourcePort: string, target: string, targetPort: string) =>
      refused(connectPorts(draft, { source, sourcePort, target, targetPort } as never));
    expect(request('agent_1', 'out', 'agent_2', 'in')).toBe('duplicate');
    expect(request('agent_3', 'out', 'agent_1', 'in')).toBe('cycle');
    expect(request('agent_2', 'out', 'agent_2', 'in')).toBe('selfConnection');
    expect(request('agent_1', 'pass', 'agent_3', 'in')).toBe('invalidSourcePort');
    expect(request('agent_1', 'out', 'agent_3', 'repeat')).toBe('invalidTargetPort');
    expect(request('agent_1', 'out', 'nobody', 'in')).toBe('unknownNode');
  });

  it('refuses a connection into a box that skips its enter port, and repeat from a non-decision', () => {
    const outside = chain(1);
    const { draft, nodeId: loop } = ok(placeStep(outside, 'loop', { kind: 'empty' }));
    const inner = ok(placeStep(draft, 'agent', { kind: 'into', boxId: loop }));
    expect(
      refused(
        connectPorts(inner.draft, {
          source: 'agent_1',
          sourcePort: 'out',
          target: inner.nodeId,
          targetPort: 'in',
        }),
      ),
    ).toBe('boxBoundary');
    expect(
      refused(
        connectPorts(inner.draft, {
          source: inner.nodeId,
          sourcePort: 'out',
          target: loop,
          targetPort: 'repeat',
        }),
      ),
    ).toBe('repeatNeedsDecision');
  });

  it('keeps callable agents out of the control flow', () => {
    const draft = patchNode(chain(2), 'agent_2', { invocation: 'callable' });
    expect(
      refused(
        connectPorts(draft, {
          source: 'agent_1',
          sourcePort: 'error',
          target: 'agent_2',
          targetPort: 'in',
        }),
      ),
    ).toBe('callableInControlFlow');
  });
});

describe('team editor commands: boxes', () => {
  it('wraps steps in a loop and routes the flow through its ports', () => {
    const { draft, nodeId: loop } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    expect(node(draft, 'agent_2')?.parentId).toBe(loop);
    expect(wiring(draft)).toEqual(
      [
        `agent_1.out>${loop}.enter`,
        `${loop}.body>agent_2.in`,
        `agent_2.out>${loop}.exit`,
        `${loop}.next>agent_3.in`,
        `${loop}.exhausted>agent_3.in`,
      ].sort(),
    );
    expect(codes(draft)).not.toContain('BOX_BOUNDARY');
  });

  it('wraps the first steps of a team without inventing a way in', () => {
    const { draft, nodeId: team } = ok(wrapIn(chain(2), ['agent_1', 'agent_2'], 'team'));
    expect(wiring(draft)).toEqual([`${team}.body>agent_1.in`, 'agent_1.out>agent_2.in'].sort());
    expect(draft.definition.entryNodeId).toBe(team);
  });

  it('wraps a step inside a box into a nested box and keeps exits to the outer box', () => {
    const { draft, nodeId: outer } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    const { draft: nested, nodeId: inner } = ok(wrapIn(draft, ['agent_2'], 'team'));
    expect(node(nested, inner)?.parentId).toBe(outer);
    expect(wiring(nested)).toEqual(
      [
        `agent_1.out>${outer}.enter`,
        `${outer}.body>${inner}.enter`,
        `${inner}.body>agent_2.in`,
        `agent_2.out>${outer}.exit`,
        `${outer}.next>agent_3.in`,
        `${outer}.exhausted>agent_3.in`,
      ].sort(),
    );
    expect(codes(nested)).not.toContain('BOX_BOUNDARY');
  });

  it('a Team gets no exhausted path, and a Loop with nothing after it gets none either', () => {
    const team = ok(wrapIn(chain(3), ['agent_2'], 'team'));
    expect(wiring(team.draft).filter((w) => w.includes('.exhausted>'))).toEqual([]);
    const last = ok(wrapIn(chain(2), ['agent_2'], 'loop'));
    expect(
      wiring(last.draft).filter((w) => w.includes('.next>') || w.includes('.exhausted>')),
    ).toEqual([]);
  });

  it.each([
    ['a Loop', (d: EditorDraft) => wrapIn(d, ['agent_2'], 'loop')],
    ['a review loop', (d: EditorDraft) => applyPattern(d, 'reviewLoop', ['agent_2'])],
    ['a check loop', (d: EditorDraft) => applyPattern(d, 'checkLoop', ['agent_2'])],
  ] as const)(
    'wrapping in %s is one undo step with its exhausted path, and the box takes it when removed',
    (_name, wrap) => {
      const store = createEditorStore(chain(3));
      const before = wiring(store.getState().draft);
      const { draft, nodeId: loop } = ok(wrap(store.getState().draft));
      store.getState().applyDraft(draft);
      const wrapped = wiring(store.getState().draft);
      expect(wrapped).toContain(`${loop}.exhausted>agent_3.in`);
      store.getState().undo();
      expect(wiring(store.getState().draft)).toEqual(before);
      store.getState().redo();
      expect(wiring(store.getState().draft)).toEqual(wrapped);
      store.getState().applyDraft(removeItems(store.getState().draft, [loop]));
      expect(wiring(store.getState().draft).filter((w) => w.includes('.exhausted>'))).toEqual([]);
    },
  );

  /** agent_1 → agent_2 → [agent_3 | agent_5] → join_1 → agent_4 → output_1. */
  const beforeFanOut = () => {
    const chained = ok(placeStep(chain(4), 'output', { kind: 'after', nodeId: 'agent_4' })).draft;
    return ok(applyPattern(chained, 'parallel', ['agent_3'])).draft;
  };
  const errors = (draft: EditorDraft) =>
    compileDefinition(draft.definition)
      .diagnostics.filter((d) => d.severity === 'error')
      .map((d) => d.code);

  it.each([
    ['a Loop', (d: EditorDraft) => wrapIn(d, ['agent_2'], 'loop'), ['LOOP_NO_REPEAT']],
    ['a review loop', (d: EditorDraft) => applyPattern(d, 'reviewLoop', ['agent_2']), []],
    ['a check loop', (d: EditorDraft) => applyPattern(d, 'checkLoop', ['agent_2']), []],
  ] as const)(
    'wrapping in %s before a fan-out leaves exhausted unconnected, so the Join still gathers',
    (_name, wrap, left) => {
      const base = beforeFanOut();
      expect(errors(base)).toEqual([]);
      const { draft, nodeId: loop } = ok(wrap(base));
      expect(
        wiring(draft).filter((w) => w.startsWith(`${loop}.`) && !w.includes('.body>')),
      ).toEqual([`${loop}.next>agent_3.in`, `${loop}.next>agent_5.in`]);
      expect(errors(draft)).toEqual(left);
    },
  );

  it('connects exhausted once when two connections led to the same step', () => {
    // agent_1 → agent_2 → agent_3, and agent_1 → agent_3 too: both leave the box for agent_3.
    const both = ok(
      connectPorts(chain(3), {
        source: 'agent_1',
        sourcePort: 'out',
        target: 'agent_3',
        targetPort: 'in',
      }),
    ).draft;
    const { draft, nodeId: loop } = ok(wrapIn(both, ['agent_1', 'agent_2'], 'loop'));
    expect(wiring(draft).filter((w) => /\.(next|exhausted)>/.test(w))).toEqual([
      `${loop}.exhausted>agent_3.in`,
      `${loop}.next>agent_3.in`,
    ]);
  });

  it('refuses to wrap steps from different boxes together', () => {
    const { draft } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    expect(refused(wrapIn(draft, ['agent_1', 'agent_2'], 'team'))).toBe('mixedBoxes');
  });

  it('removing a box keeps its steps and reconnects the flow around it', () => {
    const { draft, nodeId: loop } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    const removed = removeItems(draft, [loop]);
    expect(node(removed, loop)).toBeUndefined();
    expect(node(removed, 'agent_2')?.parentId).toBeUndefined();
    expect(wiring(removed)).toEqual(['agent_1.out>agent_2.in', 'agent_2.out>agent_3.in']);
  });

  it('moves a step between boxes but never into itself', () => {
    const { draft, nodeId: outer } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    const { draft: nested, nodeId: inner } = ok(wrapIn(draft, ['agent_2'], 'team'));
    expect(refused(setParent(nested, outer, inner))).toBe('boxBoundary');
    expect(refused(setParent(nested, 'agent_1', 'agent_3'))).toBe('notABox');
    const moved = ok(setParent(nested, 'agent_2', null));
    expect(node(moved.draft, 'agent_2')?.parentId).toBeUndefined();
  });
});

describe('team editor commands: patterns on the selection', () => {
  it('wraps the selection in a review loop: the verdict passes out or sends the work round again', () => {
    const { draft, nodeId: loop } = ok(applyPattern(chain(2), 'reviewLoop', ['agent_1']));
    const loopNode = node(draft, loop);
    expect(loopNode?.type).toBe('loop');
    expect(loopNode?.type === 'loop' ? loopNode.maxIterations : 0).toBe(3);
    const inside = draft.definition.nodes.filter((n) => n.parentId === loop);
    const reviewer = inside.find((n) => n.type === 'agent' && n.id !== 'agent_1');
    const verdict = inside.find((n) => n.type === 'decision');
    expect(reviewer).toBeDefined();
    expect(verdict?.type === 'decision' ? verdict.mode : null).toBe('review');
    expect(wiring(draft)).toEqual(
      [
        `${loop}.body>agent_1.in`,
        `agent_1.out>${reviewer?.id}.in`,
        `${reviewer?.id}.out>${verdict?.id}.in`,
        `${verdict?.id}.pass>${loop}.exit`,
        `${verdict?.id}.revise>${loop}.repeat`,
        `${loop}.next>agent_2.in`,
        `${loop}.exhausted>agent_2.in`,
      ].sort(),
    );
    const role = draft.definition.roles.find(
      (r) => reviewer?.type === 'agent' && r.id === reviewer.roleId,
    );
    expect(role?.outputContract).toBe('review');
    // The work sees the last review when it goes round again.
    const work = node(draft, 'agent_1');
    expect(
      work?.type === 'agent' &&
        work.invocation !== 'observer' &&
        work.inputBindings.some(
          (b) => b.kind === 'previous_iteration_output' && b.sourceNodeId === reviewer?.id,
        ),
    ).toBe(true);
    expect(draft.definition.nodes.some((n) => n.type === 'decision' && n.mode === 'approval')).toBe(
      false,
    );
    const codes = compileDefinition(draft.definition).diagnostics.map((d) => d.code);
    expect(codes).not.toContain('BOX_BOUNDARY');
    expect(codes).not.toContain('LOOP_NO_REPEAT');
    expect(codes).not.toContain('LOOP_NO_EXIT');
  });

  it('wraps the selection in a check loop: a failed check goes round again', () => {
    const { draft, nodeId: loop } = ok(applyPattern(chain(2), 'checkLoop', ['agent_2']));
    const check = draft.definition.nodes.find((n) => n.parentId === loop && n.type === 'decision');
    expect(check?.type === 'decision' ? check.mode : null).toBe('check');
    expect(wiring(draft)).toEqual(
      [
        `agent_1.out>${loop}.enter`,
        `${loop}.body>agent_2.in`,
        `agent_2.out>${check?.id}.in`,
        `${check?.id}.pass>${loop}.exit`,
        `${check?.id}.fail>${loop}.repeat`,
      ].sort(),
    );
  });

  it('a check loop with a step after it goes on there when exhausted, as through next', () => {
    const { draft, nodeId: loop } = ok(applyPattern(chain(3), 'checkLoop', ['agent_2']));
    expect(wiring(draft)).toEqual(
      expect.arrayContaining([`${loop}.next>agent_3.in`, `${loop}.exhausted>agent_3.in`]),
    );
    expect(codes(draft)).not.toContain('BOX_BOUNDARY');
  });

  it('adds a new agent for the pattern when nothing is selected', () => {
    const { draft, nodeId: loop } = ok(
      applyPattern(chain(1), 'reviewLoop', [], { kind: 'after', nodeId: 'agent_1' }),
    );
    const members = draft.definition.nodes.filter((n) => n.parentId === loop);
    expect(members.filter((n) => n.type === 'agent')).toHaveLength(2);
    expect(wiring(draft)).toContain(`agent_1.out>${loop}.enter`);
  });

  it('splits an agent in parallel: both start from the same step and a Join merges them', () => {
    const { draft, nodeId: join } = ok(applyPattern(chain(3), 'parallel', ['agent_2']));
    const copy = draft.definition.nodes.find(
      (n) => n.type === 'agent' && !['agent_1', 'agent_2', 'agent_3'].includes(n.id),
    );
    expect(node(draft, join)?.type).toBe('join');
    expect(wiring(draft)).toEqual(
      [
        'agent_1.out>agent_2.in',
        `agent_1.out>${copy?.id}.in`,
        `agent_2.out>${join}.in`,
        `${copy?.id}.out>${join}.in`,
        `${join}.out>agent_3.in`,
      ].sort(),
    );
    const codes = compileDefinition(draft.definition).diagnostics.map((d) => d.code);
    expect(codes).not.toContain('PARALLEL_MERGE_NEEDS_JOIN');
  });

  it('#194: the parallel copy calls the same helpers as the agent it copies', () => {
    let { draft, nodeId: helper } = ok(placeStep(chain(3), 'agent', { kind: 'empty' }));
    draft = patchNode(draft, helper, { invocation: 'callable' });
    for (const kind of ['delegate', 'question'] as const) {
      const linked = connectCapability(draft, 'agent_2', helper, kind);
      if (!linked.ok) throw new Error(linked.reason);
      draft = linked.draft;
    }
    const split = ok(applyPattern(draft, 'parallel', ['agent_2'])).draft;
    const copy = split.definition.nodes.find(
      (n) => n.type === 'agent' && !['agent_1', 'agent_2', 'agent_3', helper].includes(n.id),
    );
    const calls = (source: string | undefined) =>
      split.definition.capabilityLinks
        .filter((l) => l.sourceNodeId === source)
        .map((l) => `${l.kind}>${l.targetNodeId}`)
        .sort();
    expect(calls(copy?.id)).toEqual([`delegate>${helper}`, `question>${helper}`]);
    expect(calls('agent_2')).toEqual([`delegate>${helper}`, `question>${helper}`]);
    expect(split.definition.capabilityLinks).toHaveLength(4);
    expect(new Set(split.definition.capabilityLinks.map((l) => l.id)).size).toBe(4);
    expect(codes(split)).toEqual(codes(draft));
  });

  it('refuses to split a step nothing leads to, or more than one step', () => {
    expect(refused(applyPattern(chain(2), 'parallel', ['agent_1']))).toBe('noPredecessor');
    expect(refused(applyPattern(chain(3), 'parallel', ['agent_2', 'agent_3']))).toBe(
      'oneAgentOnly',
    );
  });
});

// Advisors (docs/specs/features/canvas.md rules 3, 4, 5 and 11; team-graph.md rule 11). Until
// advisors run the compiler refuses every one with ADVISOR_NOT_SUPPORTED; that gate is left out
// here, so these hold with it and without it.
const advisorCodes = (draft: EditorDraft) =>
  codes(draft).filter(
    (code) =>
      (code.startsWith('ADVIS') || code.startsWith('SCHEMA')) && code !== 'ADVISOR_NOT_SUPPORTED',
  );
const advises = (draft: EditorDraft) =>
  draft.definition.capabilityLinks
    .map((l) => `${l.kind}:${l.sourceNodeId}>${l.targetNodeId}`)
    .sort();
const roleFor = (draft: EditorDraft, id: string) => {
  const n = node(draft, id);
  return n?.type === 'agent' ? draft.definition.roles.find((r) => r.id === n.roleId) : undefined;
};
const READ_TOOLS = ['search', 'read_document', 'list_files', 'read_file'];

describe('team editor commands: advisors', () => {
  it('adds an advisor that watches the selected agent and stays out of the flow', () => {
    const draft = chain(2);
    const { draft: next, nodeId } = ok(
      placeStep(draft, 'observer', { kind: 'after', nodeId: 'agent_1' }),
    );
    const advisor = node(next, nodeId);
    expect(advisor).toMatchObject({ type: 'agent', invocation: 'observer' });
    expect(advisor?.parentId).toBeUndefined();
    expect(wiring(next)).toEqual(wiring(draft));
    expect(next.definition.entryNodeId).toBe('agent_1');
    expect(advises(next)).toEqual([`advise:${nodeId}>agent_1`]);
    const role = roleFor(next, nodeId);
    expect(role?.allowedWorkTools.every((tool) => READ_TOOLS.includes(tool))).toBe(true);
    expect([...(role?.allowedCollaborationTools ?? [])].sort()).toEqual([
      'advise',
      'read_artifact',
    ]);
    // Its own role: no other node runs it.
    expect(
      next.definition.nodes.filter((n) => n.type === 'agent' && n.roleId === role?.id),
    ).toHaveLength(1);
    expect(advisorCodes(next)).toEqual([]);
  });

  it('adds an advisor watching nobody when nothing is selected', () => {
    const { draft, nodeId } = ok(placeStep(chain(2), 'observer', { kind: 'empty' }));
    expect(node(draft, nodeId)).toMatchObject({ invocation: 'observer' });
    expect(advises(draft)).toEqual([]);
    expect(advisorCodes(draft)).toEqual(['ADVISOR_UNWATCHED']);
  });

  it('watches the agent it is dropped on, a callable one too, and nothing else', () => {
    const callable = patchNode(chain(1), 'agent_1', { invocation: 'callable' });
    const onCallable = ok(placeStep(callable, 'observer', { kind: 'after', nodeId: 'agent_1' }));
    expect(advises(onCallable.draft)).toEqual([`advise:${onCallable.nodeId}>agent_1`]);
    const output = ok(placeStep(chain(1), 'output', { kind: 'after', nodeId: 'agent_1' }));
    const onOutput = ok(
      placeStep(output.draft, 'observer', { kind: 'after', nodeId: output.nodeId }),
    );
    expect(advises(onOutput.draft)).toEqual([]);
    expect(wiring(onOutput.draft)).toEqual(wiring(output.draft));
  });

  it('is never inserted into the flow, on a connection or into a box', () => {
    const draft = chain(2);
    const edgeId = draft.definition.controlEdges[0]?.id as string;
    const onEdge = ok(placeStep(draft, 'observer', { kind: 'edge', edgeId }));
    expect(wiring(onEdge.draft)).toEqual(wiring(draft));
    expect(advises(onEdge.draft)).toEqual([]);
    const boxed = ok(wrapIn(draft, ['agent_2'], 'loop'));
    const into = ok(placeStep(boxed.draft, 'observer', { kind: 'into', boxId: boxed.nodeId }));
    expect(node(into.draft, into.nodeId)?.parentId).toBeUndefined();
    expect(wiring(into.draft)).toEqual(wiring(boxed.draft));
  });

  it('adds and removes watched agents', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const advisor = added.nodeId;
    const both = ok(watchAgent(added.draft, advisor, 'agent_2')).draft;
    expect(advises(both)).toEqual([`advise:${advisor}>agent_1`, `advise:${advisor}>agent_2`]);
    expect(refused(watchAgent(both, advisor, 'agent_2'))).toBe('duplicate');
    const output = ok(placeStep(both, 'output', { kind: 'after', nodeId: 'agent_2' }));
    expect(refused(watchAgent(output.draft, advisor, output.nodeId))).toBe('watchNeedsAgent');
    const other = ok(placeStep(both, 'observer', { kind: 'empty' }));
    expect(refused(watchAgent(other.draft, advisor, other.nodeId))).toBe('watchNeedsAgent');
    expect(refused(watchAgent(both, 'agent_1', 'agent_2'))).toBe('watchNeedsAdvisor');
    const link = both.definition.capabilityLinks.find((l) => l.targetNodeId === 'agent_1');
    const one = removeItems(both, [link?.id as string]);
    expect(advises(one)).toEqual([`advise:${advisor}>agent_2`]);
    expect(advisorCodes(one)).toEqual([]);
  });

  it('never delegates or asks, and is never delegated to or asked', () => {
    let draft = ok(placeStep(chain(1), 'agent', { kind: 'empty' })).draft;
    draft = patchNode(draft, 'agent_2', { invocation: 'callable' });
    const added = ok(placeStep(draft, 'observer', { kind: 'after', nodeId: 'agent_1' }));
    for (const kind of ['delegate', 'question'] as const) {
      const from = connectCapability(added.draft, added.nodeId, 'agent_2', kind);
      expect(from.ok ? 'accepted' : from.reason).toBe('sourceIsAdvisor');
      const to = connectCapability(added.draft, 'agent_1', added.nodeId, kind);
      expect(to.ok ? 'accepted' : to.reason).toBe('targetNotCallable');
    }
  });

  it('stays out of boxes; in a mixed selection only the advisor stays outside', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const advisor = added.nodeId;
    expect(refused(wrapIn(added.draft, [advisor], 'loop'))).toBe('advisorOutsideBoxes');
    expect(refused(wrapIn(added.draft, [advisor], 'team'))).toBe('advisorOutsideBoxes');
    const { draft, nodeId: loop } = ok(wrapIn(added.draft, ['agent_1', advisor], 'loop'));
    expect(node(draft, 'agent_1')?.parentId).toBe(loop);
    expect(node(draft, advisor)?.parentId).toBeUndefined();
    expect(advises(draft)).toEqual([`advise:${advisor}>agent_1`]);
    expect(refused(setParent(draft, advisor, loop))).toBe('advisorOutsideBoxes');
    expect(advisorCodes(draft)).toEqual([]);
    const pattern = ok(applyPattern(added.draft, 'reviewLoop', ['agent_1', advisor]));
    expect(node(pattern.draft, advisor)?.parentId).toBeUndefined();
    expect(refused(applyPattern(added.draft, 'reviewLoop', [advisor]))).toBe('advisorOutsideBoxes');
  });

  it('becomes an advisor in one undoable edit that takes it out of the flow', () => {
    // agent_1 → Loop[agent_2] → agent_3; agent_2 retries, reads the brief and delegates to a
    // helper; agent_3 runs the same role.
    let draft = ok(wrapIn(chain(3), ['agent_2'], 'loop')).draft;
    draft = ok(placeStep(draft, 'agent', { kind: 'empty' })).draft;
    const helper = draft.definition.nodes.at(-1)?.id as string;
    draft = patchNode(draft, helper, { invocation: 'callable' });
    const linked = connectCapability(draft, 'agent_2', helper, 'delegate');
    if (!linked.ok) throw new Error(linked.reason);
    draft = patchNode(linked.draft, 'agent_2', { retry: { maxAttempts: 2 } });
    const shared = roleFor(draft, 'agent_2');
    draft = patchNode(draft, 'agent_3', { roleId: shared?.id });
    const store = createEditorStore(draft);
    store.getState().updateNode('agent_2', { invocation: 'observer' });
    const next = store.getState().draft;
    const advisor = node(next, 'agent_2');
    expect(advisor).toMatchObject({ type: 'agent', invocation: 'observer' });
    expect(advisor).not.toHaveProperty('inputBindings');
    expect(advisor).not.toHaveProperty('retry');
    expect(advisor).not.toHaveProperty('parentId');
    expect(
      next.definition.controlEdges.filter((e) => e.source === 'agent_2' || e.target === 'agent_2'),
    ).toEqual([]);
    expect(advises(next).filter((l) => l.includes('agent_2'))).toEqual([]);
    // The advisor runs a copy with only advisor tools; agent_3 keeps the role it had.
    const copy = roleFor(next, 'agent_2');
    expect(copy?.id).not.toBe(shared?.id);
    expect(copy?.prompt).toBe(shared?.prompt);
    expect(copy?.allowedWorkTools.every((tool) => READ_TOOLS.includes(tool))).toBe(true);
    expect([...(copy?.allowedCollaborationTools ?? [])].sort()).toEqual([
      'advise',
      'read_artifact',
    ]);
    expect(roleFor(next, 'agent_3')).toEqual(shared);
    expect(advisorCodes(next)).not.toContain('ADVISOR_TOOLS');
    expect(advisorCodes(next)).not.toContain('ADVISOR_OUTSIDE_FLOW');
    store.getState().undo();
    expect(store.getState().draft.definition).toEqual(draft.definition);
  });

  it('stops watching when it runs in the flow or when called, in one undoable edit', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    for (const invocation of ['scheduled', 'callable'] as const) {
      const store = createEditorStore(added.draft);
      store.getState().updateNode(added.nodeId, { invocation });
      const next = store.getState().draft;
      expect(node(next, added.nodeId)).toMatchObject({ invocation });
      expect(advises(next)).toEqual([]);
      expect(roleFor(next, added.nodeId)?.allowedCollaborationTools).not.toContain('advise');
      expect(advisorCodes(next)).toEqual([]);
      store.getState().undo();
      expect(store.getState().draft.definition).toEqual(added.draft.definition);
    }
  });

  it('keeps watching a callable agent that is put back in the flow', () => {
    const callable = patchNode(chain(1), 'agent_1', { invocation: 'callable' });
    const added = ok(placeStep(callable, 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const store = createEditorStore(added.draft);
    store.getState().updateNode('agent_1', { invocation: 'scheduled' });
    expect(advises(store.getState().draft)).toEqual([`advise:${added.nodeId}>agent_1`]);
  });

  it('stays, watching no one, when the agent it watched is deleted', () => {
    const added = ok(placeStep(chain(3), 'observer', { kind: 'after', nodeId: 'agent_3' }));
    const next = removeItems(added.draft, ['agent_3']);
    expect(node(next, added.nodeId)).toBeDefined();
    expect(advises(next)).toEqual([]);
    expect(advisorCodes(next)).toEqual(['ADVISOR_UNWATCHED']);
  });

  it('takes no role copied from a working agent', () => {
    const added = ok(placeStep(chain(1), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const role = roleFor(added.draft, 'agent_1') as AgentRole;
    expect(refused(importRole(added.draft, role, [added.nodeId]) as EditResult)).toBe(
      'roleNeedsAgent',
    );
  });

  // Review round 2 (canvas.md rules 6 and 11).
  it('copies no advisor role onto an agent, and lists none to copy', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const advisorRole = roleFor(added.draft, added.nodeId) as AgentRole;
    expect(refused(importRole(added.draft, advisorRole, ['agent_2']) as EditResult)).toBe(
      'advisorRole',
    );
    expect(refused(importRole(added.draft, advisorRole, []) as EditResult)).toBe('advisorRole');
    expect(importableRoles(added.draft.definition).map((r) => r.id)).toEqual([
      'agent_1_role',
      'agent_2_role',
    ]);
    // A role an advisor runs is left out even when it lost its advise tool.
    const stripped = updateNode(added.draft, added.nodeId, {});
    const bare = {
      ...stripped.definition,
      roles: stripped.definition.roles.map((r) =>
        r.id === advisorRole.id ? { ...r, allowedCollaborationTools: [] } : r,
      ),
    };
    expect(importableRoles(bare).map((r) => r.id)).not.toContain(advisorRole.id);
  });

  it('gives a converted advisor the role shape of a new one, keeping prompt, model, reasoning and reads', () => {
    let draft = updateNode(chain(2), 'agent_2', {
      prompt: 'Check the facts.',
      modelProfile: 'model-b',
      reasoning: { mode: 'fixed', level: 'high' },
      outputContract: 'review',
      editingMode: 'hashline',
      generateImage: true,
      imageProfile: 'pictures',
      harness: { profileId: 'design', revision: 1 },
    });
    draft = patchNode(draft, 'agent_2', {});
    const role = roleFor(draft, 'agent_2') as AgentRole;
    draft = {
      ...draft,
      definition: {
        ...draft.definition,
        roles: draft.definition.roles.map((r) =>
          r.id === role.id
            ? {
                ...r,
                allowedWorkTools: [...r.allowedWorkTools, 'read_file'],
                answer: 'final_reply',
              }
            : r,
        ),
      },
    };
    const store = createEditorStore(draft);
    store.getState().updateNode('agent_2', { invocation: 'observer' });
    const converted = roleFor(store.getState().draft, 'agent_2') as AgentRole;
    const fresh = roleFor(
      ok(placeStep(chain(2), 'observer', { kind: 'empty' })).draft,
      'advisor_1',
    ) as AgentRole;
    expect(Object.keys(converted).sort()).toEqual([...Object.keys(fresh), 'reasoning'].sort());
    expect(converted).toMatchObject({
      prompt: 'Check the facts.',
      modelProfile: 'model-b',
      reasoning: { mode: 'fixed', level: 'high' },
      outputContract: fresh.outputContract,
      allowedWorkTools: ['read_file'],
      allowedCollaborationTools: fresh.allowedCollaborationTools,
    });
    store.getState().undo();
    expect(store.getState().draft.definition).toEqual(draft.definition);
  });

  it('moves the start off an agent that becomes an advisor, as deleting it would', () => {
    const draft = chain(3);
    expect(draft.definition.entryNodeId).toBe('agent_1');
    const converted = updateNode(draft, 'agent_1', { invocation: 'observer' });
    expect(converted.definition.entryNodeId).toBe(
      removeItems(draft, ['agent_1']).definition.entryNodeId,
    );
    expect(converted.definition.entryNodeId).toBe('agent_2');
    // With nowhere else to start, the advisor is still not the start.
    const alone = updateNode(chain(1), 'agent_1', { invocation: 'observer' });
    expect(alone.definition.entryNodeId).not.toBe('agent_1');
  });

  it('takes no change an advisor sheet does not offer', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const before = roleFor(added.draft, added.nodeId);
    const next = updateNode(added.draft, added.nodeId, {
      teamPlanOwner: true,
      fileTools: true,
      runCommand: true,
      generateImage: true,
      previewFile: true,
      outputContract: 'review',
      editingMode: 'hashline',
      imageProfile: 'pictures',
    });
    expect(roleFor(next, added.nodeId)).toEqual(before);
    expect(next.definition.planOwnerRoleId).toBe(added.draft.definition.planOwnerRoleId);
    expect(advisorCodes(next)).toEqual([]);
    // What the sheet offers still applies.
    const named = updateNode(added.draft, added.nodeId, { prompt: 'Look closer.' });
    expect(roleFor(named, added.nodeId)?.prompt).toBe('Look closer.');
  });

  it('a split agent keeps its advisors: the copy is watched by the same ones', () => {
    let draft = chain(3);
    const first = ok(placeStep(draft, 'observer', { kind: 'after', nodeId: 'agent_2' }));
    const second = ok(placeStep(first.draft, 'observer', { kind: 'after', nodeId: 'agent_2' }));
    draft = second.draft;
    const split = ok(applyPattern(draft, 'parallel', ['agent_2'])).draft;
    const copy = split.definition.nodes.find((n) => n.label === 'Agent 2 copy')?.id as string;
    expect(advises(split)).toEqual(
      [
        `advise:${first.nodeId}>agent_2`,
        `advise:${first.nodeId}>${copy}`,
        `advise:${second.nodeId}>agent_2`,
        `advise:${second.nodeId}>${copy}`,
      ].sort(),
    );
    expect(advisorCodes(split)).toEqual([]);
  });

  it('becoming an advisor drops the links into it too', () => {
    let draft = ok(placeStep(chain(2), 'agent', { kind: 'empty' })).draft;
    draft = patchNode(draft, 'agent_3', { invocation: 'callable' });
    const linked = connectCapability(draft, 'agent_1', 'agent_3', 'delegate');
    if (!linked.ok) throw new Error(linked.reason);
    draft = ok(placeStep(linked.draft, 'observer', { kind: 'after', nodeId: 'agent_3' })).draft;
    const next = updateNode(draft, 'agent_3', { invocation: 'observer' });
    expect(next.definition.capabilityLinks.filter((l) => l.targetNodeId === 'agent_3')).toEqual([]);
  });

  it('back from an advisor, an agent reads the brief and gets a new agent’s tools', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const fresh = roleFor(chain(1), 'agent_1') as AgentRole;
    const back = updateNode(added.draft, added.nodeId, { invocation: 'scheduled' });
    const node = back.definition.nodes.find((n) => n.id === added.nodeId);
    expect(node?.type === 'agent' && node.invocation !== 'observer' && node.inputBindings).toEqual([
      { kind: 'run_input', name: 'brief' },
    ]);
    const role = roleFor(back, added.nodeId) as AgentRole;
    for (const tool of fresh.allowedWorkTools) expect(role.allowedWorkTools).toContain(tool);
    for (const tool of fresh.allowedCollaborationTools)
      expect(role.allowedCollaborationTools).toContain(tool);
  });

  it('an agent that becomes an advisor gives up the team plan', () => {
    const owner = updateNode(chain(2), 'agent_2', { teamPlanOwner: true });
    expect(owner.definition.planOwnerRoleId).toBe('agent_2_role');
    const advisor = updateNode(owner, 'agent_2', { invocation: 'observer' });
    expect(advisor.definition.planOwnerRoleId).toBeUndefined();
  });

  it('changes read tools on an advisor only', () => {
    const draft = chain(2);
    const next = updateNode(draft, 'agent_1', { readTools: ['search'] });
    expect(roleFor(next, 'agent_1')).toEqual(roleFor(draft, 'agent_1'));
  });
});

describe('team editor commands: reference teams', () => {
  it('adds another saved team as a reference at its saved revision', () => {
    const { draft, nodeId } = ok(
      placeStep(
        chain(1),
        'team',
        { kind: 'after', nodeId: 'agent_1' },
        {
          reference: { corralId: 'other_team', definitionRevision: 4, name: 'Other team' },
        },
      ),
    );
    const team = node(draft, nodeId);
    expect(team?.type === 'team' ? team.source : null).toEqual({
      kind: 'reference',
      corralId: 'other_team',
      definitionRevision: 4,
    });
    expect(team?.label).toBe('Other team');
    expect(wiring(draft)).toEqual([`agent_1.out>${nodeId}.enter`]);
    expect(refused(placeStep(draft, 'agent', { kind: 'into', boxId: nodeId }))).toBe('notABox');
  });
});
