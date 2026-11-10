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
  let best: [number, number] | null = null;
  let start: number | null = null;
  for (let i = 0; i <= STEPS + 1; i++) {
    const open =
      i <= STEPS && !covered.some((rect) => inside(along(route.points, i / STEPS).point, rect));
    if (open && start === null) start = i;
    if (!open && start !== null) {
      if (!best || i - 1 - start > best[1] - best[0]) best = [start, i - 1];
      start = null;
    }
  }
  if (!best) return { point: route.label, angle: route.angle };
  return along(route.points, (best[0] + best[1]) / 2 / STEPS);
}

const CORNER = 8;
const PARALLEL = 4;
const f = (value: number) => Math.round(value * 10) / 10;

function along(points: Point[], fraction: number): { point: Point; angle: number } {
  const lengths = points.slice(1).map((point, i) => {
    const from = points[i] as Point;
    return Math.hypot(point.x - from.x, point.y - from.y);
  });
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

/** A straight line, shifted to one side of the pair's canonical direction when needed. */
function straight(from: Point, to: Point, side: number, flip: boolean): AgentGraphRoute {
  // Both directions measure their side from the same (canonical) vector.
  const dx = (to.x - from.x) * (flip ? -1 : 1);
  const dy = (to.y - from.y) * (flip ? -1 : 1);
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * side * PARALLEL;
  const ny = (dx / length) * side * PARALLEL;
  const points = [
    { x: from.x + nx, y: from.y + ny },
    { x: to.x + nx, y: to.y + ny },
  ];
  const { point, angle } = along(points, 0.5);
  return { d: polyline(points), points, label: point, angle };
}

/**
 * The kit's orthogonal route out of the lead: down or up from the lead, then a rounded turn
 * toward the other agent. Each quadrant gets its own trunk, as in the kit demo; a reply drawn
 * back to the lead takes the inner lane.
 */
function elbow(lead: Point, other: Point, towardLead: boolean, inner: boolean): AgentGraphRoute {
  const dx = other.x - lead.x;
  const dy = other.y - lead.y;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const trunk = lead.x + (dy < 0 ? 8 : 4) * sx + (inner ? 6 * sx : 0);
  const leg = other.y - (inner ? 6 * sy : 0);
  const radius = Math.min(CORNER, Math.abs(leg - lead.y) / 2, Math.abs(other.x - trunk) / 2);
  const corner = [
    { x: trunk, y: lead.y },
    { x: trunk, y: leg },
    { x: other.x, y: leg },
  ] as const;
  const outward = [...corner];
  const points = towardLead ? [...outward].reverse() : outward;
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

/** A loop above and right of an agent, for relations between its own executions. */
function loop(at: Point): AgentGraphRoute {
  return {
    d: `M${f(at.x + 10)} ${f(at.y - 20)}C${f(at.x + 70)} ${f(at.y - 40)} ${f(at.x + 40)} ${f(at.y - 90)} ${f(at.x)} ${f(at.y - 24)}`,
    points: [
      { x: at.x + 10, y: at.y - 20 },
      { x: at.x + 46, y: at.y - 58 },
      { x: at.x, y: at.y - 24 },
    ],
    label: { x: at.x + 46, y: at.y - 58 },
    angle: 180,
  };
}

export function routeRelation({
  source,
  target,
  from,
  to,
  leads,
  opposite,
}: {
  source: string;
  target: string;
  from: Point;
  to: Point;
  leads: ReadonlySet<string>;
  /** The reverse direction between the same two agents is drawn too. */
  opposite: boolean;
}): AgentGraphRoute {
  if (source === target) return loop(from);
  const sourceLead = leads.has(source);
  if (sourceLead !== leads.has(target)) {
    const lead = sourceLead ? from : to;
    const other = sourceLead ? to : from;
    if (Math.abs(other.x - lead.x) >= 1 && Math.abs(other.y - lead.y) >= 1)
      return elbow(lead, other, !sourceLead, opposite && !sourceLead);
  }
  const canonical = source < target;
  return straight(from, to, opposite ? (canonical ? 1 : -1) : 0, !canonical);
}
