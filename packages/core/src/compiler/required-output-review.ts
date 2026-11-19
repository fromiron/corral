import type {
  ControlEdge,
  CorralDefinition,
  CorralNode,
  OutputNode,
  RequiredOutputReview,
} from '@corral/contracts';
import type { Diagnostic } from './index.ts';
import { isBox } from './ports.ts';

interface ReviewContext {
  definition: CorralDefinition;
  nodes: ReadonlyMap<string, CorralNode>;
  outgoing: ReadonlyMap<string, ControlEdge[]>;
  joinBranches: ReadonlyMap<string, { branch: number; width: number }>;
}

/** Can a token reach this Output without taking this review's passing branch? A box's entry,
 * exit and repeat are different states. An all-join waits for every incoming branch. */
function bypassEdge(
  context: ReviewContext,
  outputId: string,
  decisionId: string,
): string | undefined {
  const { definition, nodes, outgoing, joinBranches } = context;
  const queue: { id: string; port: string }[] = [{ id: definition.entryNodeId, port: 'enter' }];
  const visited = new Set<string>();
  const arrivals = new Map<string, Set<number>>();
  for (let i = 0; i < queue.length; i++) {
    const { id, port } = queue[i]!;
    const key = id + '#' + port;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = nodes.get(id);
    for (const e of outgoing.get(id) ?? []) {
      if (isBox(node)) {
        if (node.type === 'team' && node.source.kind === 'reference') {
          if (e.sourcePort !== 'next') continue;
        } else if (port === 'enter' && e.sourcePort !== 'body') continue;
        else if (port === 'exit' && e.sourcePort !== 'next') continue;
        else if (port === 'repeat' && !['body', 'exhausted'].includes(e.sourcePort)) continue;
      }
      if (id === decisionId && e.sourcePort === 'pass') continue;
      if (e.target === outputId) return e.id;
      const target = nodes.get(e.target);
      const arm = joinBranches.get(e.id);
      if (arm && target?.type === 'join' && target.policy === 'all') {
        const seen = arrivals.get(target.id) ?? new Set<number>();
        seen.add(arm.branch);
        arrivals.set(target.id, seen);
        if (seen.size < arm.width) continue;
      }
      queue.push({ id: e.target, port: e.targetPort });
    }
  }
}

function validateGate(
  context: ReviewContext,
  output: OutputNode,
  gate: RequiredOutputReview,
): Diagnostic | undefined {
  const problem = (message: string, id = output.id, edgeId?: string): Diagnostic => ({
    code: 'REQUIRED_OUTPUT_REVIEW',
    severity: 'error',
    message,
    ...(edgeId ? { edgeId } : { nodeId: id }),
  });
  const { definition, nodes: byId } = context;
  const reviewer = byId.get(gate.reviewerNodeId),
    decision = byId.get(gate.decisionNodeId),
    loop = byId.get(gate.loopNodeId);
  const bound = output.inputBindings.find(
    (b) =>
      b.name === gate.bindingName &&
      b.kind === 'task_output' &&
      b.sourceNodeId === gate.sourceNodeId,
  );
  if (!bound) return problem('The required review no longer matches the source of this output.');
  if (
    loop?.type !== 'loop' ||
    reviewer?.type !== 'agent' ||
    reviewer.invocation !== 'scheduled' ||
    reviewer.parentId !== loop.id ||
    definition.roles.find((r) => r.id === reviewer.roleId)?.outputContract !== 'review' ||
    decision?.type !== 'decision' ||
    decision.mode !== 'review' ||
    decision.parentId !== loop.id
  )
    return problem('Restore the required reviewer, review decision and Loop.');
  if (
    !reviewer.inputBindings.some(
      (b) => b.kind === 'task_output' && b.sourceNodeId === gate.sourceNodeId,
    ) ||
    decision.inputBindings.length !== 1 ||
    decision.inputBindings[0]?.kind !== 'task_output' ||
    decision.inputBindings[0]?.sourceNodeId !== reviewer.id
  )
    return problem(
      'The required reviewer must read the candidate and the decision must read the reviewer.',
      decision.id,
    );
  const source = byId.get(gate.sourceNodeId);
  let owner = source;
  const seen = new Set<string>();
  while (owner?.parentId && owner.parentId !== loop.id && !seen.has(owner.id)) {
    seen.add(owner.id);
    owner = byId.get(owner.parentId);
  }
  if (owner?.parentId !== loop.id)
    return problem('The selected producer must run inside the required review Loop.');
  const edge = (from: string, port: string, to: string, targetPort: string) =>
    definition.controlEdges.some(
      (e) =>
        e.source === from &&
        e.sourcePort === port &&
        e.target === to &&
        e.targetPort === targetPort,
    );
  if (
    !edge(loop.id, 'body', owner.id, isBox(owner) ? 'enter' : 'in') ||
    !edge(owner.id, isBox(owner) ? 'next' : 'out', reviewer.id, 'in') ||
    !edge(reviewer.id, 'out', decision.id, 'in') ||
    !edge(decision.id, 'pass', loop.id, 'exit') ||
    !edge(decision.id, 'revise', loop.id, 'repeat')
  )
    return problem(
      'Restore the route from the producer through the reviewer and the pass/revise decision.',
      loop.id,
    );
  // A revision cannot leave through a second exit after a pass in an earlier loop entry.
  const shortcut = definition.controlEdges.find(
    (e) =>
      e.target === loop.id &&
      e.targetPort === 'exit' &&
      !(e.source === decision.id && e.sourcePort === 'pass'),
  );
  if (shortcut)
    return problem(
      'This connection exits the required review without a passing verdict.',
      loop.id,
      shortcut.id,
    );
  const bypass = bypassEdge(context, output.id, decision.id);
  if (bypass)
    return problem(
      'This connection can reach the Output without its required review.',
      output.id,
      bypass,
    );
}

export function requiredOutputReviewDiagnostics(context: ReviewContext): Diagnostic[] {
  return context.definition.nodes.flatMap((n) =>
    n.type === 'output'
      ? (n.requiredReviews ?? []).flatMap((g) => {
          const issue = validateGate(context, n, g);
          return issue ? [issue] : [];
        })
      : [],
  );
}
