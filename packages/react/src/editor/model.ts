import {
  type AgentNode,
  type AgentRole,
  CanvasLayout,
  type CapabilityLink,
  type ControlEdge,
  type CorralDefinition,
  CorralDefinitionDraft,
  type CorralNode,
  DEFAULT_LIMITS,
  type DecisionNode,
  FILE_TOOLS,
  type InputBinding,
  type LoopNode,
  type NodeLayout,
  type OutputContract,
  type SourcePort,
  type TargetPort,
} from '@corral/contracts';
import {
  compileDefinition,
  DECISION_PORTS,
  DECISION_RULE,
  type Diagnostic,
  inputPortsOf,
  loopBoundaryViolation,
  outputPortsOf,
  type PlanIssue,
  planRun,
  wouldCreateCycle,
} from '@corral/core';
import { autoLayout } from '../run/layout.ts';

// Editor draft = the definition being drawn + where each node sits. Every gesture is a pure
// function here, so the canvas only translates pointer and keyboard input into these calls.
// Connection rules come from the compiler's port table; the editor never invents its own.

export type EditorNodeType = CorralNode['type'];

export interface Point {
  x: number;
  y: number;
}

export interface EditorDraft {
  definition: CorralDefinition;
  layout: Record<string, NodeLayout>;
  viewport: { x: number; y: number; zoom: number };
  counters: Record<string, number>;
}

export interface ConnectionRequest {
  source: string;
  sourcePort: SourcePort;
  target: string;
  targetPort: TargetPort;
}

export type ConnectionRejection =
  | 'unknownNode'
  | 'selfConnection'
  | 'callableInControlFlow'
  | 'invalidSourcePort'
  | 'invalidTargetPort'
  | 'duplicateOutgoing'
  | 'loopBoundary'
  | 'cycle';

export type CapabilityRejection =
  | 'unknownNode'
  | 'selfConnection'
  | 'sourceNotAgent'
  | 'targetNotCallable'
  | 'duplicateLink';

export interface NodeChange {
  label?: string;
  prompt?: string;
  invocation?: AgentNode['invocation'];
  outputContract?: OutputContract;
  modelProfile?: string;
  reasoning?: AgentRole['reasoning'] | null;
  harness?: AgentRole['harness'] | null;
  mode?: DecisionNode['mode'];
  maxIterations?: number;
  reviewRecipe?: LoopNode['reviewRecipe'] | null;
  requireApproval?: boolean;
  inputBindings?: InputBinding[];
  /** Lets the role change files in the session's working copy: all file tools. */
  fileTools?: boolean;
  runCommand?: boolean;
  generateImage?: boolean;
  previewFile?: boolean;
  previewApp?: boolean;
  previewAction?: boolean;
  imageProfile?: string | null;
  editingMode?: AgentRole['editingMode'];
  teamPlanOwner?: boolean;
}

export interface DraftCompilation {
  /** Present only when the definition compiles. */
  definition?: CorralDefinition;
  diagnostics: Diagnostic[];
  /** The current runtime can execute it (P1: linear Agent → Output only). */
  runnable: boolean;
  /** Valid structure the current runtime cannot run yet, with the node named. */
  runtimeLimits: PlanIssue[];
}

export const DEFAULT_AGENT_PROMPT = 'Answer the brief clearly and say which inputs you used.';
const LOOP_SIZE = { width: 460, height: 260 };
const MAX_IMPORT_BYTES = 1024 * 1024;

// ── creation ─────────────────────────────────────────────────────────────────

export function emptyDraft(corralId = 'untitled', name = 'Untitled Corral'): EditorDraft {
  return {
    definition: {
      schemaVersion: '0.1',
      id: corralId,
      name,
      entryNodeId: '',
      input: {
        brief: 'Compare two options using primary sources.',
        criteria: ['Say which inputs were used.'],
      },
      roles: [],
      nodes: [],
      controlEdges: [],
      capabilityLinks: [],
      limits: DEFAULT_LIMITS,
    },
    layout: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    counters: {},
  };
}

function nextId(
  draft: EditorDraft,
  prefix: string,
): { id: string; counters: Record<string, number> } {
  const taken = new Set([
    ...draft.definition.nodes.map((n) => n.id),
    ...draft.definition.controlEdges.map((e) => e.id),
    ...draft.definition.capabilityLinks.map((l) => l.id),
    ...draft.definition.roles.map((r) => r.id),
  ]);
  let n = draft.counters[prefix] ?? 0;
  let id: string;
  do {
    n += 1;
    id = `${prefix}_${n}`;
  } while (taken.has(id));
  return { id, counters: { ...draft.counters, [prefix]: n } };
}

function newRole(id: string, name: string): AgentRole {
  return {
    id,
    name,
    prompt: DEFAULT_AGENT_PROMPT,
    modelProfile: 'model-a',
    allowedWorkTools: ['write_artifact'],
    allowedCollaborationTools: ['submit_result', 'ask_user', 'update_plan'],
    outputContract: 'text',
  };
}

export function addNode(
  draft: EditorDraft,
  type: EditorNodeType,
  position: Point,
): { draft: EditorDraft; nodeId: string } {
  const { id, counters } = nextId(draft, type);
  const index = counters[type] as number;
  const label = (base: string) => (index === 1 ? base : `${base} ${index}`);
  let node: CorralNode;
  const roles = [...draft.definition.roles];
  switch (type) {
    case 'agent': {
      const role = newRole(`${id}_role`, `Agent ${index}`);
      roles.push(role);
      node = {
        id,
        type: 'agent',
        label: `Agent ${index}`,
        roleId: role.id,
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'text',
      };
      break;
    }
    case 'decision':
      node = {
        id,
        type: 'decision',
        label: label('Review decision'),
        mode: 'review',
        rule: 'review_verdict',
        inputBindings: [],
      };
      break;
    case 'loop':
      node = { id, type: 'loop', label: label('Loop'), maxIterations: 2 };
      break;
    case 'output':
      node = {
        id,
        type: 'output',
        label: label('Output'),
        inputBindings: [],
        requireApproval: false,
      };
      break;
  }
  const size = type === 'loop' ? LOOP_SIZE : {};
  return {
    nodeId: id,
    draft: withDefinition(
      { ...draft, counters, layout: { ...draft.layout, [id]: { ...position, ...size } } },
      { ...draft.definition, roles, nodes: [...draft.definition.nodes, node] },
    ),
  };
}

export function duplicateNode(
  draft: EditorDraft,
  nodeId: string,
): { draft: EditorDraft; nodeId: string } {
  const original = findNode(draft, nodeId);
  if (!original) return { draft, nodeId };
  const { id, counters } = nextId(draft, original.type);
  const roles = [...draft.definition.roles];
  let copy: CorralNode = { ...structuredCopy(original), id, label: `${original.label} copy` };
  if (copy.type === 'agent' && original.type === 'agent') {
    const role = roles.find((r) => r.id === original.roleId);
    const roleId = `${id}_role`;
    roles.push({
      ...(role ? structuredCopy(role) : newRole(roleId, copy.label)),
      id: roleId,
      name: copy.label,
    });
    copy = { ...copy, roleId };
  }
  const at = draft.layout[nodeId] ?? { x: 0, y: 0 };
  return {
    nodeId: id,
    draft: withDefinition(
      {
        ...draft,
        counters,
        layout: { ...draft.layout, [id]: { ...at, x: at.x + 40, y: at.y + 40 } },
      },
      { ...draft.definition, roles, nodes: [...draft.definition.nodes, copy] },
    ),
  };
}

// ── layout-only changes ──────────────────────────────────────────────────────

/** Moves a node; moving a Loop area moves its members too. Never changes the definition. */
export function moveNode(draft: EditorDraft, nodeId: string, position: Point): EditorDraft {
  const current = draft.layout[nodeId];
  if (!current) return draft;
  const layout = { ...draft.layout, [nodeId]: { ...current, ...position } };
  if (findNode(draft, nodeId)?.type === 'loop') {
    const dx = position.x - current.x;
    const dy = position.y - current.y;
    for (const member of draft.definition.nodes) {
      const at = layout[member.id];
      if ('loopId' in member && member.loopId === nodeId && at) {
        layout[member.id] = { ...at, x: at.x + dx, y: at.y + dy };
      }
    }
  }
  return { ...draft, layout };
}

/**
 * Tidy up: places every node by the control flow, Loops around their members.
 * Layout only; one step for undo.
 */
export function arrangeDraft(draft: EditorDraft): EditorDraft {
  if (draft.definition.nodes.length === 0) return draft;
  const placed = autoLayout(draft.definition);
  const layout: Record<string, NodeLayout> = {};
  for (const node of draft.definition.nodes) {
    const at = placed[node.id] ?? draft.layout[node.id];
    if (at) layout[node.id] = { ...draft.layout[node.id], ...at };
  }
  return { ...draft, layout };
}

/** Resizes a Loop area (resizing from the left or top also moves its corner). Layout only. */
export function resizeNode(
  draft: EditorDraft,
  nodeId: string,
  box: { x?: number; y?: number; width: number; height: number },
): EditorDraft {
  const current = draft.layout[nodeId];
  return current
    ? { ...draft, layout: { ...draft.layout, [nodeId]: { ...current, ...box } } }
    : draft;
}

export function setViewport(draft: EditorDraft, viewport: EditorDraft['viewport']): EditorDraft {
  return { ...draft, viewport };
}

// ── definition changes ───────────────────────────────────────────────────────

/** Puts a node into a Loop body or takes it out. This is a definition change. */
export function setLoopMembership(
  draft: EditorDraft,
  nodeId: string,
  loopId: string | null,
): EditorDraft {
  const nodes = draft.definition.nodes.map((node) => {
    if (node.id !== nodeId || (node.type !== 'agent' && node.type !== 'decision')) return node;
    if (node.type === 'agent' && node.invocation === 'callable') return node;
    const { loopId: _old, ...rest } = node;
    return (loopId ? { ...rest, loopId } : rest) as CorralNode;
  });
  return withDefinition(draft, { ...draft.definition, nodes });
}

export function updateNode(draft: EditorDraft, nodeId: string, change: NodeChange): EditorDraft {
  const node = findNode(draft, nodeId);
  if (!node) return draft;
  let { nodes, roles, controlEdges, capabilityLinks } = draft.definition;
  const setNode = (next: CorralNode) => {
    nodes = nodes.map((n) => (n.id === nodeId ? next : n));
  };
  let next: CorralNode = { ...node };
  if (change.label !== undefined) next = { ...next, label: change.label };
  if (change.inputBindings && next.type !== 'loop')
    next = { ...next, inputBindings: change.inputBindings };

  if (next.type === 'agent') {
    const roleId = next.roleId;
    const roleChange: Partial<AgentRole> = {};
    if (change.teamPlanOwner)
      roleChange.allowedCollaborationTools = [
        ...new Set([
          ...(roles.find((r) => r.id === roleId)?.allowedCollaborationTools ?? []),
          'update_plan' as const,
        ]),
      ];
    if (change.prompt !== undefined) roleChange.prompt = change.prompt;
    if (change.outputContract) roleChange.outputContract = change.outputContract;
    if (change.modelProfile) roleChange.modelProfile = change.modelProfile;
    if (change.harness) roleChange.harness = change.harness;
    if (change.reasoning) roleChange.reasoning = change.reasoning;
    if (change.editingMode) roleChange.editingMode = change.editingMode;
    if (change.fileTools !== undefined) {
      const current = roles.find((r) => r.id === roleId)?.allowedWorkTools ?? [];
      const others = current.filter((tool) => !(FILE_TOOLS as readonly string[]).includes(tool));
      roleChange.allowedWorkTools = change.fileTools ? [...others, ...FILE_TOOLS] : others;
    }
    if (change.runCommand !== undefined) {
      const current =
        roleChange.allowedWorkTools ?? roles.find((r) => r.id === roleId)?.allowedWorkTools ?? [];
      const others = current.filter((tool) => tool !== 'run_command');
      roleChange.allowedWorkTools = change.runCommand ? [...others, 'run_command'] : others;
    }
    if (change.imageProfile) roleChange.imageProfile = change.imageProfile;
    if (change.generateImage !== undefined) {
      const current =
        roleChange.allowedWorkTools ?? roles.find((r) => r.id === roleId)?.allowedWorkTools ?? [];
      const others = current.filter((tool) => tool !== 'generate_image');
      roleChange.allowedWorkTools = change.generateImage ? [...others, 'generate_image'] : others;
    }
    for (const [key, tool] of [
      ['previewFile', 'preview_file'],
      ['previewApp', 'preview_app'],
      ['previewAction', 'preview_action'],
    ] as const) {
      if (change[key] === undefined) continue;
      const current =
        roleChange.allowedWorkTools ?? roles.find((r) => r.id === roleId)?.allowedWorkTools ?? [];
      const others = current.filter((candidate) => candidate !== tool);
      roleChange.allowedWorkTools = change[key] ? [...others, tool] : others;
    }
    if (change.label !== undefined) {
      const sharedBy = nodes.filter((n) => n.type === 'agent' && n.roleId === roleId);
      if (sharedBy.length === 1) roleChange.name = change.label;
    }
    if (Object.keys(roleChange).length > 0) {
      roles = roles.map((r) => (r.id === roleId ? { ...r, ...roleChange } : r));
    }
    if (change.reasoning === null)
      roles = roles.map((role) => {
        if (role.id !== roleId) return role;
        const { reasoning: _reasoning, ...rest } = role;
        return rest;
      });
    if (change.imageProfile === null)
      roles = roles.map((role) => {
        if (role.id !== roleId) return role;
        const { imageProfile: _imageProfile, ...rest } = role;
        return rest;
      });
    if (change.harness === null) {
      roles = roles.map((r) => {
        if (r.id !== roleId) return r;
        const { harness: _removed, ...basic } = r;
        return basic;
      });
    }
    // A reviewer reviews against the criteria: give it their text when it becomes one (#20).
    const hasCriteria = next.inputBindings.some(
      (b) => b.kind === 'run_input' && b.name === 'criteria',
    );
    if (change.outputContract === 'review' && !change.inputBindings && !hasCriteria) {
      next = {
        ...next,
        inputBindings: [...next.inputBindings, { kind: 'run_input', name: 'criteria' }],
      };
    }
    if (change.invocation && change.invocation !== next.invocation) {
      if (change.invocation === 'callable') {
        // Callable agents run only when called: they leave the control flow and any Loop.
        controlEdges = controlEdges.filter((e) => e.source !== nodeId && e.target !== nodeId);
        const { loopId: _loop, ...rest } = next;
        next = { ...rest, invocation: 'callable' };
      } else {
        capabilityLinks = capabilityLinks.filter((l) => l.targetNodeId !== nodeId);
        next = { ...next, invocation: 'scheduled' };
      }
    }
  }
  if (next.type === 'decision' && change.mode && change.mode !== next.mode) {
    const ports = DECISION_PORTS[change.mode];
    controlEdges = controlEdges.filter((e) => e.source !== nodeId || ports.includes(e.sourcePort));
    next = { ...next, mode: change.mode, rule: DECISION_RULE[change.mode] };
  }
  if (next.type === 'loop' && change.maxIterations !== undefined)
    next = { ...next, maxIterations: change.maxIterations };
  if (next.type === 'loop' && change.reviewRecipe !== undefined) {
    const { reviewRecipe: _prior, ...rest } = next;
    next = change.reviewRecipe ? { ...rest, reviewRecipe: change.reviewRecipe } : rest;
  }
  if (next.type === 'output' && change.requireApproval !== undefined)
    next = { ...next, requireApproval: change.requireApproval };
  setNode(next);
  const { planOwnerRoleId, ...definition } = draft.definition;
  const owner =
    next.type === 'agent' && change.teamPlanOwner !== undefined
      ? change.teamPlanOwner
        ? next.roleId
        : planOwnerRoleId === next.roleId
          ? undefined
          : planOwnerRoleId
      : planOwnerRoleId;
  return withDefinition(draft, {
    ...definition,
    ...(owner ? { planOwnerRoleId: owner } : {}),
    nodes,
    roles,
    controlEdges,
    capabilityLinks,
  });
}

export function setName(draft: EditorDraft, name: string): EditorDraft {
  return withDefinition(draft, { ...draft.definition, name });
}

export function setBrief(draft: EditorDraft, brief: string): EditorDraft {
  return withDefinition(draft, {
    ...draft.definition,
    input: { ...draft.definition.input, brief },
  });
}

export function removeNode(draft: EditorDraft, nodeId: string): EditorDraft {
  const { definition } = draft;
  const removed = findNode(draft, nodeId);
  if (!removed) return draft;
  const nodes = definition.nodes
    .filter((n) => n.id !== nodeId)
    .map((n): CorralNode => {
      let next = n;
      if (removed.type === 'loop' && 'loopId' in next && next.loopId === nodeId) {
        const { loopId: _loop, ...rest } = next;
        next = rest as CorralNode;
      }
      if (next.type !== 'loop') {
        const inputBindings = next.inputBindings.filter((b) => b.sourceNodeId !== nodeId);
        if (inputBindings.length !== next.inputBindings.length) next = { ...next, inputBindings };
      }
      return next;
    });
  const usedRoles = new Set(nodes.flatMap((n) => (n.type === 'agent' ? [n.roleId] : [])));
  const { [nodeId]: _gone, ...layout } = draft.layout;
  const { planOwnerRoleId, ...remainingDefinition } = definition;
  return withDefinition(
    { ...draft, layout },
    {
      ...remainingDefinition,
      ...(planOwnerRoleId && usedRoles.has(planOwnerRoleId) ? { planOwnerRoleId } : {}),
      nodes,
      roles: definition.roles.filter((r) => usedRoles.has(r.id)),
      controlEdges: definition.controlEdges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      ),
      capabilityLinks: definition.capabilityLinks.filter(
        (l) => l.sourceNodeId !== nodeId && l.targetNodeId !== nodeId,
      ),
    },
  );
}

export function removeEdge(draft: EditorDraft, edgeId: string): EditorDraft {
  return withDefinition(draft, {
    ...draft.definition,
    controlEdges: draft.definition.controlEdges.filter((e) => e.id !== edgeId),
  });
}

export function removeLink(draft: EditorDraft, linkId: string): EditorDraft {
  return withDefinition(draft, {
    ...draft.definition,
    capabilityLinks: draft.definition.capabilityLinks.filter((l) => l.id !== linkId),
  });
}

// ── connections ──────────────────────────────────────────────────────────────

/** The same rule while dragging a connection and after dropping it. */
export function checkConnection(
  draft: EditorDraft,
  request: ConnectionRequest,
): { ok: true } | { ok: false; reason: ConnectionRejection } {
  const source = findNode(draft, request.source);
  const target = findNode(draft, request.target);
  const refuse = (reason: ConnectionRejection) => ({ ok: false as const, reason });
  if (!source || !target) return refuse('unknownNode');
  if (source.id === target.id) return refuse('selfConnection');
  const callable = (n: CorralNode) => n.type === 'agent' && n.invocation === 'callable';
  if (callable(source) || callable(target)) return refuse('callableInControlFlow');
  if (!outputPortsOf(source).includes(request.sourcePort)) return refuse('invalidSourcePort');
  if (!inputPortsOf(target).includes(request.targetPort)) return refuse('invalidTargetPort');
  const edges = draft.definition.controlEdges;
  if (edges.some((e) => e.source === source.id && e.sourcePort === request.sourcePort)) {
    return refuse('duplicateOutgoing');
  }
  if (loopBoundaryViolation(source, request.sourcePort, target, request.targetPort))
    return refuse('loopBoundary');
  if (wouldCreateCycle(draft.definition.nodes, edges, request)) return refuse('cycle');
  return { ok: true };
}

export function connect(
  draft: EditorDraft,
  request: ConnectionRequest,
): { ok: true; draft: EditorDraft; edgeId: string } | { ok: false; reason: ConnectionRejection } {
  const check = checkConnection(draft, request);
  if (!check.ok) return check;
  const { id, counters } = nextId(draft, 'edge');
  const edge: ControlEdge = { id, ...request };
  let definition = { ...draft.definition, controlEdges: [...draft.definition.controlEdges, edge] };
  definition = withSuggestedBinding(definition, request.target);
  return { ok: true, edgeId: id, draft: withDefinition({ ...draft, counters }, definition) };
}

const TOOLS_FOR: Record<CapabilityLink['kind'], AgentRole['allowedCollaborationTools']> = {
  delegate: ['spawn_subagents', 'await_tasks'],
  question: ['ask'],
};

/** Drawing a call link is the user's grant: the source role gets the matching tools. */
export function connectCapability(
  draft: EditorDraft,
  sourceId: string,
  targetId: string,
  kind: CapabilityLink['kind'],
): { ok: true; draft: EditorDraft; linkId: string } | { ok: false; reason: CapabilityRejection } {
  const source = findNode(draft, sourceId);
  const target = findNode(draft, targetId);
  const refuse = (reason: CapabilityRejection) => ({ ok: false as const, reason });
  if (!source || !target) return refuse('unknownNode');
  if (sourceId === targetId) return refuse('selfConnection');
  if (source.type !== 'agent') return refuse('sourceNotAgent');
  if (target.type !== 'agent' || target.invocation !== 'callable')
    return refuse('targetNotCallable');
  const links = draft.definition.capabilityLinks;
  if (
    links.some((l) => l.sourceNodeId === sourceId && l.targetNodeId === targetId && l.kind === kind)
  ) {
    return refuse('duplicateLink');
  }
  const { id, counters } = nextId(draft, 'link');
  const roles = draft.definition.roles.map((role) => {
    if (role.id !== source.roleId) return role;
    const tools = [...role.allowedCollaborationTools];
    for (const tool of TOOLS_FOR[kind]) if (!tools.includes(tool)) tools.push(tool);
    return { ...role, allowedCollaborationTools: tools };
  });
  return {
    ok: true,
    linkId: id,
    draft: withDefinition(
      { ...draft, counters },
      {
        ...draft.definition,
        roles,
        capabilityLinks: [...links, { id, kind, sourceNodeId: sourceId, targetNodeId: targetId }],
      },
    ),
  };
}

/**
 * Proposes an input for a newly connected node: the nearest agent before it. Review decisions
 * read the nearest reviewer; Outputs and other decisions read the nearest work product.
 */
function withSuggestedBinding(definition: CorralDefinition, consumerId: string): CorralDefinition {
  const consumer = definition.nodes.find((n) => n.id === consumerId);
  if (!consumer || consumer.type === 'loop') return definition;
  const roleOf = (id: string) => {
    const node = definition.nodes.find((n) => n.id === id);
    return node?.type === 'agent' ? definition.roles.find((r) => r.id === node.roleId) : undefined;
  };
  const wantsReview = consumer.type === 'decision' && consumer.mode === 'review';
  const accept = (id: string) => {
    const contract = roleOf(id)?.outputContract;
    if (!contract) return false;
    if (consumer.type === 'agent') return true;
    return wantsReview ? contract === 'review' : contract !== 'review';
  };
  const source = nearestUpstream(definition, consumerId, accept);
  if (!source || consumer.inputBindings.some((b) => b.sourceNodeId === source)) return definition;
  const sourceNode = definition.nodes.find((n) => n.id === source) as AgentNode;
  const names = new Set(consumer.inputBindings.map((b) => b.name));
  let name = sourceNode.outputName;
  for (let i = 2; names.has(name); i++) name = `${sourceNode.outputName}_${i}`;
  const binding: InputBinding = { kind: 'task_output', name, sourceNodeId: source };
  return {
    ...definition,
    nodes: definition.nodes.map((n) =>
      n.id === consumerId && n.type !== 'loop'
        ? { ...n, inputBindings: [...n.inputBindings, binding] }
        : n,
    ),
  };
}

function nearestUpstream(
  definition: CorralDefinition,
  startId: string,
  accept: (id: string) => boolean,
): string | null {
  // Walk control edges backwards. Through a Loop: from "next" go back to what exits the body,
  // from "body" go back to what enters the Loop.
  const queue: { id: string; viaPort: SourcePort | null }[] = [{ id: startId, viaPort: null }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { id, viaPort } = queue.shift() as { id: string; viaPort: SourcePort | null };
    const key = `${id}:${viaPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (id !== startId && accept(id)) return id;
    const node = definition.nodes.find((n) => n.id === id);
    const incoming = definition.controlEdges.filter((e) => {
      if (e.target !== id) return false;
      if (node?.type !== 'loop' || id === startId) return true;
      if (viaPort === 'next') return e.targetPort === 'exit' || e.targetPort === 'repeat';
      return e.targetPort === 'enter';
    });
    for (const edge of incoming) queue.push({ id: edge.source, viaPort: edge.sourcePort });
  }
  return null;
}

// ── import, export, compile ──────────────────────────────────────────────────

export function draftFromDefinition(
  definition: CorralDefinition,
  layout?: CanvasLayout,
): EditorDraft {
  const counters: Record<string, number> = {};
  const ids = [
    ...definition.nodes.map((n) => n.id),
    ...definition.controlEdges.map((e) => e.id),
    ...definition.capabilityLinks.map((l) => l.id),
  ];
  for (const id of ids) {
    const match = /^([a-z]+)_(\d+)$/.exec(id);
    if (match)
      counters[match[1] as string] = Math.max(counters[match[1] as string] ?? 0, Number(match[2]));
  }
  const positions: Record<string, NodeLayout> = {};
  definition.nodes.forEach((node, index) => {
    positions[node.id] = layout?.nodes[node.id] ?? {
      x: 60 + (index % 5) * 240,
      y: 80 + Math.floor(index / 5) * 160,
      ...(node.type === 'loop' ? LOOP_SIZE : {}),
    };
  });
  return {
    definition: structuredCopy(definition),
    layout: positions,
    viewport: layout?.viewport ?? { x: 0, y: 0, zoom: 1 },
    counters,
  };
}

export function draftToDefinition(draft: EditorDraft): CorralDefinition {
  return draft.definition;
}

export function draftLayout(draft: EditorDraft, layoutRevision: number): CanvasLayout {
  return {
    schemaVersion: '0.1',
    corralId: draft.definition.id,
    layoutRevision,
    viewport: draft.viewport,
    nodes: draft.layout,
  };
}

export function exportDocuments(
  draft: EditorDraft,
  layoutRevision = 1,
): { definition: string; layout: string } {
  return {
    definition: `${JSON.stringify(draft.definition, null, 2)}\n`,
    layout: `${JSON.stringify(draftLayout(draft, layoutRevision), null, 2)}\n`,
  };
}

export type ImportResult = { ok: true; draft: EditorDraft } | { ok: false; errors: string[] };

/**
 * Imports are untrusted: size-limited, strictly parsed, unknown fields and versions refused.
 * Unfinished drafts can be imported; running still requires the strict compile.
 */
export function importDocuments(definitionText: string, layoutText?: string): ImportResult {
  const parse = (
    text: string,
    what: string,
  ): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)
      return { ok: false, error: `${what} is larger than 1 MiB` };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, error: `${what} is not valid JSON` };
    }
  };
  const raw = parse(definitionText, 'The definition');
  if (!raw.ok) return { ok: false, errors: [raw.error] };
  const definition = CorralDefinitionDraft.safeParse(raw.value);
  if (!definition.success) {
    return {
      ok: false,
      errors: definition.error.issues.map(
        (i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`,
      ),
    };
  }
  let layout: CanvasLayout | undefined;
  if (layoutText !== undefined) {
    const rawLayout = parse(layoutText, 'The layout');
    if (!rawLayout.ok) return { ok: false, errors: [rawLayout.error] };
    const parsed = CanvasLayout.safeParse(rawLayout.value);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map(
          (i) => `layout ${i.path.map(String).join('.')}: ${i.message}`,
        ),
      };
    }
    if (parsed.data.corralId !== definition.data.id) {
      return { ok: false, errors: ['The layout belongs to a different Corral.'] };
    }
    layout = parsed.data;
  }
  return { ok: true, draft: draftFromDefinition(definition.data, layout) };
}

export function compileDraft(draft: EditorDraft): DraftCompilation {
  const compiled = compileDefinition(draft.definition);
  if (!compiled.ok)
    return { diagnostics: compiled.diagnostics, runnable: false, runtimeLimits: [] };
  const plan = planRun(compiled.definition);
  return {
    definition: compiled.definition,
    diagnostics: compiled.diagnostics,
    runnable: plan.ok,
    runtimeLimits: plan.ok ? [] : plan.issues,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function findNode(draft: EditorDraft, nodeId: string): CorralNode | undefined {
  return draft.definition.nodes.find((n) => n.id === nodeId);
}

function withDefinition(draft: EditorDraft, definition: CorralDefinition): EditorDraft {
  return { ...draft, definition: { ...definition, entryNodeId: entryOf(definition) } };
}

/** Keeps the entry pointing at the scheduled agent where the flow starts. */
function entryOf(definition: CorralDefinition): string {
  const targets = new Set(definition.controlEdges.map((e) => e.target));
  const candidates = definition.nodes.filter(
    (n) => n.type === 'agent' && n.invocation === 'scheduled' && !n.loopId && !targets.has(n.id),
  );
  if (candidates.some((n) => n.id === definition.entryNodeId)) return definition.entryNodeId;
  return candidates[0]?.id ?? definition.entryNodeId;
}

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
