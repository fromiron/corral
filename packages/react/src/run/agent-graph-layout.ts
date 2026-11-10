import type { RunAgentGraph } from './agent-graph.ts';
import { type AgentGraphRoute, routeRelation, type StageRect } from './agent-graph-routes.ts';

export interface AgentGraphPosition {
  x: number;
  y: number;
}

type Point = AgentGraphPosition;

/**
 * What an AgentGraphNode covers around its mark's centre: a 160px column with the mark in a 56px
 * box and, under it, the label block (name, model, state, execution count).
 */
export const TILE = { halfWidth: 80, markHalf: 28, labelTop: 32, labelBottom: 110 } as const;

/**
 * The stage's pitch. A column is a tile plus the channel edges run in; a row is a tile plus the
 * gap that keeps the next row's marks clear of this row's labels. Agents also sit on half
 * columns, so one that works with two neighbours can stand between them a row away.
 */
export const PITCH = { x: 200, y: 180 } as const;

/** The stage's landscape shape; placement prefers arrangements that fit it large. */
const ASPECT = 1.6;
/** Tiles keep at least this much air between them. */
const GAP = 20;
/** A line this close to an agent's centre and running straight down is its stem. */
const STEM = 14;
/** How many rows further out placement looks for a place that keeps lines off other agents. */
const WIDEN_LIMIT = 4;

/**
 * What a placement costs. Lines through another agent's mark or label, or sideways through an
 * agent's own label, are what the layout exists to avoid; a stem down behind an agent's own
 * label reads as a line from the tile's edge and costs almost nothing.
 */
const COST = {
  mark: 100,
  label: 100,
  ownLabel: 60,
  overlap: 40,
  sharedOverlap: 8,
  crossing: 3,
  stem: 0.25,
  area: 1,
  distance: 1,
  flow: 0.1,
  side: 0.01,
  trunk: 5,
} as const;

export const markRect = (at: Point): StageRect => ({
  x0: at.x - TILE.markHalf,
  x1: at.x + TILE.markHalf,
  y0: at.y - TILE.markHalf,
  y1: at.y + TILE.markHalf,
});

export const labelRect = (at: Point): StageRect => ({
  x0: at.x - TILE.halfWidth,
  x1: at.x + TILE.halfWidth,
  y0: at.y + TILE.labelTop,
  y1: at.y + TILE.labelBottom,
});

const grow = (rect: StageRect, by: number): StageRect => ({
  x0: rect.x0 - by,
  x1: rect.x1 + by,
  y0: rect.y0 - by,
  y1: rect.y1 + by,
});

/** Whether the stretch from `a` to `b` passes through `rect` (Liang–Barsky clipping). */
export function crossesRect(a: Point, b: Point, rect: StageRect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - rect.x0],
    [dx, rect.x1 - a.x],
    [-dy, a.y - rect.y0],
    [dy, rect.y1 - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

interface Pair {
  source: string;
  target: string;
  opposite: boolean;
}

interface Routed extends Pair {
  route: AgentGraphRoute;
}

/** One line per direction between two agents, as the stage draws them. */
function pairsOf(graph: RunAgentGraph): Pair[] {
  const seen = new Set<string>();
  for (const relation of graph.relations)
    if (relation.source !== relation.target)
      seen.add(JSON.stringify([relation.source, relation.target]));
  return [...seen].map((key) => {
    const [source, target] = JSON.parse(key) as [string, string];
    return { source, target, opposite: seen.has(JSON.stringify([target, source])) };
  });
}

/** How badly one drawn line runs over the agents on the stage. */
export function routeTrouble(
  routed: { source: string; target: string; route: AgentGraphRoute },
  positions: ReadonlyMap<string, Point>,
): number {
  let cost = 0;
  const { points } = routed.route;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    for (const [id, at] of positions) {
      if (id === routed.source || id === routed.target) {
        if (!crossesRect(a, b, labelRect(at))) continue;
        const stem = Math.abs(a.x - b.x) < 0.5 && Math.abs(a.x - at.x) <= STEM;
        cost += stem ? COST.stem : COST.ownLabel;
      } else {
        if (crossesRect(a, b, grow(markRect(at), 6))) cost += COST.mark;
        if (crossesRect(a, b, grow(labelRect(at), 4))) cost += COST.label;
      }
    }
  }
  return cost;
}

/** Lines that run along each other or cross: an unrelated overlap reads as one line. */
function pairTrouble(one: Routed, other: Routed): number {
  const samePair =
    (one.source === other.source && one.target === other.target) ||
    (one.source === other.target && one.target === other.source);
  if (samePair) return 0;
  const shared =
    one.source === other.source ||
    one.source === other.target ||
    one.target === other.source ||
    one.target === other.target;
  let cost = 0;
  const first = one.route.points;
  const second = other.route.points;
  for (let i = 1; i < first.length; i++) {
    const a = first[i - 1] as Point;
    const b = first[i] as Point;
    for (let j = 1; j < second.length; j++) {
      const c = second[j - 1] as Point;
      const d = second[j] as Point;
      const along = (axis: 'x' | 'y', across: 'x' | 'y') =>
        Math.abs(a[across] - b[across]) < 0.5 &&
        Math.abs(c[across] - d[across]) < 0.5 &&
        Math.abs(a[across] - c[across]) < 5 &&
        Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
          Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) >
          12;
      // A lead's lines share one trunk by design; only a shared leg is worth avoiding.
      if (along('x', 'y')) cost += shared ? COST.sharedOverlap : COST.overlap;
      else if (along('y', 'x')) cost += shared ? 0 : COST.overlap;
      else if (!shared && crosses(a, b, c, d)) cost += COST.crossing;
    }
  }
  return cost;
}

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** The stage's size in rows once fitted to its landscape shape; smaller draws larger. */
function areaOf(points: Iterable<Point>): number {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (minX > maxX) return 0;
  const width = maxX - minX + TILE.halfWidth * 2;
  const height = maxY - minY + TILE.markHalf + TILE.labelBottom;
  return Math.max(width / ASPECT, height) / PITCH.y;
}

const tilesClear = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) >= TILE.halfWidth * 2 + GAP ||
  Math.abs(a.y - b.y) >= TILE.markHalf + TILE.labelBottom + GAP;

type Order = 'leads' | 'seen' | 'degree';

interface Strategy {
  order: Order;
  /** Among equal placements, the side of its neighbours an agent takes first. */
  above: boolean;
}

class Stage {
  readonly placed = new Map<string, Point>();
  readonly routes: Routed[] = [];
  private readonly leads: ReadonlySet<string>;
  private readonly pairs: Pair[];
  private readonly neighbors = new Map<string, Set<string>>();
  private readonly seen: string[];
  /** Leads whose lines leave them vertically: their column stays free for those trunks. */
  private readonly trunks: string[];

  constructor(graph: RunAgentGraph, previous: ReadonlyMap<string, Point>) {
    this.seen = graph.nodes.map((node) => node.id);
    this.leads = new Set(graph.nodes.filter((node) => node.lead).map((node) => node.id));
    this.pairs = pairsOf(graph);
    for (const id of this.seen) this.neighbors.set(id, new Set());
    for (const pair of this.pairs) {
      this.neighbors.get(pair.source)?.add(pair.target);
      this.neighbors.get(pair.target)?.add(pair.source);
    }
    this.trunks = [...this.leads].filter((id) =>
      [...(this.neighbors.get(id) ?? [])].some((other) => !this.leads.has(other)),
    );
    for (const id of this.seen) {
      const at = previous.get(id);
      if (at) this.placed.set(id, at);
    }
    for (const pair of this.pairs) {
      const route = this.route(pair, this.placed);
      if (route) this.routes.push({ ...pair, route });
    }
  }

  private route(pair: Pair, positions: ReadonlyMap<string, Point>): AgentGraphRoute | null {
    const from = positions.get(pair.source);
    const to = positions.get(pair.target);
    if (!from || !to) return null;
    return routeRelation({ ...pair, from, to, leads: this.leads });
  }

  private placedNeighbors(id: string): string[] {
    return [...(this.neighbors.get(id) ?? [])].filter((other) => this.placed.has(other));
  }

  /** The next agent to place: one that works with a placed agent, when there is one. */
  private next(remaining: string[], order: Order): string {
    const anchored = remaining.filter((id) => this.placedNeighbors(id).length > 0);
    const pool = anchored.length ? anchored : remaining;
    const first = (ids: string[]) => ids[0] as string;
    if (order === 'seen') return first(pool);
    if (order === 'degree')
      return first(
        [...pool].sort(
          (a, b) => (this.neighbors.get(b)?.size ?? 0) - (this.neighbors.get(a)?.size ?? 0),
        ),
      );
    // Leads take the row first; then whoever works with the most placed agents.
    const leads = pool.filter((id) => this.leads.has(id));
    if (leads.length) return first(leads);
    return first(
      [...pool].sort((a, b) => this.placedNeighbors(b).length - this.placedNeighbors(a).length),
    );
  }

  /** Free cells within `reach` rows (and twice as many half columns) of `near`. */
  private cellsWithin(near: Point[], apart: boolean, reach: number): Point[] {
    const all = [...this.placed.values()];
    const half = PITCH.x / 2;
    const minI = Math.round(Math.min(...near.map((p) => p.x)) / half) - reach * 2;
    const maxI = Math.round(Math.max(...near.map((p) => p.x)) / half) + reach * 2;
    const minJ = Math.round(Math.min(...near.map((p) => p.y)) / PITCH.y) - reach;
    const maxJ = Math.round(Math.max(...near.map((p) => p.y)) / PITCH.y) + reach;
    const cells: Point[] = [];
    for (let j = minJ; j <= maxJ; j++)
      for (let i = minI; i <= maxI; i++) {
        const cell = { x: i * half, y: j * PITCH.y };
        const clear = apart
          ? // An agent nobody has worked with yet stands a full step away from the others.
            all.every(
              (at) =>
                Math.abs(at.x - cell.x) >= PITCH.x * 2 || Math.abs(at.y - cell.y) >= PITCH.y * 2,
            )
          : all.every((at) => tilesClear(at, cell));
        if (clear) cells.push(cell);
      }
    return cells;
  }

  place(id: string, above: boolean): void {
    if (!this.placed.size) {
      this.placed.set(id, { x: 0, y: 0 });
      return;
    }
    const neighbors = this.placedNeighbors(id);
    const anchors = neighbors.map((other) => this.placed.get(other) as Point);
    const all = [...this.placed.values()];
    const near = anchors.length ? anchors : all;
    const centre = {
      x: near.reduce((sum, p) => sum + p.x, 0) / near.length,
      y: near.reduce((sum, p) => sum + p.y, 0) / near.length,
    };
    const before = areaOf(all);
    const own = this.pairs.filter(
      (pair) =>
        (pair.source === id && this.placed.has(pair.target)) ||
        (pair.target === id && this.placed.has(pair.source)),
    );
    // A lead's line leaves it vertically and turns once toward the other agent, so an agent
    // working with a lead never shares its row or its column.
    const leadAnchors = this.leads.has(id)
      ? []
      : neighbors.filter((other) => this.leads.has(other)).map((other) => this.placed.get(other));
    type Choice = { cell: Point; cost: number; trouble: number; routes: Routed[] };
    const weigh = (cell: Point, bound: number): Choice | null => {
      if (leadAnchors.some((at) => at && (at.x === cell.x || at.y === cell.y))) return null;
      const positions = new Map(this.placed).set(id, cell);
      let trouble = 0;
      let cost =
        COST.area * (areaOf(positions.values()) - before) +
        COST.distance * Math.hypot((cell.x - centre.x) / PITCH.x, (cell.y - centre.y) / PITCH.y) +
        COST.side * (above === cell.y > centre.y ? 1 : 0);
      for (const lead of this.trunks) {
        const at = this.placed.get(lead);
        if (at && at.y !== cell.y && Math.abs(at.x - cell.x) < TILE.halfWidth + STEM)
          cost += COST.trunk;
      }
      const routes: Routed[] = [];
      for (const pair of own) {
        const route = this.route(pair, positions);
        if (!route) continue;
        const routed = { ...pair, route };
        routes.push(routed);
        const over = routeTrouble(routed, positions);
        trouble += over;
        cost += over;
        for (const other of this.routes) cost += pairTrouble(routed, other);
        // Work reads left to right: what an agent sends lands to its right.
        const from = positions.get(pair.source) as Point;
        const to = positions.get(pair.target) as Point;
        if (to.x < from.x) cost += COST.flow;
        if (cost >= bound) return null;
      }
      // The lines already drawn must stay clear of the newcomer.
      const lone = new Map([[id, cell]]);
      for (const other of this.routes) {
        const over = routeTrouble(other, lone);
        trouble += over;
        cost += over;
        if (cost >= bound) return null;
      }
      return { cell, cost, trouble, routes };
    };
    // Look further out while every nearby place would draw a line over a mark or a label.
    const apart = !anchors.length;
    const weighed = new Set<string>();
    let best: Choice | null = null;
    for (let reach = apart ? 3 : 2, widened = 0; ; reach++, widened++) {
      for (const cell of this.cellsWithin(near, apart, reach)) {
        const key = `${cell.x},${cell.y}`;
        if (weighed.has(key)) continue;
        weighed.add(key);
        const choice = weigh(cell, best?.cost ?? Number.POSITIVE_INFINITY);
        if (choice) best = choice;
      }
      if (best && (best.trouble < COST.ownLabel || widened >= WIDEN_LIMIT)) break;
    }
    const chosen = best as Choice;
    this.placed.set(id, chosen.cell);
    this.routes.push(...chosen.routes);
  }

  run({ order, above }: Strategy): this {
    const remaining = this.seen.filter((id) => !this.placed.has(id));
    while (remaining.length) {
      const id = this.next(remaining, order);
      remaining.splice(remaining.indexOf(id), 1);
      this.place(id, above);
    }
    return this;
  }

  /** The whole arrangement's cost: trouble first, then how large it can be drawn. */
  total(): number {
    let cost = COST.area * areaOf(this.placed.values());
    for (const [index, routed] of this.routes.entries()) {
      cost += routeTrouble(routed, this.placed);
      for (const other of this.routes.slice(index + 1)) cost += pairTrouble(routed, other);
    }
    return cost;
  }
}

const STRATEGIES: Strategy[] = [
  { order: 'leads', above: true },
  { order: 'leads', above: false },
  { order: 'seen', above: true },
  { order: 'seen', above: false },
  { order: 'degree', above: true },
  { order: 'degree', above: false },
];
/** Above this many agents one arrangement is tried instead of several. */
const SEARCH_LIMIT = 36;

/**
 * Places each observed agent so that no tile touches another and, wherever an arrangement
 * allows it, no line runs over a mark or a label. Agents that work together stand together.
 * A first arrangement is the best of a few placement orders; agents already placed never move,
 * so a live run only gains agents.
 */
export function layoutRunAgents(
  graph: RunAgentGraph,
  previous: ReadonlyMap<string, AgentGraphPosition> = new Map(),
): Map<string, AgentGraphPosition> {
  const kept = graph.nodes.some((node) => previous.has(node.id));
  if (kept || graph.nodes.length > SEARCH_LIMIT)
    return new Stage(graph, previous).run(STRATEGIES[0] as Strategy).placed;
  let best: { placed: Map<string, AgentGraphPosition>; cost: number } | null = null;
  for (const strategy of STRATEGIES) {
    const stage = new Stage(graph, previous).run(strategy);
    const cost = stage.total();
    if (!best || cost < best.cost - 1e-9) best = { placed: stage.placed, cost };
  }
  return best?.placed ?? new Map();
}
