import type { ControlEdge, CorralNode, SourcePort, TargetPort } from '@corral/contracts';

// Same virtual graph as the compiler: a Loop is L#in (enter, repeat → body) and L#out
// (exit → next); edges into "repeat" are the only allowed back edges.

interface EdgeLike {
  source: string;
  sourcePort: SourcePort;
  target: string;
  targetPort: TargetPort;
}

function vertex(
  nodes: Map<string, CorralNode>,
  id: string,
  port: string,
  side: 'source' | 'target',
) {
  if (nodes.get(id)?.type !== 'loop') return id;
  const out = side === 'source' ? port === 'next' : port === 'exit';
  return `${id}#${out ? 'out' : 'in'}`;
}

/** True when adding `candidate` would close a cycle that does not go through a Loop repeat. */
export function wouldCreateCycle(
  nodes: readonly CorralNode[],
  edges: readonly ControlEdge[],
  candidate: EdgeLike,
): boolean {
  if (candidate.targetPort === 'repeat') return false;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.targetPort === 'repeat') continue;
    const from = vertex(byId, edge.source, edge.sourcePort, 'source');
    adjacency.set(from, [
      ...(adjacency.get(from) ?? []),
      vertex(byId, edge.target, edge.targetPort, 'target'),
    ]);
  }
  const start = vertex(byId, candidate.target, candidate.targetPort, 'target');
  const goal = vertex(byId, candidate.source, candidate.sourcePort, 'source');
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const v = stack.pop() as string;
    if (v === goal) return true;
    if (seen.has(v)) continue;
    seen.add(v);
    stack.push(...(adjacency.get(v) ?? []));
  }
  return false;
}
