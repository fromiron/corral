import { describe, expect, it } from 'vitest';
import { connectCapability, type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import {
  connectPorts,
  type EditResult,
  patchNode,
  placeStep,
  wrapIn,
} from '../src/team-editor/commands.ts';
import { GEOMETRY, layoutTeam, type Rect } from '../src/team-editor/layout.ts';

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}
function chain(length: number): EditorDraft {
  let { draft, nodeId } = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  for (let i = 1; i < length; i++)
    ({ draft, nodeId } = ok(placeStep(draft, 'agent', { kind: 'after', nodeId })));
  return draft;
}
const layout = (draft: EditorDraft, collapsed?: Set<string>) =>
  layoutTeam(draft.definition, collapsed);
const rect = (l: ReturnType<typeof layoutTeam>, id: string) => {
  const item = l.items.get(id);
  if (!item) throw new Error(`${id} was not laid out`);
  return item.rect;
};
const inside = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('team editor layout', () => {
  it('keeps a chain on one line from left to right', () => {
    const l = layout(chain(3));
    const [a, b, c] = ['agent_1', 'agent_2', 'agent_3'].map((id) => rect(l, id)) as Rect[];
    expect(new Set([a?.y, b?.y, c?.y]).size).toBe(1);
    expect((a as Rect).x + (a as Rect).w).toBeLessThan((b as Rect).x);
    expect((b as Rect).x + (b as Rect).w).toBeLessThan((c as Rect).x);
    expect(l.edges.map((e) => e.path).every((p) => !p.includes('V'))).toBe(true);
  });

  it('stacks the branches of a fan-out in one column below the main line', () => {
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
    const l = layout(draft);
    expect(rect(l, 'agent_3').x).toBe(rect(l, 'agent_2').x);
    expect(rect(l, 'agent_2').y).toBe(rect(l, 'agent_1').y);
    expect(rect(l, 'agent_3').y).toBeGreaterThanOrEqual(
      rect(l, 'agent_2').y + rect(l, 'agent_2').h + GEOMETRY.gapY,
    );
  });

  it("keeps a decision's branches in port order", () => {
    const draft = chain(1);
    const review = ok(placeStep(draft, 'review', { kind: 'after', nodeId: 'agent_1' }));
    const pass = ok(placeStep(review.draft, 'agent', { kind: 'after', nodeId: review.nodeId }));
    let next = ok(placeStep(pass.draft, 'agent', { kind: 'empty' }));
    next = ok(
      connectPorts(next.draft, {
        source: review.nodeId,
        sourcePort: 'revise',
        target: next.nodeId,
        targetPort: 'in',
      }),
    );
    // Created second but connected to the second port, so it sits below the `pass` branch.
    const l = layout(next.draft);
    expect(rect(l, pass.nodeId).y).toBeLessThan(rect(l, 'agent_3').y);
  });

  it('draws boxes around their members, nested boxes inside the outer one, and nothing overlapping', () => {
    const { draft, nodeId: outer } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    const { draft: nested, nodeId: inner } = ok(wrapIn(draft, ['agent_2'], 'team'));
    const l = layout(nested);
    expect(l.items.get(outer)?.kind).toBe('box');
    expect(inside(rect(l, outer), rect(l, inner))).toBe(true);
    expect(inside(rect(l, inner), rect(l, 'agent_2'))).toBe(true);
    expect(l.items.get(inner)?.depth).toBe(1);
    expect(overlap(rect(l, outer), rect(l, 'agent_1'))).toBe(false);
    expect(overlap(rect(l, outer), rect(l, 'agent_3'))).toBe(false);
    // The main line runs straight through: agent_1, the boxes and agent_3 share it.
    const main = l.items.get('agent_1')?.mainY;
    expect(l.items.get(outer)?.mainY).toBe(main);
    expect(l.items.get('agent_2')?.mainY).toBe(main);
    expect(l.items.get('agent_3')?.mainY).toBe(main);
  });

  it('shows a collapsed box as one tile and draws its connections to the tile', () => {
    const { draft, nodeId: loop } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    const l = layout(draft, new Set([loop]));
    expect(l.items.get(loop)?.kind).toBe('tile');
    expect(l.items.has('agent_2')).toBe(false);
    expect(rect(l, loop).w).toBe(GEOMETRY.tile.w);
    const ends = l.edges.map((e) => `${e.from}>${e.to}`).sort();
    // Its next and exhausted connections both lead to agent_3.
    expect(ends).toEqual([`agent_1>${loop}`, `${loop}>agent_3`, `${loop}>agent_3`]);
  });

  it('puts callable agents in a row under the flow', () => {
    let draft = chain(2);
    draft = ok(placeStep(draft, 'agent', { kind: 'empty' })).draft;
    draft = patchNode(draft, 'agent_3', { invocation: 'callable' });
    const l = layout(draft);
    const flowBottom = Math.max(
      ...['agent_1', 'agent_2'].map((id) => rect(l, id).y + rect(l, id).h),
    );
    expect(rect(l, 'agent_3').y).toBeGreaterThanOrEqual(flowBottom + GEOMETRY.callGap);
  });

  it('draws a round-again connection along the bottom of its loop and offers no drop on it', () => {
    const { draft, nodeId: loop } = ok(placeStep(emptyDraft(), 'loop', { kind: 'empty' }));
    const agent = ok(placeStep(draft, 'agent', { kind: 'into', boxId: loop }));
    const review = ok(placeStep(agent.draft, 'review', { kind: 'after', nodeId: agent.nodeId }));
    const done = ok(
      connectPorts(review.draft, {
        source: review.nodeId,
        sourcePort: 'revise',
        target: loop,
        targetPort: 'repeat',
      }),
    );
    const l = layout(done.draft);
    const repeat = done.draft.definition.controlEdges.find((e) => e.targetPort === 'repeat');
    const drawn = l.edges.find((e) => e.id === repeat?.id);
    expect(drawn?.insertAt).toBeNull();
    expect(drawn?.arrow).toBe(false);
    const box = rect(l, loop);
    expect(drawn?.path).toContain(`${box.y + box.h - 18}`);
  });
});

describe('team editor layout: reference teams', () => {
  it('draws a reference team as a tile: its steps live in the other team', () => {
    const { draft, nodeId } = ok(
      placeStep(
        chain(1),
        'team',
        { kind: 'after', nodeId: 'agent_1' },
        {
          reference: { corralId: 'other_team', definitionRevision: 2, name: 'Other team' },
        },
      ),
    );
    const l = layout(draft);
    expect(l.items.get(nodeId)?.kind).toBe('tile');
    expect(l.ports.some((p) => p.nodeId === nodeId && p.port === 'enter')).toBe(true);
    expect(l.ports.some((p) => p.nodeId === nodeId && p.port === 'body')).toBe(false);
  });
});

// Advisors sit in one row above the flow, in the order of the agents they watch
// (docs/specs/features/canvas.md rules 2 and 4).
describe('team editor layout: advisors', () => {
  const watching = (draft: EditorDraft, agent: string) =>
    ok(placeStep(draft, 'observer', { kind: 'after', nodeId: agent }));

  it('puts advisors in one row above the flow, in the order of the agents they watch', () => {
    const base = chain(3);
    const late = watching(base, 'agent_3');
    const early = watching(late.draft, 'agent_1');
    const before = layout(base);
    const l = layout(early.draft);
    const flowTop = Math.min(...['agent_1', 'agent_2', 'agent_3'].map((id) => rect(l, id).y));
    const [a, b] = [rect(l, early.nodeId), rect(l, late.nodeId)] as [Rect, Rect];
    expect(a.y).toBe(b.y);
    expect(a.y + a.h).toBeLessThan(flowTop);
    expect(a.x + a.w).toBeLessThanOrEqual(b.x);
    expect(a.x).toBe(rect(l, 'agent_1').x);
    // The flow does not move for them.
    for (const id of ['agent_1', 'agent_2', 'agent_3'])
      expect(rect(l, id)).toEqual(rect(before, id));
    expect(overlap(a, b)).toBe(false);
  });

  it('moves nothing else: no step, box or callable agent', () => {
    let base = ok(wrapIn(chain(3), ['agent_2'], 'loop')).draft;
    base = ok(placeStep(base, 'agent', { kind: 'empty' })).draft;
    base = patchNode(base, 'agent_4', { invocation: 'callable' });
    const before = layout(base);
    const after = layout(watching(base, 'agent_2').draft);
    for (const [id, item] of before.items) expect(rect(after, id)).toEqual(item.rect);
  });

  it('gives an advisor no ports and draws its watch as an unnamed advise connection', () => {
    const { draft, nodeId } = watching(chain(2), 'agent_2');
    const l = layout(draft);
    expect(l.ports.filter((p) => p.nodeId === nodeId)).toEqual([]);
    const drawn = l.edges.filter((e) => e.from === nodeId);
    expect(drawn.map((e) => [e.kind, e.to, e.label, e.insertAt])).toEqual([
      ['advise', 'agent_2', undefined, null],
    ]);
    // From the middle of the advisor's bottom to the middle of the agent's top.
    const a = rect(l, nodeId);
    const b = rect(l, 'agent_2');
    const path = drawn[0]?.path ?? '';
    expect(path.startsWith(`M${a.x + a.w / 2} ${a.y + a.h} `)).toBe(true);
    expect(path.endsWith(` ${b.x + b.w / 2} ${b.y}`)).toBe(true);
  });

  it('sits each advisor over the agent it watches, without overlapping another', () => {
    const one = watching(chain(3), 'agent_3');
    const two = watching(one.draft, 'agent_3');
    const l = layout(two.draft);
    expect(rect(l, one.nodeId).x).toBe(rect(l, 'agent_3').x);
    expect(rect(l, two.nodeId).y).toBe(rect(l, one.nodeId).y);
    expect(overlap(rect(l, one.nodeId), rect(l, two.nodeId))).toBe(false);
  });

  it('keeps the callable row where its callers put it, whatever advisors watch it', () => {
    let base = ok(placeStep(chain(3), 'agent', { kind: 'empty' })).draft;
    base = patchNode(base, 'agent_4', { invocation: 'callable' });
    // The advisor watches first, then agent_3 delegates: the watch comes first in the links.
    const watched = watching(base, 'agent_4');
    const call = (d: EditorDraft) => {
      const linked = connectCapability(d, 'agent_3', 'agent_4', 'delegate');
      if (!linked.ok) throw new Error(linked.reason);
      return linked.draft;
    };
    const without = layout(call(base));
    const withAdvisor = layout(call(watched.draft));
    expect(rect(withAdvisor, 'agent_4')).toEqual(rect(without, 'agent_4'));
    expect(rect(without, 'agent_4').x).toBe(rect(without, 'agent_3').x);
  });

  it('draws the watch of an agent inside a collapsed box to the box tile', () => {
    const { draft: boxed, nodeId: loop } = ok(wrapIn(chain(3), ['agent_2'], 'loop'));
    const { draft, nodeId } = watching(boxed, 'agent_2');
    const l = layout(draft, new Set([loop]));
    expect(l.items.get(loop)?.kind).toBe('tile');
    expect(l.edges.find((e) => e.from === nodeId)?.to).toBe(loop);
    expect(rect(l, nodeId).y + rect(l, nodeId).h).toBeLessThan(rect(l, loop).y);
    expect(rect(l, nodeId).x).toBe(rect(l, loop).x);
  });
});
