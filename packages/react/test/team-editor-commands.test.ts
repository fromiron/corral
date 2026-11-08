import { compileDefinition } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import {
  connectPorts,
  type EditResult,
  patchNode,
  placeStep,
  removeItems,
  type StepKind,
  setParent,
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
      ].sort(),
    );
    expect(codes(nested)).not.toContain('BOX_BOUNDARY');
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
