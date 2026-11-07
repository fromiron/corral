import type { RunAgentGraph } from './agent-graph.ts';

export interface AgentGraphPosition {
  x: number;
  y: number;
}

/** Observed neighbors share a cluster. Already placed agents never move on live updates. */
export function layoutRunAgents(
  graph: RunAgentGraph,
  previous: ReadonlyMap<string, AgentGraphPosition> = new Map(),
): Map<string, AgentGraphPosition> {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const placed = new Map([...previous].filter(([id]) => ids.has(id)));
  const neighbors = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  for (const relation of graph.relations) {
    if (relation.source === relation.target) continue;
    neighbors.get(relation.source)?.add(relation.target);
    neighbors.get(relation.target)?.add(relation.source);
  }
  if (!placed.size) {
    const remaining = new Set(ids);
    let cluster = 0;
    while (remaining.size) {
      const first = remaining.values().next().value as string;
      const component = new Set([first]);
      for (const id of component)
        for (const neighbor of neighbors.get(id) ?? []) component.add(neighbor);
      const centerId = graph.nodes.find((node) => component.has(node.id) && node.lead)?.id ?? first;
      const center = { x: (cluster % 2) * 920, y: Math.floor(cluster / 2) * 800 };
      placed.set(centerId, center);
      const orbit = [...component].filter((id) => id !== centerId);
      for (let offset = 0; offset < orbit.length; offset += 8) {
        const ring = orbit.slice(offset, offset + 8);
        const radius = 230 + (offset / 8) * 210;
        ring.forEach((id, index) => {
          const angle = -Math.PI / 2 + (index * Math.PI * 2) / ring.length;
          placed.set(id, {
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius,
          });
        });
      }
      for (const id of component) remaining.delete(id);
      cluster++;
    }
    return placed;
  }
  for (const node of graph.nodes) {
    if (placed.has(node.id)) continue;
    const neighbor = [...(neighbors.get(node.id) ?? [])].find((id) => placed.has(id));
    const anchor = (neighbor ? placed.get(neighbor) : null) ?? { x: 0, y: 0 };
    // Search expanding rings around a recorded neighbor, leaving existing positions intact.
    for (let slot = 0; ; slot++) {
      const angle = -Math.PI / 2 + ((slot % 8) * Math.PI) / 4;
      const radius = 230 + Math.floor(slot / 8) * 210;
      const point = {
        x: anchor.x + Math.cos(angle) * radius,
        y: anchor.y + Math.sin(angle) * radius,
      };
      if (
        [...placed.values()].some(
          (value) => Math.abs(value.x - point.x) < 185 && Math.abs(value.y - point.y) < 170,
        )
      )
        continue;
      placed.set(node.id, point);
      break;
    }
  }
  return placed;
}
