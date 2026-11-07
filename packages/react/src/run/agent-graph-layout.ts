import type { RunAgentGraph } from './agent-graph.ts';

export interface AgentGraphPosition {
  x: number;
  y: number;
}

/**
 * The kit AgentGraph places agents on a staggered grid around the lead: diagonal neighbours
 * sit one column and one row away, so a label never sits under the next agent's mark.
 */
export const LATTICE = { x: 110, y: 80 } as const;
const CLUSTER_GAP = 2;

const key = (i: number, j: number) => `${i},${j}`;
const toPoint = (i: number, j: number) => ({ x: i * LATTICE.x, y: j * LATTICE.y });
const toCell = (point: AgentGraphPosition) => ({
  i: Math.round(point.x / LATTICE.x),
  j: Math.round(point.y / LATTICE.y),
});

/** The free staggered cell nearest the anchor, preferring cells nearer the cluster centre. */
function nearestFree(
  occupied: ReadonlySet<string>,
  anchor: { i: number; j: number },
  center: { i: number; j: number },
): { i: number; j: number } {
  for (let radius = 1; ; radius++) {
    let best: { i: number; j: number; score: number } | null = null;
    for (let i = anchor.i - radius; i <= anchor.i + radius; i++)
      for (let j = anchor.j - radius * 2; j <= anchor.j + radius * 2; j++) {
        if ((i + j) % 2 !== 0 || occupied.has(key(i, j))) continue;
        const near = Math.hypot((i - anchor.i) * LATTICE.x, (j - anchor.j) * LATTICE.y);
        const centre = Math.hypot((i - center.i) * LATTICE.x, (j - center.j) * LATTICE.y);
        const score = near + centre * 0.01;
        if (!best || score < best.score) best = { i, j, score };
      }
    if (best) return best;
  }
}

/** Observed neighbours share a cluster. Already placed agents never move on live updates. */
export function layoutRunAgents(
  graph: RunAgentGraph,
  previous: ReadonlyMap<string, AgentGraphPosition> = new Map(),
): Map<string, AgentGraphPosition> {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const placed = new Map([...previous].filter(([id]) => ids.has(id)));
  const neighbors = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const relation of graph.relations) {
    if (relation.source === relation.target) continue;
    neighbors.get(relation.source)?.push(relation.target);
    neighbors.get(relation.target)?.push(relation.source);
  }
  const occupied = new Set(
    [...placed.values()].map((point) => toCell(point)).map((c) => key(c.i, c.j)),
  );
  const place = (id: string, cell: { i: number; j: number }) => {
    occupied.add(key(cell.i, cell.j));
    placed.set(id, toPoint(cell.i, cell.j));
  };
  // Each new node joins next to a placed neighbour; a new cluster starts right of the rest.
  const rightEdge = () =>
    Math.max(-CLUSTER_GAP, ...[...placed.values()].map((point) => toCell(point).i));
  const remaining = graph.nodes.filter((node) => !placed.has(node.id)).map((node) => node.id);
  while (remaining.length) {
    const anchored = remaining.find((id) => neighbors.get(id)?.some((other) => placed.has(other)));
    const leadFirst = graph.nodes.find((node) => node.lead && remaining.includes(node.id))?.id;
    const id = anchored ?? leadFirst ?? (remaining[0] as string);
    remaining.splice(remaining.indexOf(id), 1);
    const neighbor = neighbors.get(id)?.find((other) => placed.has(other));
    if (neighbor) {
      const anchor = toCell(placed.get(neighbor) as AgentGraphPosition);
      const lead = graph.nodes.find(
        (node) => node.lead && placed.has(node.id) && neighbors.get(id)?.includes(node.id),
      );
      place(
        id,
        nearestFree(
          occupied,
          anchor,
          lead ? toCell(placed.get(lead.id) as AgentGraphPosition) : anchor,
        ),
      );
    } else {
      // Keep the stagger parity: cluster centres sit on even columns.
      const i = placed.size ? rightEdge() + CLUSTER_GAP * 2 : 0;
      place(id, { i: i % 2 === 0 ? i : i + 1, j: 0 });
    }
  }
  return placed;
}
