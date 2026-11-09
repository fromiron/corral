import type {
  CorralNode,
  DecisionNode,
  DecisionRule,
  LoopNode,
  TargetPort,
  TeamNode,
} from '@corral/contracts';

// The single port table (docs/specs/features/team-graph.md). The canvas uses it to offer and
// refuse connections; the compiler uses it to validate them. Both must agree.

type FixedMode = Exclude<DecisionNode['mode'], 'router'>;
type RuleMode = Extract<DecisionNode, { rule: DecisionRule }>['mode'];

export const DECISION_PORTS: Record<FixedMode, string[]> = {
  review: ['pass', 'revise'],
  approval: ['approve', 'reject'],
  rule: ['yes', 'no'],
  check: ['pass', 'fail'],
};

/** Branches that are expected to be connected. Approval `reject` ends the Run when unconnected. */
export const REQUIRED_BRANCHES: Record<FixedMode, string[]> = {
  review: ['pass', 'revise'],
  approval: ['approve'],
  rule: ['yes', 'no'],
  check: ['pass', 'fail'],
};

export const DECISION_RULE: Record<RuleMode, DecisionRule> = {
  review: 'review_verdict',
  approval: 'human_approval',
  rule: 'required_tasks_submitted',
};

/** A router has one outgoing port per route id. */
export function decisionPortsOf(node: DecisionNode): string[] {
  return node.mode === 'router' ? node.routes.map((r) => r.id) : DECISION_PORTS[node.mode];
}

export function requiredBranchesOf(node: DecisionNode): string[] {
  return node.mode === 'router' ? node.routes.map((r) => r.id) : REQUIRED_BRANCHES[node.mode];
}

export type BoxNode = LoopNode | TeamNode;

/** Loops and Teams hold other nodes. */
export function isBox(node: CorralNode | undefined): node is BoxNode {
  return node?.type === 'loop' || node?.type === 'team';
}

export function outputPortsOf(node: CorralNode): string[] {
  switch (node.type) {
    case 'agent':
      return node.invocation === 'scheduled' ? ['out', 'error'] : [];
    case 'decision':
      return decisionPortsOf(node);
    case 'loop':
      return ['body', 'next', 'exhausted'];
    case 'team':
      return ['body', 'next'];
    case 'join':
      return ['out'];
    case 'output':
      return [];
  }
}

export function inputPortsOf(node: CorralNode): TargetPort[] {
  switch (node.type) {
    case 'agent':
      return node.invocation === 'scheduled' ? ['in'] : [];
    case 'decision':
    case 'join':
    case 'output':
      return ['in'];
    case 'loop':
      return ['enter', 'repeat', 'exit'];
    case 'team':
      return ['enter', 'exit'];
  }
}

export interface EdgeEnds {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

type Nodes = ReadonlyMap<string, CorralNode>;

/** The box an edge leaves from: inside the box for `body`, beside the node otherwise. */
export function sourceSide(nodes: Nodes, edge: EdgeEnds): string | null {
  const node = nodes.get(edge.source);
  if (isBox(node) && edge.sourcePort === 'body') return node.id;
  return node?.parentId ?? null;
}

/** The box an edge arrives in: inside the box for `exit`/`repeat`, beside the node otherwise. */
export function targetSide(nodes: Nodes, edge: EdgeEnds): string | null {
  const node = nodes.get(edge.target);
  if (isBox(node) && (edge.targetPort === 'exit' || edge.targetPort === 'repeat')) return node.id;
  return node?.parentId ?? null;
}

/** True when `box` is `ancestor` or sits somewhere inside it. */
export function isWithin(nodes: Nodes, box: string | null, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at = box; at && !seen.has(at); at = nodes.get(at)?.parentId ?? null) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

const boxName = (node: BoxNode) => (node.type === 'loop' ? 'Loop' : 'Team');

/**
 * Box boundary rule: edges stay inside one box, except `body` into the box, `enter` from beside
 * it, and `exit`/`repeat` from anywhere inside it (several boxes may be left at once).
 * Returns why the edge is not allowed, or null.
 */
export function boxBoundaryViolation(nodes: Nodes, edge: EdgeEnds): string | null {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return null;
  const from = sourceSide(nodes, edge);
  const to = targetSide(nodes, edge);
  if (isBox(target) && (edge.targetPort === 'exit' || edge.targetPort === 'repeat')) {
    return isWithin(nodes, from, target.id)
      ? null
      : `"${edge.targetPort}" is reached from inside the ${boxName(target)}`;
  }
  if (isBox(source) && edge.sourcePort === 'body') {
    return to === source.id && target.id !== source.id
      ? null
      : `"body" leads to a node directly inside the ${boxName(source)}`;
  }
  if (from === to) return null;
  if (isBox(target) && edge.targetPort === 'enter' && isWithin(nodes, from, target.id))
    return `"enter" is reached from outside the ${boxName(target)}`;
  if (isBox(source) && (edge.sourcePort === 'next' || edge.sourcePort === 'exhausted'))
    return `"${edge.sourcePort}" leads to a step beside the ${boxName(source)}`;
  return 'connections cross a box boundary only through its ports';
}
