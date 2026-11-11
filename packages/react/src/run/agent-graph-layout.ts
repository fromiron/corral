import type { RunAgentGraph } from './agent-graph.ts';
import { type AgentGraphRoute, routePoints, type StageRect } from './agent-graph-routes.ts';

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

/**
 * How far around an agent's centre a line can cost something: its mark grown by 6 and its label
 * grown by 4, plus a pixel so rounding never hides a touch.
 */
const REACH = {
  x: TILE.halfWidth + 4 + 1,
  up: TILE.markHalf + 6 + 1,
  down: TILE.labelBottom + 4 + 1,
} as const;
/** Lines further apart than this neither run along each other nor cross. */
const ALONG = 6;
/** Level stretches are filed by bands this tall; one along another lies within 5px of it. */
const BAND = 8;

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

/** Whether the stretch from `a` to `b` passes through the box (Liang–Barsky clipping). */
function crossesBox(a: Point, b: Point, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (let edge = 0; edge < 4; edge++) {
    const p = edge === 0 ? -dx : edge === 1 ? dx : edge === 2 ? -dy : dy;
    const q = edge === 0 ? a.x - x0 : edge === 1 ? x1 - a.x : edge === 2 ? a.y - y0 : y1 - a.y;
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

/** Whether the stretch from `a` to `b` passes through `rect` (Liang–Barsky clipping). */
export function crossesRect(a: Point, b: Point, rect: StageRect): boolean {
  return crossesBox(a, b, rect.x0, rect.y0, rect.x1, rect.y1);
}

/** What one stretch of a line costs where it passes the agent standing at `at`. */
function stretchTrouble(a: Point, b: Point, at: Point, own: boolean): number {
  if (own) {
    const x0 = at.x - TILE.halfWidth;
    const x1 = at.x + TILE.halfWidth;
    if (!crossesBox(a, b, x0, at.y + TILE.labelTop, x1, at.y + TILE.labelBottom)) return 0;
    const stem = Math.abs(a.x - b.x) < 0.5 && Math.abs(a.x - at.x) <= STEM;
    return stem ? COST.stem : COST.ownLabel;
  }
  let cost = 0;
  const m0 = at.x - TILE.markHalf - 6;
  const m1 = at.x + TILE.markHalf + 6;
  if (crossesBox(a, b, m0, at.y - TILE.markHalf - 6, m1, at.y + TILE.markHalf + 6))
    cost += COST.mark;
  const l0 = at.x - TILE.halfWidth - 4;
  const l1 = at.x + TILE.halfWidth + 4;
  if (crossesBox(a, b, l0, at.y + TILE.labelTop - 4, l1, at.y + TILE.labelBottom + 4))
    cost += COST.label;
  return cost;
}

interface Pair {
  source: string;
  target: string;
  opposite: boolean;
  /** The two agents' numbers on the stage, for quick comparison. */
  sourceIndex: number;
  targetIndex: number;
}

/** A drawn line's stretches, and the box around them. */
interface Routed extends Pair {
  points: Point[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function routedOf(pair: Pair, points: Point[]): Routed {
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    x0 = Math.min(x0, point.x);
    x1 = Math.max(x1, point.x);
    y0 = Math.min(y0, point.y);
    y1 = Math.max(y1, point.y);
  }
  const { source, target, opposite, sourceIndex, targetIndex } = pair;
  return { source, target, opposite, sourceIndex, targetIndex, points, x0, y0, x1, y1 };
}

/** The stretches of the line `pair` draws between two places. */
const pointsBetween = (pair: Pair, from: Point, to: Point, leads: ReadonlySet<string>) =>
  routePoints({
    source: pair.source,
    target: pair.target,
    from,
    to,
    leads,
    opposite: pair.opposite,
  });

/** One line per direction between two agents, as the stage draws them. */
function pairsOf(graph: RunAgentGraph, number: (id: string) => number): Pair[] {
  const seen = new Set<string>();
  for (const relation of graph.relations)
    if (relation.source !== relation.target)
      seen.add(JSON.stringify([relation.source, relation.target]));
  return [...seen].map((key) => {
    const [source, target] = JSON.parse(key) as [string, string];
    return {
      source,
      target,
      opposite: seen.has(JSON.stringify([target, source])),
      sourceIndex: number(source),
      targetIndex: number(target),
    };
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
    for (const [id, at] of positions)
      cost += stretchTrouble(a, b, at, id === routed.source || id === routed.target);
  }
  return cost;
}

const level = (a: Point, b: Point) => Math.abs(a.y - b.y) < 0.5;
const upright = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5;

/** Both stretches lie on one row, a few pixels apart, and share more than a corner's length. */
function alongX(a: Point, b: Point, c: Point, d: Point): boolean {
  return (
    level(a, b) &&
    level(c, d) &&
    Math.abs(a.y - c.y) < 5 &&
    Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
      Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) >
      12
  );
}

/** Both stretches lie on one column, a few pixels apart, and share more than a corner's length. */
function alongY(a: Point, b: Point, c: Point, d: Point): boolean {
  return (
    upright(a, b) &&
    upright(c, d) &&
    Math.abs(a.x - c.x) < 5 &&
    Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) -
      Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) >
      12
  );
}

const sharesAgent = (one: Pair, other: Pair) =>
  one.sourceIndex === other.sourceIndex ||
  one.sourceIndex === other.targetIndex ||
  one.targetIndex === other.sourceIndex ||
  one.targetIndex === other.targetIndex;

/** Lines that run along each other or cross: an unrelated overlap reads as one line. */
function pairTrouble(one: Routed, other: Routed): number {
  const samePair =
    (one.sourceIndex === other.sourceIndex && one.targetIndex === other.targetIndex) ||
    (one.sourceIndex === other.targetIndex && one.targetIndex === other.sourceIndex);
  if (samePair) return 0;
  if (
    one.x0 > other.x1 + ALONG ||
    other.x0 > one.x1 + ALONG ||
    one.y0 > other.y1 + ALONG ||
    other.y0 > one.y1 + ALONG
  )
    return 0;
  const shared = sharesAgent(one, other);
  let cost = 0;
  const first = one.points;
  const second = other.points;
  for (let i = 1; i < first.length; i++) {
    const a = first[i - 1] as Point;
    const b = first[i] as Point;
    for (let j = 1; j < second.length; j++) {
      const c = second[j - 1] as Point;
      const d = second[j] as Point;
      // A lead's lines share one trunk by design; only a shared leg is worth avoiding.
      if (alongX(a, b, c, d)) cost += shared ? COST.sharedOverlap : COST.overlap;
      else if (shared) continue;
      else if (alongY(a, b, c, d)) cost += COST.overlap;
      else if (crosses(a, b, c, d)) cost += COST.crossing;
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

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The stage's size in rows once fitted to its landscape shape; smaller draws larger. */
function areaOf({ minX, maxX, minY, maxY }: Box): number {
  if (minX > maxX) return 0;
  const width = maxX - minX + TILE.halfWidth * 2;
  const height = maxY - minY + TILE.markHalf + TILE.labelBottom;
  return Math.max(width / ASPECT, height) / PITCH.y;
}

const tilesClear = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) >= TILE.halfWidth * 2 + GAP ||
  Math.abs(a.y - b.y) >= TILE.markHalf + TILE.labelBottom + GAP;

/** An agent nobody has worked with yet stands a full step away from the others. */
const standsApart = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) >= PITCH.x * 2 || Math.abs(a.y - b.y) >= PITCH.y * 2;

type Order = 'leads' | 'seen' | 'degree';

interface Strategy {
  order: Order;
  /** Among equal placements, the side of its neighbours an agent takes first. */
  above: boolean;
}

/** Things filed by bands of one coordinate, so a check reads only the bands near it. */
class Bands<T> {
  private readonly bands = new Map<number, T[]>();
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  band(value: number): number {
    return Math.floor(value / this.size);
  }

  at(band: number): readonly T[] | undefined {
    return this.bands.get(band);
  }

  /** Files `item` in the band of `value`, once. */
  add(value: number, item: T): void {
    const items = this.bands.get(this.band(value));
    if (!items) this.bands.set(this.band(value), [item]);
    else if (items[items.length - 1] !== item) items.push(item);
  }
}

/** Placed agents' centres and numbers in flat arrays: a pass over all of them is quick. */
class Agents {
  xs = new Float64Array(64);
  ys = new Float64Array(64);
  numbers = new Int32Array(64);
  readonly at: Point[] = [];

  get count(): number {
    return this.at.length;
  }

  add(number: number, at: Point): void {
    const index = this.at.length;
    if (index === this.xs.length) {
      const xs = new Float64Array(index * 2);
      const ys = new Float64Array(index * 2);
      const numbers = new Int32Array(index * 2);
      xs.set(this.xs);
      ys.set(this.ys);
      numbers.set(this.numbers);
      this.xs = xs;
      this.ys = ys;
      this.numbers = numbers;
    }
    this.xs[index] = at.x;
    this.ys[index] = at.y;
    this.numbers[index] = number;
    this.at.push(at);
  }
}

/** How many places an arrangement may weigh: all of them, then the nearest few, then none. */
interface Limits {
  /** Until this many, every free place in a look is weighed. */
  exact: number;
  /** Past this many, agents take the free place with the lowest floor without weighing. */
  limit: number;
}

/** Drawn lines' boxes and end agents in flat arrays, for quick passes over every line. */
class Drawn {
  /** x0, y0, x1, y1 of each line. */
  boxes = new Float64Array(256);
  /** Source and target number of each line. */
  ends = new Int32Array(128);
  /** The last mark each line was given. */
  marks = new Int32Array(64);
  count = 0;

  add(line: Routed): void {
    if (this.count === this.marks.length) {
      const grow = <T extends Float64Array | Int32Array>(from: T, to: T): T => {
        to.set(from);
        return to;
      };
      this.boxes = grow(this.boxes, new Float64Array(this.boxes.length * 2));
      this.ends = grow(this.ends, new Int32Array(this.ends.length * 2));
      this.marks = grow(this.marks, new Int32Array(this.marks.length * 2));
    }
    const at = this.count++;
    this.boxes[at * 4] = line.x0;
    this.boxes[at * 4 + 1] = line.y0;
    this.boxes[at * 4 + 2] = line.x1;
    this.boxes[at * 4 + 3] = line.y1;
    this.ends[at * 2] = line.sourceIndex;
    this.ends[at * 2 + 1] = line.targetIndex;
  }
}

/** Costs that can only be told apart past this are certain to differ, whatever the order. */
const SURE = 1e-6;

class Stage {
  readonly placed = new Map<string, Point>();
  readonly routes: Routed[] = [];
  private readonly drawn = new Drawn();
  /** Places weighed past their floor so far. */
  evaluations = 0;
  private readonly limits: Limits;
  private readonly leads: ReadonlySet<string>;
  private readonly pairs: Pair[];
  private readonly numbers = new Map<string, number>();
  private readonly neighbors = new Map<string, Set<string>>();
  /** Each agent's lines, in the order the relations first appear. */
  private readonly lines = new Map<string, Pair[]>();
  /** How many of each agent's neighbours are placed. */
  private readonly anchoredBy = new Map<string, number>();
  private readonly seen: string[];
  /** Leads whose lines leave them vertically: their column stays free for those trunks. */
  private readonly trunks: string[];
  /** Placed agents by where their centre stands. */
  private readonly agents = new Agents();
  /** Drawn lines (by their index in `routes`) with a level stretch, by its band of rows. */
  private readonly levels = new Bands<number>(BAND);
  private marking = 0;
  private readonly box: Box = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  constructor(graph: RunAgentGraph, previous: ReadonlyMap<string, Point>, limits: Limits) {
    this.limits = limits;
    this.seen = graph.nodes.map((node) => node.id);
    this.leads = new Set(graph.nodes.filter((node) => node.lead).map((node) => node.id));
    const number = (id: string) => {
      const known = this.numbers.get(id);
      if (known !== undefined) return known;
      this.numbers.set(id, this.numbers.size);
      return this.numbers.size - 1;
    };
    for (const id of this.seen) number(id);
    this.pairs = pairsOf(graph, number);
    for (const id of this.seen) {
      this.neighbors.set(id, new Set());
      this.lines.set(id, []);
      this.anchoredBy.set(id, 0);
    }
    for (const pair of this.pairs) {
      this.neighbors.get(pair.source)?.add(pair.target);
      this.neighbors.get(pair.target)?.add(pair.source);
      this.lines.get(pair.source)?.push(pair);
      this.lines.get(pair.target)?.push(pair);
    }
    this.trunks = [...this.leads].filter((id) =>
      [...(this.neighbors.get(id) ?? [])].some((other) => !this.leads.has(other)),
    );
    for (const id of this.seen) {
      const at = previous.get(id);
      if (at) this.put(id, at);
    }
    for (const pair of this.pairs) {
      const from = this.placed.get(pair.source);
      const to = this.placed.get(pair.target);
      if (from && to) this.draw(routedOf(pair, pointsBetween(pair, from, to, this.leads)));
    }
  }

  /** Whether the arrangement has weighed all the places it may. */
  get spent(): boolean {
    return this.evaluations >= this.limits.limit;
  }

  private put(id: string, at: Point): void {
    this.placed.set(id, at);
    this.agents.add(this.numbers.get(id) as number, at);
    this.box.minX = Math.min(this.box.minX, at.x);
    this.box.maxX = Math.max(this.box.maxX, at.x);
    this.box.minY = Math.min(this.box.minY, at.y);
    this.box.maxY = Math.max(this.box.maxY, at.y);
    for (const other of this.neighbors.get(id) ?? [])
      this.anchoredBy.set(other, (this.anchoredBy.get(other) ?? 0) + 1);
  }

  private draw(line: Routed): void {
    const index = this.routes.length;
    this.routes.push(line);
    this.drawn.add(line);
    const { points } = line;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      if (level(a, b)) this.levels.add(a.y, index);
    }
  }

  /**
   * Marks the drawn lines with a level stretch in the rows of one of `line`'s level stretches:
   * of the lines sharing an agent with it, only those can cost anything. Returns the mark.
   */
  private markLevels(line: Routed): number {
    const mark = ++this.marking;
    const { points } = line;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      if (!level(a, b)) continue;
      const last = this.levels.band(a.y + 5);
      for (let band = this.levels.band(a.y - 5); band <= last; band++) {
        const indexes = this.levels.at(band);
        if (indexes) for (const index of indexes) this.drawn.marks[index] = mark;
      }
    }
    return mark;
  }

  private placedNeighbors(id: string): string[] {
    return [...(this.neighbors.get(id) ?? [])].filter((other) => this.placed.has(other));
  }

  /** The next agent to place: one that works with a placed agent, when there is one. */
  private next(remaining: string[], order: Order): string {
    const anchored = remaining.filter((id) => (this.anchoredBy.get(id) ?? 0) > 0);
    const pool = anchored.length ? anchored : remaining;
    if (order === 'seen') return pool[0] as string;
    // The first agent with the most of `count`, as a stable sort would put first.
    const most = (count: (id: string) => number) => {
      let best = pool[0] as string;
      let top = count(best);
      for (const id of pool) {
        const value = count(id);
        if (value > top) {
          best = id;
          top = value;
        }
      }
      return best;
    };
    if (order === 'degree') return most((id) => this.neighbors.get(id)?.size ?? 0);
    // Leads take the row first; then whoever works with the most placed agents.
    const lead = pool.find((id) => this.leads.has(id));
    if (lead !== undefined) return lead;
    return most((id) => this.anchoredBy.get(id) ?? 0);
  }

  /** Whether no placed tile is too close to `cell`, or, apart, within a full step of it. */
  private free(cell: Point, apart: boolean): boolean {
    const { xs, at, count } = this.agents;
    for (let index = 0; index < count; index++) {
      // Far enough sideways for either test.
      if (Math.abs((xs[index] as number) - cell.x) >= PITCH.x * 2) continue;
      const other = at[index] as Point;
      if (!(apart ? standsApart(other, cell) : tilesClear(other, cell))) return false;
    }
    return true;
  }

  /**
   * How badly a line runs over the placed agents and, when given, a newcomer at its end; the
   * same sum `routeTrouble` takes over every agent on the stage.
   */
  private lineTrouble(line: Routed, newcomer?: Point): number {
    let cost = 0;
    const { points, sourceIndex, targetIndex } = line;
    const { xs, ys, numbers, at, count } = this.agents;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      // Only agents within reach of the stretch can cost anything.
      const x0 = Math.min(a.x, b.x) - REACH.x;
      const x1 = Math.max(a.x, b.x) + REACH.x;
      const y0 = Math.min(a.y, b.y) - REACH.down;
      const y1 = Math.max(a.y, b.y) + REACH.up;
      for (let index = 0; index < count; index++) {
        const x = xs[index] as number;
        const y = ys[index] as number;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const number = numbers[index];
        const own = number === sourceIndex || number === targetIndex;
        cost += stretchTrouble(a, b, at[index] as Point, own);
      }
      if (newcomer) cost += stretchTrouble(a, b, newcomer, true);
    }
    return cost;
  }

  place(id: string, above: boolean): void {
    if (!this.placed.size) {
      this.put(id, { x: 0, y: 0 });
      return;
    }
    const neighbors = this.placedNeighbors(id);
    const anchors = neighbors.map((other) => this.placed.get(other) as Point);
    const near = anchors.length ? anchors : [...this.placed.values()];
    const centre = {
      x: near.reduce((sum, p) => sum + p.x, 0) / near.length,
      y: near.reduce((sum, p) => sum + p.y, 0) / near.length,
    };
    const before = areaOf(this.box);
    const own = (this.lines.get(id) ?? []).filter((pair) =>
      this.placed.has(pair.source === id ? pair.target : pair.source),
    );
    // A lead's line leaves it vertically and turns once toward the other agent, so an agent
    // working with a lead never shares its row or its column.
    const leadAnchors = this.leads.has(id)
      ? []
      : neighbors.filter((other) => this.leads.has(other)).map((other) => this.placed.get(other));
    /**
     * What a place costs before its lines are drawn: how much it grows the stage, how far it
     * stands from its neighbours, and whether it blocks a lead's trunk. Every later term only
     * adds, so no place costs less than this.
     */
    const floorOf = (cell: Point): number => {
      const box = this.box;
      const area = areaOf({
        minX: Math.min(box.minX, cell.x),
        maxX: Math.max(box.maxX, cell.x),
        minY: Math.min(box.minY, cell.y),
        maxY: Math.max(box.maxY, cell.y),
      });
      let cost =
        COST.area * (area - before) +
        COST.distance * Math.hypot((cell.x - centre.x) / PITCH.x, (cell.y - centre.y) / PITCH.y) +
        COST.side * (above === cell.y > centre.y ? 1 : 0);
      for (const lead of this.trunks) {
        const at = this.placed.get(lead);
        if (at && at.y !== cell.y && Math.abs(at.x - cell.x) < TILE.halfWidth + STEM)
          cost += COST.trunk;
      }
      return cost;
    };
    /**
     * The place's whole cost, or null once it is sure to lose to `bound`: more, or as much
     * when the earlier candidate keeps the tie.
     */
    const weigh = (cell: Point, floor: number, bound: number, winsTie: boolean) => {
      const loses = (cost: number) => cost > bound || (cost === bound && !winsTie);
      if (loses(floor)) return null;
      const { boxes, ends, marks, count } = this.drawn;
      // First what is quick to find: the newcomer's lines over agents, and the lines already
      // drawn over the newcomer. A place these alone price out is dropped there.
      const routes: Routed[] = [];
      const overs: number[] = [];
      const leftward: boolean[] = [];
      let trouble = 0;
      for (const pair of own) {
        const from = pair.source === id ? cell : (this.placed.get(pair.source) as Point);
        const to = pair.target === id ? cell : (this.placed.get(pair.target) as Point);
        const routed = routedOf(pair, pointsBetween(pair, from, to, this.leads));
        const over = this.lineTrouble(routed, cell);
        routes.push(routed);
        overs.push(over);
        leftward.push(to.x < from.x);
        trouble += over;
      }
      // The lines already drawn must stay clear of the newcomer.
      const around: number[] = [];
      for (let index = 0; index < count; index++) {
        const at = index * 4;
        if (
          (boxes[at + 2] as number) < cell.x - REACH.x ||
          (boxes[at] as number) > cell.x + REACH.x ||
          (boxes[at + 3] as number) < cell.y - REACH.up ||
          (boxes[at + 1] as number) > cell.y + REACH.down
        )
          continue;
        const { points } = this.routes[index] as Routed;
        let over = 0;
        for (let i = 1; i < points.length; i++)
          over += stretchTrouble(points[i - 1] as Point, points[i] as Point, cell, false);
        if (!over) continue;
        around.push(over);
        trouble += over;
      }
      // Every term only adds, so this much is certain whatever the order of the sum.
      if (floor + trouble > bound + SURE) return null;
      // The whole cost, its terms added in one fixed order (a line that adds nothing is
      // skipped), so the same place always costs exactly the same.
      let cost = floor;
      for (const [line, routed] of routes.entries()) {
        cost += overs[line] as number;
        if (loses(cost)) return null;
        // Only lines near this one can run along it or cross it; of those sharing an agent with
        // it, only those with a level stretch in its rows.
        const mark = this.markLevels(routed);
        const { sourceIndex, targetIndex } = routed;
        for (let index = 0; index < count; index++) {
          const source = ends[index * 2];
          const target = ends[index * 2 + 1];
          const at = index * 4;
          if (
            source === sourceIndex ||
            source === targetIndex ||
            target === sourceIndex ||
            target === targetIndex
          ) {
            if (marks[index] !== mark) continue;
          } else if (
            (boxes[at + 2] as number) < routed.x0 - ALONG ||
            (boxes[at] as number) > routed.x1 + ALONG ||
            (boxes[at + 3] as number) < routed.y0 - ALONG ||
            (boxes[at + 1] as number) > routed.y1 + ALONG
          )
            continue;
          const extra = pairTrouble(routed, this.routes[index] as Routed);
          if (!extra) continue;
          cost += extra;
          if (loses(cost)) return null;
        }
        // Work reads left to right: what an agent sends lands to its right.
        if (leftward[line]) cost += COST.flow;
        if (loses(cost)) return null;
      }
      for (const over of around) {
        cost += over;
        if (loses(cost)) return null;
      }
      return { cell, cost, trouble, routes };
    };
    /** The lines the newcomer would draw from `cell`, unweighed. */
    const linesFrom = (cell: Point) =>
      own.map((pair) => {
        const from = pair.source === id ? cell : (this.placed.get(pair.source) as Point);
        const to = pair.target === id ? cell : (this.placed.get(pair.target) as Point);
        return routedOf(pair, pointsBetween(pair, from, to, this.leads));
      });
    // Once the exact search has had its share of the work, only the nearest places are weighed.
    const nearest = this.evaluations >= this.limits.exact;
    // With no line to draw and none drawn, any free place will do: the last one looked at.
    const unweighed = !own.length && !this.routes.length;
    // Look further out while every nearby place would draw a line over a mark or a label.
    const apart = !anchors.length;
    const half = PITCH.x / 2;
    type Choice = NonNullable<ReturnType<typeof weigh>> & { look: number; order: number };
    let best: Choice | null = null;
    let inner: { minI: number; maxI: number; minJ: number; maxJ: number } | null = null;
    for (let reach = apart ? 3 : 2, look = 0; ; reach++, look++) {
      // Free cells within `reach` rows (and twice as many half columns) of `near`; the cells a
      // narrower look already weighed are skipped.
      const minI = Math.round(Math.min(...near.map((p) => p.x)) / half) - reach * 2;
      const maxI = Math.round(Math.max(...near.map((p) => p.x)) / half) + reach * 2;
      const minJ = Math.round(Math.min(...near.map((p) => p.y)) / PITCH.y) - reach;
      const maxJ = Math.round(Math.max(...near.map((p) => p.y)) / PITCH.y) + reach;
      const fresh: { cell: Point; floor: number; order: number }[] = [];
      for (let j = minJ; j <= maxJ; j++)
        for (let i = minI; i <= maxI; i++) {
          if (inner && i >= inner.minI && i <= inner.maxI && j >= inner.minJ && j <= inner.maxJ)
            continue;
          const cell = { x: i * half, y: j * PITCH.y };
          if (!this.free(cell, apart)) continue;
          if (leadAnchors.some((at) => at && (at.x === cell.x || at.y === cell.y))) continue;
          fresh.push({ cell, floor: floorOf(cell), order: fresh.length });
        }
      inner = { minI, maxI, minJ, maxJ };
      if (unweighed) {
        const last = fresh.at(-1);
        if (last)
          best = { cell: last.cell, cost: last.floor, trouble: 0, routes: [], look, order: 0 };
      } else {
        // Cheapest floors first, so the bound is tight early and many places stop at their
        // floor. Among equal costs the place met first in row order wins, as one pass in that
        // order keeping only strict improvements would choose.
        fresh.sort((a, b) => a.floor - b.floor || a.order - b.order);
        let weighed = 0;
        for (const { cell, floor, order } of fresh) {
          if (this.spent) break;
          // Past the exact share, the nearest few are weighed and then the first clear one wins.
          if (nearest && weighed >= NEAREST.least && best && best.trouble < COST.ownLabel) break;
          if (nearest && weighed >= NEAREST.most) break;
          const bound = best?.cost ?? Number.POSITIVE_INFINITY;
          if (floor > bound) break;
          const winsTie = !best || (best.look === look && order < best.order);
          if (floor === bound && !winsTie) continue;
          this.evaluations++;
          weighed++;
          const choice = weigh(cell, floor, bound, winsTie);
          if (choice) best = { ...choice, look, order };
        }
        // Out of work before weighing any: the free place with the lowest floor.
        const first = fresh[0];
        if (!best && this.spent && first) {
          const { cell, floor, order } = first;
          best = { cell, cost: floor, trouble: 0, routes: linesFrom(cell), look, order };
        }
      }
      if (best && (best.trouble < COST.ownLabel || look >= WIDEN_LIMIT || this.spent)) break;
    }
    const chosen = best as Choice;
    this.put(id, chosen.cell);
    for (const routed of chosen.routes) this.draw(routed);
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
    let cost = COST.area * areaOf(this.box);
    for (const [index, routed] of this.routes.entries()) {
      cost += this.lineTrouble(routed);
      for (let other = index + 1; other < this.routes.length; other++)
        cost += pairTrouble(routed, this.routes[other] as Routed);
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
 * How much weighing a layout may do, counted in places weighed so the same run always lays out
 * the same way. Further arrangements are tried while they fit `search`; a single arrangement
 * weighs every free place until `exact`, then the `NEAREST` few of each look, and past `limit`
 * none. A run of a dozen agents stays inside them, so it lays out as an unbounded search would.
 */
const WORK = { search: 16_000, exact: 40_000, limit: 100_000 } as const;
/**
 * Once past `WORK.exact`, a look weighs its places nearest first: at least `least`, then until
 * one draws no line over a mark or a label, and never more than `most`.
 */
const NEAREST = { least: 32, most: 128 } as const;

/** The work one layout took, for tests that bound it. */
export interface LayoutWork {
  /** Candidate places weighed past their floor, across every arrangement tried. */
  evaluations: number;
  /** At most this many places are weighed; tests lower it to reach the plain placement. */
  limit?: number;
}

/**
 * Places each observed agent so that no tile touches another and, wherever an arrangement
 * allows it, no line runs over a mark or a label. Agents that work together stand together.
 * A first arrangement is the best of a few placement orders; agents already placed never move,
 * so a live run only gains agents. The work is bounded (see `WORK`), so a large run lays out
 * in time and always the same way.
 */
export function layoutRunAgents(
  graph: RunAgentGraph,
  previous: ReadonlyMap<string, AgentGraphPosition> = new Map(),
  work?: LayoutWork,
): Map<string, AgentGraphPosition> {
  const limit = Math.min(work?.limit ?? WORK.limit, WORK.limit);
  let used = 0;
  const arrange = (strategy: Strategy, limits: Limits) => {
    const stage = new Stage(graph, previous, limits).run(strategy);
    used += stage.evaluations;
    if (work) work.evaluations += stage.evaluations;
    return stage;
  };
  const first = { exact: Math.min(WORK.exact, limit), limit };
  const kept = graph.nodes.some((node) => previous.has(node.id));
  if (kept || graph.nodes.length > SEARCH_LIMIT)
    return arrange(STRATEGIES[0] as Strategy, first).placed;
  const search = Math.min(WORK.search, limit);
  let best: { placed: Map<string, AgentGraphPosition>; cost: number } | null = null;
  for (const [index, strategy] of STRATEGIES.entries()) {
    // Another arrangement only while one more, weighing as much as those before it, still fits.
    if (index && used + used / index > search) break;
    const rest = search - used;
    const stage = arrange(strategy, index ? { exact: rest, limit: rest } : first);
    const cost = stage.total();
    if (!best || cost < best.cost - 1e-9) best = { placed: stage.placed, cost };
  }
  return best?.placed ?? new Map();
}
