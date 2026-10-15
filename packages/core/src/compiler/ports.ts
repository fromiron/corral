import type { CorralNode, DecisionNode, SourcePort, TargetPort } from '@corral/contracts';

// The single port table (specs/001-canvas/spec.md). The canvas uses it to offer and refuse
// connections; the compiler uses it to validate them. Both must agree.

export const DECISION_PORTS: Record<DecisionNode['mode'], SourcePort[]> = {
  review: ['pass', 'revise'],
  approval: ['approve', 'reject'],
  rule: ['yes', 'no'],
};

/** Branches that must be connected. Approval `reject` and review `inconclusive` are built in. */
export const REQUIRED_BRANCHES: Record<DecisionNode['mode'], SourcePort[]> = {
  review: ['pass', 'revise'],
  approval: ['approve'],
  rule: ['yes', 'no'],
};

export const DECISION_RULE: Record<DecisionNode['mode'], DecisionNode['rule']> = {
  review: 'review_verdict',
  approval: 'human_approval',
  rule: 'required_tasks_submitted',
};

export function outputPortsOf(node: CorralNode): SourcePort[] {
  switch (node.type) {
    case 'agent':
      return node.invocation === 'scheduled' ? ['out'] : [];
    case 'decision':
      return DECISION_PORTS[node.mode];
    case 'loop':
      return ['body', 'next'];
    case 'output':
      return [];
  }
}

export function inputPortsOf(node: CorralNode): TargetPort[] {
  switch (node.type) {
    case 'agent':
      return node.invocation === 'scheduled' ? ['in'] : [];
    case 'decision':
    case 'output':
      return ['in'];
    case 'loop':
      return ['enter', 'repeat', 'exit'];
  }
}

const loopOf = (node: CorralNode) => ('loopId' in node && node.loopId ? node.loopId : null);

/**
 * Loop boundary rule (Spec §5.3): from outside only into "enter", from inside only into
 * "repeat"/"exit"; "body" leads inside and "next" leads outside; other edges stay on one side.
 * Returns why the edge is not allowed, or null.
 */
export function loopBoundaryViolation(
  source: CorralNode,
  sourcePort: SourcePort,
  target: CorralNode,
  targetPort: TargetPort,
): string | null {
  if (target.type === 'loop') {
    const fromInside = loopOf(source) === target.id;
    if (targetPort === 'enter' && fromInside) return '"enter" is reached from outside the Loop';
    if (targetPort !== 'enter' && !fromInside)
      return `"${targetPort}" is reached from inside the Loop`;
    return null;
  }
  if (source.type === 'loop') {
    const toInside = loopOf(target) === source.id;
    if (sourcePort === 'body' && !toInside) return '"body" must lead to a node inside the Loop';
    if (sourcePort === 'next' && toInside) return '"next" must lead outside the Loop';
    return null;
  }
  if (loopOf(source) !== loopOf(target)) {
    return 'connections cross the Loop boundary only through its ports';
  }
  return null;
}
