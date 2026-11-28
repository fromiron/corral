import { describe, expect, it } from 'vitest';
import {
  type AgentGraphRoute,
  openMidpoint,
  type RouteRequest,
  routeRelation,
  type StageRect,
} from '../src/run/agent-graph-routes.ts';

const pair = (
  a: { id: string; x: number; y: number },
  b: { id: string; x: number; y: number },
  leads: string[] = [],
): [AgentGraphRoute, AgentGraphRoute] => {
  const request = (from: typeof a, to: typeof a): RouteRequest => ({
    source: from.id,
    target: to.id,
    from,
    to,
    leads: new Set(leads),
    opposite: true,
  });
  return [routeRelation(request(a, b)), routeRelation(request(b, a))];
};

const gap = (one: { x: number; y: number }, other: { x: number; y: number }) =>
  Math.hypot(one.x - other.x, one.y - other.y);

/** How far a point is from the nearest straight stretch of a route. */
const offRoute = (route: AgentGraphRoute, point: { x: number; y: number }) =>
  Math.min(
    ...route.points.slice(1).map((to, i) => {
      const from = route.points[i] as { x: number; y: number };
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) /
            length ** 2,
        ),
      );
      return gap(point, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }),
  );

describe('direction marks of a pair drawn both ways', () => {
  it('stand apart on two straight parallel lines, each moved toward its own receiver', () => {
    const [there, back] = pair({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 });
    const out = openMidpoint(there, [], true);
    const home = openMidpoint(back, [], true);
    expect(out.point.x).toBeGreaterThan(100);
    expect(home.point.x).toBeLessThan(100);
    expect(gap(out.point, home.point)).toBeGreaterThanOrEqual(16);
    expect(offRoute(there, out.point)).toBeCloseTo(0);
    expect(offRoute(back, home.point)).toBeCloseTo(0);
    expect(Math.abs(out.angle - home.angle)).toBe(180);
  });

  it('stand apart on the two lanes of an elbow out of a lead and back', () => {
    const [there, back] = pair({ id: 'lead', x: 0, y: 0 }, { id: 'other', x: -120, y: -220 }, [
      'lead',
    ]);
    const out = openMidpoint(there, [], true);
    const home = openMidpoint(back, [], true);
    expect(gap(out.point, home.point)).toBeGreaterThanOrEqual(16);
    expect(offRoute(there, out.point)).toBeCloseTo(0);
    expect(offRoute(back, home.point)).toBeCloseTo(0);
  });

  it('stay inside the stretch no agent covers when that stretch is short', () => {
    const [there, back] = pair({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 });
    const covered: StageRect[] = [
      { x0: -40, y0: -40, x1: 92, y1: 40 },
      { x0: 108, y0: -40, x1: 240, y1: 40 },
    ];
    for (const route of [there, back]) {
      const { point } = openMidpoint(route, covered, true);
      expect(point.x).toBeGreaterThan(92);
      expect(point.x).toBeLessThan(108);
    }
  });

  it('leaves the mark of a relation drawn one way in the middle of its open stretch', () => {
    const [there] = pair({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 });
    expect(openMidpoint(there, []).point.x).toBeCloseTo(100);
  });
});
