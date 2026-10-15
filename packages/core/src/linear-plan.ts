import type { ControlEdge, CorralDefinition, CorralNode } from '@corral/contracts';

// P0 runner plan: scheduled Agent → … → Agent → Output, following the drawn control edges.
// Loop/Decision execution arrives with the LangGraph GraphRunner (C-014); until then such
// graphs are rejected with the node named, never run in some other order.

export interface PlanIssue {
  code: 'GRAPH_INVALID';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export type LinearPlan =
  | { ok: true; agentNodeIds: string[]; outputNodeId: string }
  | { ok: false; issues: PlanIssue[] };

export function planLinearRun(definition: CorralDefinition): LinearPlan {
  const issues: PlanIssue[] = [];
  const issue = (message: string, at: { nodeId?: string; edgeId?: string } = {}) =>
    issues.push({ code: 'GRAPH_INVALID', message, ...at });

  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const roles = new Set(definition.roles.map((role) => role.id));

  for (const node of definition.nodes) {
    if (node.type === 'loop' || node.type === 'decision') {
      issue(`${node.type} nodes are not supported by the P0 runner yet`, { nodeId: node.id });
    }
    if (node.type === 'agent' && !roles.has(node.roleId)) {
      issue(`unknown role ${node.roleId}`, { nodeId: node.id });
    }
  }
  for (const edge of definition.controlEdges) checkEdge(edge, nodes, issue);
  if (issues.length > 0) return { ok: false, issues };

  const entry = nodes.get(definition.entryNodeId);
  if (entry?.type !== 'agent' || entry.invocation !== 'scheduled') {
    issue('the entry node must be a scheduled agent', { nodeId: definition.entryNodeId });
    return { ok: false, issues };
  }

  const outgoing = new Map<string, ControlEdge[]>();
  for (const edge of definition.controlEdges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }

  const order: string[] = [];
  let outputNodeId: string | null = null;
  let current: CorralNode = entry;
  for (;;) {
    order.push(current.id);
    const next: ControlEdge[] = outgoing.get(current.id) ?? [];
    const edge = next[0];
    if (!edge) {
      issue('this agent has no outgoing control edge', { nodeId: current.id });
      break;
    }
    if (next.length > 1) issue('an agent may have only one next step', { nodeId: current.id });
    const target = nodes.get(edge.target);
    if (target?.type === 'output') {
      outputNodeId = target.id;
      break;
    }
    if (target?.type !== 'agent') break;
    if (order.includes(target.id)) {
      issue('this edge closes a cycle outside a Loop', { edgeId: edge.id });
      break;
    }
    current = target;
  }

  for (const node of definition.nodes) {
    const scheduled = node.type === 'agent' && node.invocation === 'scheduled';
    if (
      (scheduled || node.type === 'output') &&
      !order.includes(node.id) &&
      node.id !== outputNodeId
    ) {
      issue('the control flow never reaches this node', { nodeId: node.id });
    }
  }
  checkBindings(definition, order, issue);

  if (issues.length > 0 || !outputNodeId) return { ok: false, issues };
  return { ok: true, agentNodeIds: order, outputNodeId };
}

type IssueFn = (message: string, at?: { nodeId?: string; edgeId?: string }) => void;

function checkEdge(edge: ControlEdge, nodes: Map<string, CorralNode>, issue: IssueFn) {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) {
    issue('the edge points to a node that does not exist', { edgeId: edge.id });
    return;
  }
  if (source.type === 'agent' && edge.sourcePort !== 'out') {
    issue(`agents connect from "out", not "${edge.sourcePort}"`, { edgeId: edge.id });
  }
  if (source.type === 'output') issue('Output has no outgoing port', { edgeId: edge.id });
  if ((target.type === 'agent' || target.type === 'output') && edge.targetPort !== 'in') {
    issue(`${target.type} nodes connect into "in", not "${edge.targetPort}"`, { edgeId: edge.id });
  }
  if (target.type === 'agent' && target.invocation === 'callable') {
    issue('callable agents run only when another agent calls them', { edgeId: edge.id });
  }
}

/** Inputs must come from the run or from an agent that runs earlier in this plan. */
function checkBindings(definition: CorralDefinition, order: string[], issue: IssueFn) {
  for (const node of definition.nodes) {
    if (node.type !== 'agent' && node.type !== 'output') continue;
    const position = node.type === 'agent' ? order.indexOf(node.id) : order.length;
    if (position < 0) continue; // callable agents are checked when collaboration lands (P4)
    for (const binding of node.inputBindings) {
      if (binding.kind === 'run_input') continue;
      if (binding.kind !== 'task_output') {
        issue(`${binding.kind} inputs are not supported by the P0 runner yet`, { nodeId: node.id });
        continue;
      }
      const sourceIndex = binding.sourceNodeId ? order.indexOf(binding.sourceNodeId) : -1;
      if (sourceIndex < 0 || sourceIndex >= position) {
        issue(`input "${binding.name}" must come from an earlier agent`, { nodeId: node.id });
      }
    }
  }
}
