import {
  type AgentNode,
  type AgentRole,
  CorralDefinition,
  DEFAULT_LIMITS,
  type InputBinding,
  type OutputNode,
} from '@corral/contracts';
import { planLinearRun } from '@corral/core';

// Editor draft: what the user drew (execution meaning) plus where it sits (layout).
// Pure functions so every canvas gesture is testable without a browser. The draft becomes a
// CorralDefinition only through compileDraft, which uses the same checks as the runtime.

export type EditorNodeType = 'agent' | 'output';

export interface EditorNode {
  id: string;
  type: EditorNodeType;
  label: string;
  prompt: string;
}

export interface EditorEdge {
  id: string;
  source: string;
  target: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface EditorDraft {
  corralId: string;
  name: string;
  brief: string;
  nodes: EditorNode[];
  edges: EditorEdge[];
  layout: Record<string, Point>;
  counters: Record<EditorNodeType | 'edge', number>;
}

export type ConnectionRejection =
  | 'unknownNode'
  | 'outputHasNoOutgoingPort'
  | 'selfConnection'
  | 'duplicateOutgoing'
  | 'duplicateIncoming'
  | 'cycle';

export interface CompileIssue {
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface CompileResult {
  definition?: CorralDefinition;
  issues: CompileIssue[];
}

export const DEFAULT_AGENT_PROMPT = 'Answer the brief clearly and say which inputs you used.';

export function emptyDraft(): EditorDraft {
  return {
    corralId: 'untitled',
    name: 'Untitled Corral',
    brief: 'Compare two options using primary sources.',
    nodes: [],
    edges: [],
    layout: {},
    counters: { agent: 0, output: 0, edge: 0 },
  };
}

export function addNode(
  draft: EditorDraft,
  type: EditorNodeType,
  position: Point,
): { draft: EditorDraft; nodeId: string } {
  const index = draft.counters[type] + 1;
  const nodeId = `${type}_${index}`;
  const node: EditorNode = {
    id: nodeId,
    type,
    label: type === 'agent' ? `Agent ${index}` : index === 1 ? 'Output' : `Output ${index}`,
    prompt: type === 'agent' ? DEFAULT_AGENT_PROMPT : '',
  };
  return {
    nodeId,
    draft: {
      ...draft,
      nodes: [...draft.nodes, node],
      layout: { ...draft.layout, [nodeId]: position },
      counters: { ...draft.counters, [type]: index },
    },
  };
}

export function moveNode(draft: EditorDraft, nodeId: string, position: Point): EditorDraft {
  if (!draft.layout[nodeId]) return draft;
  return { ...draft, layout: { ...draft.layout, [nodeId]: position } };
}

export function updateNode(
  draft: EditorDraft,
  nodeId: string,
  change: Partial<Pick<EditorNode, 'label' | 'prompt'>>,
): EditorDraft {
  return {
    ...draft,
    nodes: draft.nodes.map((node) => (node.id === nodeId ? { ...node, ...change } : node)),
  };
}

export function removeNode(draft: EditorDraft, nodeId: string): EditorDraft {
  const { [nodeId]: _removed, ...layout } = draft.layout;
  return {
    ...draft,
    nodes: draft.nodes.filter((node) => node.id !== nodeId),
    edges: draft.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    layout,
  };
}

export function removeEdge(draft: EditorDraft, edgeId: string): EditorDraft {
  return { ...draft, edges: draft.edges.filter((edge) => edge.id !== edgeId) };
}

/** Same rule while dragging a connection and after dropping it (Spec §4.2). */
export function checkConnection(
  draft: EditorDraft,
  source: string,
  target: string,
): { ok: true } | { ok: false; reason: ConnectionRejection } {
  const from = draft.nodes.find((node) => node.id === source);
  const to = draft.nodes.find((node) => node.id === target);
  if (!from || !to) return { ok: false, reason: 'unknownNode' };
  if (from.type === 'output') return { ok: false, reason: 'outputHasNoOutgoingPort' };
  if (source === target) return { ok: false, reason: 'selfConnection' };
  if (draft.edges.some((edge) => edge.source === source)) {
    return { ok: false, reason: 'duplicateOutgoing' };
  }
  if (draft.edges.some((edge) => edge.target === target)) {
    return { ok: false, reason: 'duplicateIncoming' };
  }
  if (reaches(draft, target, source)) return { ok: false, reason: 'cycle' };
  return { ok: true };
}

export function connect(
  draft: EditorDraft,
  source: string,
  target: string,
): { ok: true; draft: EditorDraft; edgeId: string } | { ok: false; reason: ConnectionRejection } {
  const check = checkConnection(draft, source, target);
  if (!check.ok) return check;
  const index = draft.counters.edge + 1;
  const edgeId = `edge_${index}`;
  return {
    ok: true,
    edgeId,
    draft: {
      ...draft,
      edges: [...draft.edges, { id: edgeId, source, target }],
      counters: { ...draft.counters, edge: index },
    },
  };
}

function reaches(draft: EditorDraft, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of draft.edges) if (edge.source === current) stack.push(edge.target);
  }
  return false;
}

/** Turns the drawing into a definition, or explains what blocks a run and where. */
export function compileDraft(draft: EditorDraft): CompileResult {
  const agents = draft.nodes.filter((node) => node.type === 'agent');
  const outputs = draft.nodes.filter((node) => node.type === 'output');
  const issues: CompileIssue[] = [];
  if (agents.length === 0) issues.push({ message: 'Add at least one Agent.' });
  if (outputs.length === 0) issues.push({ message: 'Add an Output to receive the final result.' });
  if (issues.length > 0) return { issues };

  const incoming = (nodeId: string) => draft.edges.find((edge) => edge.target === nodeId);
  const entry = agents.find((agent) => !incoming(agent.id)) ?? agents[0];

  const roles: AgentRole[] = agents.map((agent) => ({
    id: `${agent.id}_role`,
    name: agent.label,
    prompt: agent.prompt || DEFAULT_AGENT_PROMPT,
    modelProfile: 'model-a',
    allowedWorkTools: ['write_artifact'],
    allowedCollaborationTools: ['submit_result'],
    outputContract: 'text',
  }));
  const bindingFrom = (nodeId: string, name: string): InputBinding[] => {
    const edge = incoming(nodeId);
    return edge ? [{ kind: 'task_output', name, sourceNodeId: edge.source }] : [];
  };
  const agentNodes: AgentNode[] = agents.map((agent) => {
    const fromAgent = bindingFrom(agent.id, 'previous');
    return {
      id: agent.id,
      type: 'agent',
      label: agent.label,
      roleId: `${agent.id}_role`,
      invocation: 'scheduled',
      inputBindings: fromAgent.length > 0 ? fromAgent : [{ kind: 'run_input', name: 'brief' }],
      outputName: 'text',
    };
  });
  const outputNodes: OutputNode[] = outputs.map((output) => ({
    id: output.id,
    type: 'output',
    label: output.label,
    inputBindings: bindingFrom(output.id, 'final'),
    requireApproval: false,
  }));
  for (const output of outputNodes) {
    if (output.inputBindings.length === 0) {
      issues.push({ message: 'Connect an Agent into this Output.', nodeId: output.id });
    }
  }
  if (draft.edges.length === 0) issues.push({ message: 'Connect the nodes to define the order.' });
  if (issues.length > 0) return { issues };

  const parsed = CorralDefinition.safeParse({
    schemaVersion: '0.1',
    id: draft.corralId,
    name: draft.name,
    entryNodeId: entry?.id,
    input: { brief: draft.brief, criteria: ['Say which inputs were used.'] },
    roles,
    nodes: [...agentNodes, ...outputNodes],
    controlEdges: draft.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourcePort: 'out',
      target: edge.target,
      targetPort: 'in',
    })),
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  });
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        message: `${issue.path.join('.')}: ${issue.message}`,
      })),
    };
  }
  const plan = planLinearRun(parsed.data);
  if (!plan.ok) {
    return {
      issues: plan.issues.map(({ message, nodeId, edgeId }) => ({
        message,
        ...(nodeId ? { nodeId } : {}),
        ...(edgeId ? { edgeId } : {}),
      })),
    };
  }
  return { definition: parsed.data, issues: [] };
}
