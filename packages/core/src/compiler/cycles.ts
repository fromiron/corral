import type { CorralNode } from '@corral/contracts';
import { type EdgeEnds, isBox } from './ports.ts';

// Same virtual graph as the compiler: a box is B#in (enter → body) and B#out (exit → next,
// exhausted), with B#in → B#out between them; edges into "repeat" are the only allowed back edges.

/** The vertex an edge end stands for in the virtual graph. */
export function vertexOf(
  nodes: ReadonlyMap<string, CorralNode>,
  id: string,
  port: string,
  side: 'source' | 'target',
): string {
  if (!isBox(nodes.get(id))) return id;
  const out = side === 'source' ? port === 'next' || port === 'exhausted' : port === 'exit';
  return `${id}#${out ? 'out' : 'in'}`;
}

/** True when adding `candidate` would close a cycle that does not go through a Loop repeat. */
export function wouldCreateCycle(
  nodes: readonly CorralNode[],
  edges: readonly EdgeEnds[],
  candidate: EdgeEnds,
): boolean {
  if (candidate.targetPort === 'repeat') return false;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string) =>
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  for (const node of nodes) if (isBox(node)) link(`${node.id}#in`, `${node.id}#out`);
  for (const edge of edges) {
    if (edge.targetPort === 'repeat') continue;
    link(
      vertexOf(byId, edge.source, edge.sourcePort, 'source'),
      vertexOf(byId, edge.target, edge.targetPort, 'target'),
    );
  }
  const start = vertexOf(byId, candidate.target, candidate.targetPort, 'target');
  const goal = vertexOf(byId, candidate.source, candidate.sourcePort, 'source');
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
