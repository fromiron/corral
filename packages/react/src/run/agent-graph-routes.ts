import type { AgentGraphPosition } from './agent-graph-layout.ts';

type Point = AgentGraphPosition;

export interface AgentGraphRoute {
  /** SVG path drawn from source to target, so a flowing dash runs in the relation's direction. */
  d: string;
  /** The route as straight stretches from source to target (corners unrounded), for hit tests. */
  points: Point[];
  /** Midpoint of the route, where a direction mark sits. */
  label: Point;
  /** Direction of travel at the label, in degrees. */
  angle: number;
}

/** An axis-aligned area of the stage. */
export interface StageRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const inside = (point: Point, rect: StageRect) =>
  point.x >= rect.x0 && point.x <= rect.x1 && point.y >= rect.y0 && point.y <= rect.y1;

/**
 * The middle of the stretch of a route that is in the open: outside the areas its own two agents
 * cover, where the line runs under a mark or behind a label. Falls back to the plain midpoint.
 */
export function openMidpoint(
  route: AgentGraphRoute,
  covered: readonly StageRect[],
): { point: Point; angle: number } {
  const STEPS = 48;
  const { points } = route;
  // Only the areas the route passes near can cover one of its steps.
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
  const near = covered.filter(
    (rect) => rect.x1 >= x0 - 1 && rect.x0 <= x1 + 1 && rect.y1 >= y0 - 1 && rect.y0 <= y1 + 1,
  );
  const lengths = lengthsOf(points);
  let best: [number, number] | null = null;
  let start: number | null = null;
  for (let i = 0; i <= STEPS + 1; i++) {
    let open = i <= STEPS;
    if (open) {
      const { point } = alongLengths(points, lengths, i / STEPS);
      open = !near.some((rect) => inside(point, rect));
    }
    if (open && start === null) start = i;
    if (!open && start !== null) {
      if (!best || i - 1 - start > best[1] - best[0]) best = [start, i - 1];
      start = null;
    }
  }
  if (!best) return { point: route.label, angle: route.angle };
  return along(points, (best[0] + best[1]) / 2 / STEPS);
}

const CORNER = 8;
const PARALLEL = 4;
const f = (value: number) => Math.round(value * 10) / 10;

function lengthsOf(points: Point[]): number[] {
  return points.slice(1).map((point, i) => {
    const from = points[i] as Point;
    return Math.hypot(point.x - from.x, point.y - from.y);
  });
}

function along(points: Point[], fraction: number): { point: Point; angle: number } {
  return alongLengths(points, lengthsOf(points), fraction);
}

function alongLengths(
  points: Point[],
  lengths: number[],
  fraction: number,
): { point: Point; angle: number } {
  let rest = lengths.reduce((sum, value) => sum + value, 0) * fraction;
  for (const [i, length] of lengths.entries()) {
    const from = points[i] as Point;
    const to = points[i + 1] as Point;
    if (rest <= length || i === lengths.length - 1) {
      const t = length ? Math.min(1, rest / length) : 0;
      return {
        point: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
        angle: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
      };
    }
    rest -= length;
  }
  return { point: points[0] as Point, angle: 0 };
}

function polyline(points: Point[]): string {
  return points.map((point, i) => `${i ? 'L' : 'M'}${f(point.x)} ${f(point.y)}`).join('');
}

/** The straight line's two ends, shifted to one side of the pair's canonical direction. */
function straightPoints(from: Point, to: Point, side: number, flip: boolean): Point[] {
  // Both directions measure their side from the same (canonical) vector.
  const dx = (to.x - from.x) * (flip ? -1 : 1);
  const dy = (to.y - from.y) * (flip ? -1 : 1);
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * side * PARALLEL;
  const ny = (dx / length) * side * PARALLEL;
  return [
    { x: from.x + nx, y: from.y + ny },
    { x: to.x + nx, y: to.y + ny },
  ];
}

/** A straight line, shifted to one side of the pair's canonical direction when needed. */
function straight(from: Point, to: Point, side: number, flip: boolean): AgentGraphRoute {
  const points = straightPoints(from, to, side, flip);
  const { point, angle } = along(points, 0.5);
  return { d: polyline(points), points, label: point, angle };
}

/** The elbow's trunk (the column it leaves the lead in) and leg (the row it turns into). */
function elbowLanes(lead: Point, other: Point, inner: boolean) {
  const sx = Math.sign(other.x - lead.x);
  const sy = Math.sign(other.y - lead.y);
  const trunk = lead.x + (other.y - lead.y < 0 ? 8 : 4) * sx + (inner ? 6 * sx : 0);
  const leg = other.y - (inner ? 6 * sy : 0);
  return { trunk, leg };
}

function elbowPoints(lead: Point, other: Point, towardLead: boolean, inner: boolean): Point[] {
  const { trunk, leg } = elbowLanes(lead, other, inner);
  const outward = [
    { x: trunk, y: lead.y },
    { x: trunk, y: leg },
    { x: other.x, y: leg },
  ];
  return towardLead ? outward.reverse() : outward;
}

/**
 * The kit's orthogonal route out of the lead: down or up from the lead, then a rounded turn
 * toward the other agent. Each quadrant gets its own trunk, as in the kit demo; a reply drawn
 * back to the lead takes the inner lane.
 */
function elbow(lead: Point, other: Point, towardLead: boolean, inner: boolean): AgentGraphRoute {
  const { trunk, leg } = elbowLanes(lead, other, inner);
  const radius = Math.min(CORNER, Math.abs(leg - lead.y) / 2, Math.abs(other.x - trunk) / 2);
  const points = elbowPoints(lead, other, towardLead, inner);
  const [a, b, c] = points as [Point, Point, Point];
  // Round the single corner with a quadratic curve through it.
  const before = {
    x: b.x - Math.sign(b.x - a.x) * radius,
    y: b.y - Math.sign(b.y - a.y) * radius,
  };
  const after = {
    x: b.x + Math.sign(c.x - b.x) * radius,
    y: b.y + Math.sign(c.y - b.y) * radius,
  };
  const d = `M${f(a.x)} ${f(a.y)}L${f(before.x)} ${f(before.y)}Q${f(b.x)} ${f(b.y)} ${f(after.x)} ${f(after.y)}L${f(c.x)} ${f(c.y)}`;
  const { point, angle } = along(points, 0.5);
  return { d, points, label: point, angle };
}

const loopPoints = (at: Point): Point[] => [
  { x: at.x + 10, y: at.y - 20 },
  { x: at.x + 46, y: at.y - 58 },
  { x: at.x, y: at.y - 24 },
];

/** A loop above and right of an agent, for relations between its own executions. */
function loop(at: Point): AgentGraphRoute {
  return {
    d: `M${f(at.x + 10)} ${f(at.y - 20)}C${f(at.x + 70)} ${f(at.y - 40)} ${f(at.x + 40)} ${f(at.y - 90)} ${f(at.x)} ${f(at.y - 24)}`,
    points: loopPoints(at),
    label: { x: at.x + 46, y: at.y - 58 },
    angle: 180,
  };
}

export interface RouteRequest {
  source: string;
  target: string;
  from: Point;
  to: Point;
  leads: ReadonlySet<string>;
  /** The reverse direction between the same two agents is drawn too. */
  opposite: boolean;
}

type RouteShape =
  | { kind: 'loop'; at: Point }
  | { kind: 'elbow'; lead: Point; other: Point; towardLead: boolean; inner: boolean }
  | { kind: 'straight'; from: Point; to: Point; side: number; flip: boolean };

function shapeOf({ source, target, from, to, leads, opposite }: RouteRequest): RouteShape {
  if (source === target) return { kind: 'loop', at: from };
  const sourceLead = leads.has(source);
  if (sourceLead !== leads.has(target)) {
    const lead = sourceLead ? from : to;
    const other = sourceLead ? to : from;
    if (Math.abs(other.x - lead.x) >= 1 && Math.abs(other.y - lead.y) >= 1)
      return {
        kind: 'elbow',
        lead,
        other,
        towardLead: !sourceLead,
        inner: opposite && !sourceLead,
      };
  }
  const canonical = source < target;
  return {
    kind: 'straight',
    from,
    to,
    side: opposite ? (canonical ? 1 : -1) : 0,
    flip: !canonical,
  };
}

/** The route's straight stretches only, as `routeRelation` draws them; for placement. */
export function routePoints(request: RouteRequest): Point[] {
  const shape = shapeOf(request);
  if (shape.kind === 'loop') return loopPoints(shape.at);
  if (shape.kind === 'elbow')
    return elbowPoints(shape.lead, shape.other, shape.towardLead, shape.inner);
  return straightPoints(shape.from, shape.to, shape.side, shape.flip);
}

export function routeRelation(request: RouteRequest): AgentGraphRoute {
  const shape = shapeOf(request);
  if (shape.kind === 'loop') return loop(shape.at);
  if (shape.kind === 'elbow') return elbow(shape.lead, shape.other, shape.towardLead, shape.inner);
  return straight(shape.from, shape.to, shape.side, shape.flip);
}
