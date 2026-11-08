import type { CapabilityLink, ControlEdge, CorralDefinition, CorralNode } from '@corral/contracts';
import { isBox, outputPortsOf } from '@corral/core';

// Automatic layout for the team editor (docs/specs/features/team-graph.md). Nobody places nodes:
// each box lays out its own members in layers from left to right, sizes itself around them and
// takes part in its parent's layout as one item. Chains stay on one line; a fan-out or a
// decision's branches stack below it. Callable agents sit in a row under the flow.

export const GEOMETRY = {
  node: { w: 216, h: 76 },
  join: { w: 128, h: 40 },
  tile: { w: 216, h: 76 },
  gapX: 72,
  gapY: 32,
  padX: 24,
  head: 44,
  padBottom: 44,
  emptyBox: { w: 240, h: 72 },
  callGap: 64,
} as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidItem {
  id: string;
  /** `box` is an open Loop or Team; `tile` is a collapsed one drawn like a node. */
  kind: 'node' | 'box' | 'tile';
  rect: Rect;
  /** Where the box's main line runs, for its enter, body, exit and next ports. */
  mainY: number;
  depth: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LaidEdge {
  id: string;
  kind: 'control' | 'call';
  /** The drawn ends: a node hidden in a collapsed box is drawn at that box's tile. */
  from: string;
  to: string;
  path: string;
  arrow: boolean;
  /** Where to drop a new step on this connection, or null when it cannot take one. */
  insertAt: Point | null;
  label?: { text: string; at: Point };
}

export interface PortMark {
  nodeId: string;
  port: string;
  side: 'in' | 'out';
  at: Point;
}

export interface TeamLayout {
  items: Map<string, LaidItem>;
  edges: LaidEdge[];
  ports: PortMark[];
  bounds: Rect;
}

interface Measured {
  w: number;
  h: number;
  /** Offset of the main line from the top. */
  main: number;
  place(x: number, y: number): void;
}

export function layoutTeam(
  definition: Pick<CorralDefinition, 'nodes' | 'controlEdges' | 'capabilityLinks' | 'entryNodeId'>,
  collapsed: ReadonlySet<string> = new Set(),
): TeamLayout {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const order = new Map(definition.nodes.map((n, i) => [n.id, i]));
  const parentOf = (id: string) => nodes.get(id)?.parentId ?? null;
  const callable = (n: CorralNode | undefined) =>
    n?.type === 'agent' && n.invocation === 'callable';
  const items = new Map<string, LaidItem>();

  /** The outermost collapsed box that hides `id`, or `id` itself. */
  const shownAs = (id: string) => {
    let shown = id;
    const seen = new Set<string>();
    for (let at = parentOf(id); at && !seen.has(at); at = parentOf(at)) {
      seen.add(at);
      if (collapsed.has(at)) shown = at;
    }
    return shown;
  };
  /** The member of `container` that holds `id` (or is `id`), or null when `id` is outside it. */
  const memberOf = (id: string, container: string | null) => {
    const seen = new Set<string>();
    for (let at: string | null = id; at && !seen.has(at); at = parentOf(at)) {
      seen.add(at);
      if (parentOf(at) === container) return at;
    }
    return null;
  };
  const depthOf = (id: string) => {
    let depth = 0;
    const seen = new Set<string>();
    for (let at = parentOf(id); at && !seen.has(at); at = parentOf(at)) {
      seen.add(at);
      depth += 1;
    }
    return depth;
  };

  const measureItem = (id: string): Measured => {
    const node = nodes.get(id) as CorralNode;
    const depth = depthOf(id);
    if (isBox(node) && !collapsed.has(id)) {
      const inner = measureContainer(id);
      const empty = inner.w === 0;
      const w = (empty ? GEOMETRY.emptyBox.w : inner.w) + GEOMETRY.padX * 2;
      const h = GEOMETRY.head + (empty ? GEOMETRY.emptyBox.h : inner.h) + GEOMETRY.padBottom;
      const main = GEOMETRY.head + (empty ? GEOMETRY.emptyBox.h / 2 : inner.main);
      return {
        w,
        h,
        main,
        place(x, y) {
          items.set(id, { id, kind: 'box', rect: { x, y, w, h }, mainY: y + main, depth });
          inner.place(x + GEOMETRY.padX, y + GEOMETRY.head);
        },
      };
    }
    const size = node.type === 'join' ? GEOMETRY.join : isBox(node) ? GEOMETRY.tile : GEOMETRY.node;
    return {
      w: size.w,
      h: size.h,
      main: size.h / 2,
      place(x, y) {
        items.set(id, {
          id,
          kind: isBox(node) ? 'tile' : 'node',
          rect: { x, y, w: size.w, h: size.h },
          mainY: y + size.h / 2,
          depth,
        });
      },
    };
  };

  function measureContainer(container: string | null): Measured {
    const members = definition.nodes.filter(
      (n) => (n.parentId ?? null) === container && !callable(n),
    );
    if (members.length === 0) return { w: 0, h: 0, main: 0, place() {} };
    const ids = members.map((n) => n.id);
    const next = new Map(ids.map((id) => [id, new Set<string>()]));
    const prev = new Map(ids.map((id) => [id, new Set<string>()]));
    const firsts = new Set<string>();
    for (const edge of definition.controlEdges) {
      if (edge.targetPort === 'repeat') continue;
      if (edge.source === container && edge.sourcePort === 'body') {
        const first = memberOf(edge.target, container);
        if (first) firsts.add(first);
        continue;
      }
      const from = memberOf(edge.source, container);
      const to = memberOf(edge.target, container);
      if (!from || !to || from === to) continue;
      next.get(from)?.add(to);
      prev.get(to)?.add(from);
    }
    if (container === null && nodes.has(definition.entryNodeId)) {
      const entry = memberOf(definition.entryNodeId, null);
      if (entry) firsts.add(entry);
    }

    // Layers: the longest path from a first step. Back edges of an unfinished draft are ignored.
    const rank = new Map<string, number>();
    const state = new Map<string, 'open' | 'done'>();
    const visit = (id: string): number => {
      if (state.get(id) === 'done') return rank.get(id) as number;
      if (state.get(id) === 'open') return -1;
      state.set(id, 'open');
      let r = 0;
      for (const p of prev.get(id) ?? []) {
        const pr = visit(p);
        if (pr >= 0) r = Math.max(r, pr + 1);
      }
      state.set(id, 'done');
      rank.set(id, r);
      return r;
    };
    for (const id of ids) visit(id);

    // Rows: each step keeps the row of its first predecessor; branches stack below it.
    const byRank = new Map<number, string[]>();
    for (const id of ids)
      byRank.set(rank.get(id) as number, [...(byRank.get(rank.get(id) as number) ?? []), id]);
    const row = new Map<string, number>();
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    for (const r of ranks) {
      const layer = byRank.get(r) as string[];
      const desired = (id: string) => {
        const rows = [...(prev.get(id) ?? [])]
          .map((p) => row.get(p))
          .filter((v) => v !== undefined);
        if (rows.length) return Math.min(...(rows as number[]));
        return firsts.has(id) ? -1 : Number.POSITIVE_INFINITY;
      };
      const branchIndex = (id: string) => {
        // A decision's branches keep the port order: pass above revise, approve above reject.
        let best = Number.POSITIVE_INFINITY;
        for (const edge of definition.controlEdges) {
          if (memberOf(edge.target, container) !== id) continue;
          const source = nodes.get(edge.source);
          if (!source) continue;
          const index = outputPortsOf(source).indexOf(edge.sourcePort);
          if (index >= 0) best = Math.min(best, index);
        }
        return best;
      };
      layer.sort(
        (a, b) =>
          desired(a) - desired(b) ||
          branchIndex(a) - branchIndex(b) ||
          (order.get(a) ?? 0) - (order.get(b) ?? 0),
      );
      let floor = 0;
      for (const id of layer) {
        const want = desired(id);
        const at = Math.max(floor, Number.isFinite(want) ? Math.max(0, want) : floor);
        row.set(id, at);
        floor = at + 1;
      }
    }

    const measured = new Map(ids.map((id) => [id, measureItem(id)]));
    const rowCount = Math.max(...ids.map((id) => row.get(id) as number)) + 1;
    const colWidth = ranks.map((r) =>
      Math.max(...(byRank.get(r) as string[]).map((id) => (measured.get(id) as Measured).w)),
    );
    const rowMain = Array.from({ length: rowCount }, (_, i) =>
      Math.max(
        0,
        ...ids.filter((id) => row.get(id) === i).map((id) => (measured.get(id) as Measured).main),
      ),
    );
    const rowHeight = Array.from({ length: rowCount }, (_, i) =>
      Math.max(
        GEOMETRY.node.h,
        ...ids
          .filter((id) => row.get(id) === i)
          .map((id) => {
            const m = measured.get(id) as Measured;
            return (rowMain[i] ?? 0) - m.main + m.h;
          }),
      ),
    );
    const colX: number[] = [];
    let x = 0;
    for (const [i] of ranks.entries()) {
      colX[i] = x;
      x += (colWidth[i] as number) + GEOMETRY.gapX;
    }
    const rowY: number[] = [];
    let y = 0;
    for (let i = 0; i < rowCount; i++) {
      rowY[i] = y;
      y += (rowHeight[i] as number) + GEOMETRY.gapY;
    }
    const w = x - GEOMETRY.gapX;
    const h = y - GEOMETRY.gapY;
    return {
      w,
      h,
      main: rowMain[0] ?? 0,
      place(ox, oy) {
        for (const id of ids) {
          const m = measured.get(id) as Measured;
          const c = ranks.indexOf(rank.get(id) as number);
          const r = row.get(id) as number;
          m.place(
            ox + (colX[c] as number) + ((colWidth[c] as number) - m.w) / 2,
            oy + (rowY[r] as number) + (rowMain[r] as number) - m.main,
          );
        }
      },
    };
  }

  const root = measureContainer(null);
  root.place(0, 0);

  // Callable agents: one row under the flow, each near the first agent that calls it.
  const callables = definition.nodes.filter(callable);
  const callerX = (id: string) => {
    const link = definition.capabilityLinks.find((l) => l.targetNodeId === id);
    const caller = link ? items.get(shownAs(link.sourceNodeId)) : undefined;
    return caller ? caller.rect.x : Number.POSITIVE_INFINITY;
  };
  const rowTop = (root.h || 0) + (root.h ? GEOMETRY.callGap : 0);
  let nextX = 0;
  for (const node of [...callables].sort(
    (a, b) => callerX(a.id) - callerX(b.id) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  )) {
    const want = callerX(node.id);
    const x = Math.max(nextX, Number.isFinite(want) ? want : nextX);
    const { w, h } = GEOMETRY.node;
    items.set(node.id, {
      id: node.id,
      kind: 'node',
      rect: { x, y: rowTop, w, h },
      mainY: rowTop + h / 2,
      depth: 0,
    });
    nextX = x + w + GEOMETRY.padX;
  }

  const { edges, ports } = routeTeam(definition, items, collapsed);
  return { items, edges, ports, bounds: boundsOf(items) };
}

/** Where the items reach: the area to fit in view. */
export function boundsOf(items: ReadonlyMap<string, LaidItem>): Rect {
  const rects = [...items.values()].map((i) => i.rect);
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

/**
 * Ports and connection routes for items already placed. Kept apart from placement so a
 * relayout can redraw the connections at every frame while the items move.
 */
export function routeTeam(
  definition: Pick<CorralDefinition, 'nodes' | 'controlEdges' | 'capabilityLinks'>,
  items: ReadonlyMap<string, LaidItem>,
  collapsed: ReadonlySet<string> = new Set(),
): { edges: LaidEdge[]; ports: PortMark[] } {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const shownAs = (id: string) => {
    let shown = id;
    const seen = new Set<string>();
    for (let at = nodes.get(id)?.parentId; at && !seen.has(at); at = nodes.get(at)?.parentId) {
      seen.add(at);
      if (collapsed.has(at)) shown = at;
    }
    return shown;
  };
  const ports = portsOf(definition, items, shownAs);
  const edges = [
    ...definition.controlEdges.flatMap((edge) => routeControl(edge, nodes, items, shownAs, ports)),
    ...definition.capabilityLinks.flatMap((link) => routeCall(link, items, shownAs)),
  ];
  return { edges, ports: [...ports.values()] };
}

// ── ports and routes ──────────────────────────────────────────────────────────

const portKey = (nodeId: string, port: string, side: 'in' | 'out') =>
  `${nodeId}\u0000${port}\u0000${side}`;

function portsOf(
  definition: Pick<CorralDefinition, 'nodes'>,
  items: ReadonlyMap<string, LaidItem>,
  shownAs: (id: string) => string,
): Map<string, PortMark> {
  const marks = new Map<string, PortMark>();
  const mark = (nodeId: string, port: string, side: 'in' | 'out', at: Point) =>
    marks.set(portKey(nodeId, port, side), { nodeId, port, side, at });
  for (const node of definition.nodes) {
    const item = items.get(node.id);
    if (!item || shownAs(node.id) !== node.id) continue;
    const { x, y, w, h } = item.rect;
    if (item.kind === 'box') {
      mark(node.id, 'enter', 'in', { x, y: item.mainY });
      mark(node.id, 'body', 'out', { x: x + 10, y: item.mainY });
      mark(node.id, 'exit', 'in', { x: x + w - 10, y: item.mainY });
      if (node.type === 'loop') mark(node.id, 'repeat', 'in', { x: x + 10, y: y + h - 18 });
      mark(node.id, 'next', 'out', { x: x + w, y: item.mainY });
      if (node.type === 'loop') mark(node.id, 'exhausted', 'out', { x: x + w - 28, y: y + h });
      continue;
    }
    if (item.kind === 'tile') {
      mark(node.id, 'enter', 'in', { x, y: y + h / 2 });
      mark(node.id, 'next', 'out', { x: x + w, y: y + h / 2 });
      if (node.type === 'loop') mark(node.id, 'exhausted', 'out', { x: x + w - 28, y: y + h });
      continue;
    }
    if (
      !(node.type === 'agent' && node.invocation === 'callable') &&
      node.type !== 'loop' &&
      node.type !== 'team'
    )
      mark(node.id, 'in', 'in', { x, y: y + h / 2 });
    if (node.type === 'agent') {
      if (node.invocation === 'callable') continue;
      mark(node.id, 'out', 'out', { x: x + w, y: y + h / 2 });
      mark(node.id, 'error', 'out', { x: x + w - 28, y: y + h });
      continue;
    }
    const outs = outputPortsOf(node);
    for (const [i, port] of outs.entries())
      mark(node.id, port, 'out', { x: x + w, y: y + (h * (i + 1)) / (outs.length + 1) });
  }
  return marks;
}

function elbow(a: Point, b: Point, midX?: number): string {
  if (Math.abs(a.y - b.y) < 1) return `M${a.x} ${a.y} H${b.x}`;
  const mx = midX ?? a.x + Math.max(16, (b.x - a.x) / 2);
  const r = Math.min(10, Math.abs(b.y - a.y) / 2, Math.abs(mx - a.x), Math.abs(b.x - mx));
  const s = b.y > a.y ? 1 : -1;
  const dx1 = mx >= a.x ? 1 : -1;
  const dx2 = b.x >= mx ? 1 : -1;
  return `M${a.x} ${a.y} H${mx - dx1 * r} Q${mx} ${a.y} ${mx} ${a.y + s * r} V${b.y - s * r} Q${mx} ${b.y} ${mx + dx2 * r} ${b.y} H${b.x}`;
}

/** Down from a bottom port to a lane, along it, then into the target from the left. */
function underRoute(a: Point, lane: number, b: Point): string {
  const r = 10;
  const tx = b.x - 24;
  const up = b.y < lane ? -1 : 1;
  return `M${a.x} ${a.y} V${lane - r} Q${a.x} ${lane} ${a.x + r} ${lane} H${tx - r} Q${tx} ${lane} ${tx} ${lane + up * r} V${b.y - up * r} Q${tx} ${b.y} ${tx + r} ${b.y} H${b.x}`;
}

function routeControl(
  edge: ControlEdge,
  nodes: Map<string, CorralNode>,
  items: ReadonlyMap<string, LaidItem>,
  shownAs: (id: string) => string,
  ports: Map<string, PortMark>,
): LaidEdge[] {
  const from = shownAs(edge.source);
  const to = shownAs(edge.target);
  if (from === to) return [];
  const source = items.get(from);
  const target = items.get(to);
  if (!source || !target) return [];
  const exact = (nodeId: string, port: string, side: 'in' | 'out') =>
    ports.get(portKey(nodeId, port, side))?.at;
  const a = (from === edge.source ? exact(edge.source, edge.sourcePort, 'out') : undefined) ?? {
    x: source.rect.x + source.rect.w,
    y: source.mainY,
  };
  const b = (to === edge.target ? exact(edge.target, edge.targetPort, 'in') : undefined) ?? {
    x: target.rect.x,
    y: target.mainY,
  };
  const fromBottom =
    from === edge.source && (edge.sourcePort === 'error' || edge.sourcePort === 'exhausted');
  let path: string;
  let insertAt: Point | null = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (to === edge.target && edge.targetPort === 'repeat' && target.kind === 'box') {
    // Round again: out to the right, down under the body, back to the start of the loop.
    const lane = target.rect.y + target.rect.h - 18;
    const turn = a.x + 14;
    const r = 8;
    const left = target.rect.x + 10;
    path = `M${a.x} ${a.y} H${turn - r} Q${turn} ${a.y} ${turn} ${a.y + r} V${lane - r} Q${turn} ${lane} ${turn - r} ${lane} H${left + r} Q${left} ${lane} ${left} ${lane - r} V${target.mainY}`;
    insertAt = null;
  } else if (fromBottom) {
    // Under every box the connection leaves, so it never crosses that box's content.
    const holds = (box: string, id: string) => {
      const seen = new Set<string>();
      for (let at: string | undefined = id; at && !seen.has(at); at = nodes.get(at)?.parentId) {
        if (at === box) return true;
        seen.add(at);
      }
      return false;
    };
    const left: number[] = [];
    for (let at = nodes.get(edge.source)?.parentId; at; at = nodes.get(at)?.parentId) {
      const box = items.get(at);
      if (box?.kind === 'box' && !holds(at, edge.target)) left.push(box.rect.y + box.rect.h);
      if (left.length > 32) break;
    }
    const lane = Math.max(source.rect.y + source.rect.h, ...left) + 18;
    path = underRoute(a, lane, b);
    insertAt = { x: a.x, y: lane };
  } else if (to === edge.target && edge.targetPort === 'exit') {
    path = elbow(a, b, a.x + (b.x - a.x) / 2);
  } else if (from === edge.source && edge.sourcePort === 'body') {
    path = elbow(a, b, a.x + 4);
  } else {
    path = elbow(a, b);
  }
  return [
    {
      id: edge.id,
      kind: 'control',
      from,
      to,
      path,
      arrow: !(to === edge.target && (edge.targetPort === 'exit' || edge.targetPort === 'repeat')),
      insertAt,
    },
  ];
}

function routeCall(
  link: CapabilityLink,
  items: ReadonlyMap<string, LaidItem>,
  shownAs: (id: string) => string,
): LaidEdge[] {
  const from = shownAs(link.sourceNodeId);
  const to = shownAs(link.targetNodeId);
  const source = items.get(from);
  const target = items.get(to);
  if (!source || !target || from === to) return [];
  const beside =
    target.rect.y < source.rect.y + source.rect.h && source.rect.y < target.rect.y + target.rect.h;
  if (beside) {
    // Side by side, as callables in their row are: from one side across to the other.
    const rightward = target.rect.x >= source.rect.x;
    const a = {
      x: rightward ? source.rect.x + source.rect.w : source.rect.x,
      y: source.rect.y + source.rect.h / 2,
    };
    const b = {
      x: rightward ? target.rect.x : target.rect.x + target.rect.w,
      y: target.rect.y + target.rect.h / 2,
    };
    const bend = Math.max(24, Math.abs(b.x - a.x) / 2) * (rightward ? 1 : -1);
    return [
      {
        id: link.id,
        kind: 'call',
        from,
        to,
        path: `M${a.x} ${a.y} C${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`,
        arrow: true,
        insertAt: null,
        label: { text: link.kind, at: { x: (a.x + b.x) / 2 - 12, y: Math.min(a.y, b.y) - 6 } },
      },
    ];
  }
  const a = { x: source.rect.x + source.rect.w / 2, y: source.rect.y + source.rect.h };
  const b = { x: target.rect.x + target.rect.w / 2, y: target.rect.y };
  const bend = Math.max(24, Math.abs(b.y - a.y) / 2);
  return [
    {
      id: link.id,
      kind: 'call',
      from,
      to,
      path: `M${a.x} ${a.y} C${a.x} ${a.y + bend} ${b.x} ${b.y - bend} ${b.x} ${b.y}`,
      arrow: true,
      insertAt: null,
      label: { text: link.kind, at: { x: (a.x + b.x) / 2 + 8, y: (a.y + b.y) / 2 } },
    },
  ];
}
