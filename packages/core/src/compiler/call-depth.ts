import type { CapabilityLink, CorralNode } from '@corral/contracts';

/** The least dynamic execution depth needed to reach each worker. Advice has no call depth. */
export function workerDepths(
  nodes: readonly CorralNode[],
  links: readonly CapabilityLink[],
  reached?: ReadonlySet<string>,
  questionBudget = Number.POSITIVE_INFINITY,
): Map<string, number> {
  const depths = new Map<string, number>();
  const callable = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'agent') continue;
    if (node.invocation === 'callable') callable.add(node.id);
    if (node.invocation === 'scheduled' && (!reached || reached.has(node.id)))
      depths.set(node.id, 0);
  }
  // Breadth-first gives the minimum depth. A longer route that spends fewer questions
  // can still reach a downstream worker when the shorter route exhausts its quota.
  const queue = [...depths.keys()].map((nodeId) => ({ nodeId, depth: 0, questions: 0 }));
  const leastQuestions = new Map(depths);
  for (const { nodeId, depth, questions } of queue) {
    for (const link of links) {
      if (
        link.sourceNodeId !== nodeId ||
        link.kind === 'advise' ||
        !callable.has(link.targetNodeId)
      )
        continue;
      const spent = questions + Number(Number.isFinite(questionBudget) && link.kind === 'question');
      if (spent > questionBudget || spent >= (leastQuestions.get(link.targetNodeId) ?? Infinity))
        continue;
      leastQuestions.set(link.targetNodeId, spent);
      if (!depths.has(link.targetNodeId)) depths.set(link.targetNodeId, depth + 1);
      queue.push({ nodeId: link.targetNodeId, depth: depth + 1, questions: spent });
    }
  }
  return depths;
}
