import { describe, expect, it } from 'vitest';
import type {
  RunAgentGraph,
  RunAgentGraphNode,
  RunAgentGraphRelation,
} from '../src/run/agent-graph.ts';
import {
  type AgentGraphPosition,
  crossesRect,
  type LayoutWork,
  labelRect,
  layoutRunAgents,
  markRect,
  TILE,
} from '../src/run/agent-graph-layout.ts';
import { routeRelation } from '../src/run/agent-graph-routes.ts';

function node(id: string, lead = false): RunAgentGraphNode {
  return {
    id,
    label: id,
    executionIds: [`execution_${id}`],
    summary: { status: 'done', counts: { done: 1 }, previousFailures: 0 },
    lead,
  };
}

function relation(source: string, target: string): RunAgentGraphRelation {
  return {
    id: `${source}-${target}`,
    source,
    target,
    kind: 'delegate',
    count: 1,
    activeCount: 0,
    failedCount: 0,
    executionIds: [`execution_${source}`, `execution_${target}`],
    artifactVersionIds: [],
  };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function graphOf(leads: string[], others: string[], pairs: [string, string][]): RunAgentGraph {
  return {
    nodes: [...leads.map((id) => node(id, true)), ...others.map((id) => node(id))],
    relations: pairs.map(([source, target]) => relation(source, target)),
  };
}

/** Every drawn line, as the stage routes it. */
function routes(graph: RunAgentGraph, positions: Map<string, AgentGraphPosition>) {
  const leads = new Set(graph.nodes.filter((n) => n.lead).map((n) => n.id));
  const pairs = new Set(graph.relations.map((r) => JSON.stringify([r.source, r.target])));
  return [...pairs].map((key) => {
    const [source, target] = JSON.parse(key) as [string, string];
    const route = routeRelation({
      source,
      target,
      from: positions.get(source) as AgentGraphPosition,
      to: positions.get(target) as AgentGraphPosition,
      leads,
      opposite: pairs.has(JSON.stringify([target, source])),
    });
    return { source, target, route };
  });
}

/** Lines that run over another agent's mark or label, or sideways through their own label. */
function collisions(graph: RunAgentGraph, positions: Map<string, AgentGraphPosition>) {
  const found: string[] = [];
  for (const { source, target, route } of routes(graph, positions)) {
    const points = route.points;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as AgentGraphPosition;
      const b = points[i] as AgentGraphPosition;
      for (const [id, at] of positions) {
        const ends = id === source || id === target;
        // A line leaving straight down from its own agent passes behind that agent's label.
        const stem = Math.abs(a.x - b.x) < 0.5 && Math.abs(a.x - at.x) <= 14;
        if (!ends && crossesRect(a, b, markRect(at))) found.push(`${source}>${target} mark ${id}`);
        if ((!ends || !stem) && crossesRect(a, b, labelRect(at)))
          found.push(`${source}>${target} label ${id}`);
      }
    }
  }
  return found;
}

/** Lines that run over the mark or label of an agent other than their own two. */
function overOthers(graph: RunAgentGraph, positions: Map<string, AgentGraphPosition>) {
  const found: string[] = [];
  for (const { source, target, route } of routes(graph, positions)) {
    const points = route.points;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as AgentGraphPosition;
      const b = points[i] as AgentGraphPosition;
      for (const [id, at] of positions) {
        if (id === source || id === target) continue;
        if (crossesRect(a, b, markRect(at))) found.push(`${source}>${target} mark ${id}`);
        if (crossesRect(a, b, labelRect(at))) found.push(`${source}>${target} label ${id}`);
      }
    }
  }
  return found;
}

/** Tiles (mark and label block) that touch. */
function touching(positions: Map<string, AgentGraphPosition>) {
  const found: string[] = [];
  const tile = (at: AgentGraphPosition) => ({
    x0: at.x - TILE.halfWidth,
    x1: at.x + TILE.halfWidth,
    y0: at.y - TILE.markHalf,
    y1: at.y + TILE.labelBottom,
  });
  const entries = [...positions];
  for (const [i, [a, at]] of entries.entries())
    for (const [b, bt] of entries.slice(i + 1)) {
      const one = tile(at);
      const other = tile(bt);
      if (one.x0 < other.x1 && other.x0 < one.x1 && one.y0 < other.y1 && other.y0 < one.y1)
        found.push(`${a}/${b}`);
    }
  return found;
}

describe('observed agent layout keeps lines off labels', () => {
  const cases: [string, RunAgentGraph][] = [
    [
      'two leads with a helper and a responder each',
      graphOf(
        ['research', 'write'],
        ['helper', 'responder'],
        [
          ['research', 'helper'],
          ['helper', 'research'],
          ['research', 'write'],
          ['write', 'responder'],
          ['responder', 'write'],
        ],
      ),
    ],
    [
      'a lead and eight delegates',
      graphOf(
        ['lead'],
        Array.from({ length: 8 }, (_, i) => `w${i}`),
        Array.from({ length: 8 }, (_, i) => ['lead', `w${i}`] as [string, string]),
      ),
    ],
    [
      'a lead, five delegates and their fifteen helpers',
      graphOf(
        ['lead'],
        Array.from({ length: 5 }, (_, i) => [
          `w${i}`,
          ...Array.from({ length: 3 }, (_, j) => `h${i}${j}`),
        ]).flat(),
        Array.from({ length: 5 }, (_, i) => [
          ['lead', `w${i}`] as [string, string],
          [`w${i}`, 'lead'] as [string, string],
          ...Array.from({ length: 3 }, (_, j) => [`w${i}`, `h${i}${j}`] as [string, string]),
        ]).flat(),
      ),
    ],
  ];

  it.each(cases)('%s: no line crosses a mark or a label, and no tiles touch', (_, graph) => {
    const positions = layoutRunAgents(graph);
    expect(positions.size).toBe(graph.nodes.length);
    expect(collisions(graph, positions)).toEqual([]);
    expect(touching(positions)).toEqual([]);
  });

  it('turns every line out of a lead once: its agents share neither its row nor its column', () => {
    const graph = cases[1]?.[1] as RunAgentGraph;
    const positions = layoutRunAgents(graph);
    const lead = positions.get('lead') as AgentGraphPosition;
    for (const [id, at] of positions) {
      if (id === 'lead') continue;
      expect(at.x).not.toBe(lead.x);
      expect(at.y).not.toBe(lead.y);
    }
    for (const { route } of routes(graph, positions)) expect(route.d).toMatch(/Q/);
  });

  it('keeps a growing run clear: agents that arrive later take free places', () => {
    const first = graphOf(
      ['lead'],
      ['a', 'b'],
      [
        ['lead', 'a'],
        ['lead', 'b'],
      ],
    );
    const before = layoutRunAgents(first);
    const grown = graphOf(
      ['lead'],
      ['a', 'b', 'c', 'd'],
      [
        ['lead', 'a'],
        ['lead', 'b'],
        ['lead', 'c'],
        ['b', 'd'],
      ],
    );
    const after = layoutRunAgents(grown, before);
    for (const id of ['lead', 'a', 'b']) expect(after.get(id)).toEqual(before.get(id));
    expect(collisions(grown, after)).toEqual([]);
    expect(touching(after)).toEqual([]);
  });
});

/** A lead that delegates to every agent, a chain through them, and a skip four back. */
function busyRun(count: number): RunAgentGraph {
  const agents = Array.from({ length: count }, (_, i) => `a${i}`);
  const back = (step: number) =>
    agents.slice(step).map((id, i) => [agents[i] as string, id] as [string, string]);
  return graphOf(['lead'], agents, [
    ...agents.map((id) => ['lead', id] as [string, string]),
    ...back(1),
    ...back(4),
  ]);
}

describe('a busy run lays out with bounded work', () => {
  const laid = new Map<number, { positions: Map<string, AgentGraphPosition>; work: LayoutWork }>();
  const layout = (count: number) => {
    const known = laid.get(count);
    if (known) return known;
    const work: LayoutWork = { evaluations: 0 };
    const result = { positions: layoutRunAgents(busyRun(count), new Map(), work), work };
    laid.set(count, result);
    return result;
  };

  // Places weighed, counted rather than timed so the bound holds on any machine.
  it.each([
    [20, 16_000],
    [40, 30_000],
    [80, 60_000],
    [150, 100_000],
  ])('%i agents weigh at most %i places', (count, most) => {
    const { positions, work } = layout(count);
    expect(positions.size).toBe(count + 1);
    expect(work.evaluations).toBeGreaterThan(0);
    expect(work.evaluations).toBeLessThanOrEqual(most);
  });

  it.each([40, 80])(
    '%i agents: no line crosses another agent, no tiles touch, lead lines elbow',
    (count) => {
      const { positions } = layout(count);
      expect(overOthers(busyRun(count), positions)).toEqual([]);
      expect(touching(positions)).toEqual([]);
      const lead = positions.get('lead') as AgentGraphPosition;
      for (const [id, at] of positions) {
        if (id === 'lead') continue;
        expect(at.x).not.toBe(lead.x);
        expect(at.y).not.toBe(lead.y);
      }
    },
  );

  it('lays the same run out the same way every time', () => {
    expect(layoutRunAgents(busyRun(40))).toEqual(layout(40).positions);
  });

  it('past its work limit, the agents left take clear places off the lead lines', () => {
    const work: LayoutWork = { evaluations: 0, limit: 1_000 };
    const positions = layoutRunAgents(busyRun(40), new Map(), work);
    expect(positions.size).toBe(41);
    expect(work.evaluations).toBeGreaterThan(0);
    expect(work.evaluations).toBeLessThanOrEqual(1_000);
    expect(touching(positions)).toEqual([]);
    const lead = positions.get('lead') as AgentGraphPosition;
    for (const [id, at] of positions) {
      if (id === 'lead') continue;
      expect(at.x).not.toBe(lead.x);
      expect(at.y).not.toBe(lead.y);
    }
  });
});

describe('observed agent layout', () => {
  it('places connected agents together rather than using the authoring graph', () => {
    const graph: RunAgentGraph = {
      nodes: [node('root', true), node('helper'), node('unrelated')],
      relations: [relation('root', 'helper')],
    };
    const positions = layoutRunAgents(graph);
    const root = positions.get('root');
    const helper = positions.get('helper');
    const unrelated = positions.get('unrelated');
    expect(root && helper && unrelated).toBeTruthy();
    if (!root || !helper || !unrelated) throw new Error('Missing agent position');
    expect(distance(root, helper)).toBeLessThan(distance(root, unrelated));
  });

  it('preserves existing positions when statuses change and a connected agent arrives', () => {
    const initial: RunAgentGraph = {
      nodes: [node('root', true), node('helper')],
      relations: [relation('root', 'helper')],
    };
    const positions = layoutRunAgents(initial);
    const next: RunAgentGraph = {
      nodes: [
        {
          ...node('root', true),
          summary: { status: 'active', counts: { active: 1 }, previousFailures: 0 },
        },
        node('helper'),
        node('newcomer'),
      ],
      relations: [...initial.relations, relation('helper', 'newcomer')],
    };
    const updated = layoutRunAgents(next, positions);
    expect(updated.get('root')).toEqual(positions.get('root'));
    expect(updated.get('helper')).toEqual(positions.get('helper'));
    const newcomer = updated.get('newcomer');
    expect(newcomer).toBeDefined();
    expect([...positions.values()]).not.toContainEqual(newcomer);
  });
});
