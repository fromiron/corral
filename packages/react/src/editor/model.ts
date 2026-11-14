import {
  type AgentNode,
  type AgentRole,
  type CapabilityLink,
  type ControlEdge,
  type CorralDefinition,
  CorralDefinitionDraft,
  type CorralNode,
  DEFAULT_LIMITS,
  type DecisionNode,
  FILE_TOOLS,
  type InputBinding,
  isWorkAgent,
  type LoopNode,
  type ObserverAgentNode,
  type OutputContract,
  type TargetPort,
} from '@corral/contracts';
import {
  boxBoundaryViolation,
  type CompileOptions,
  compileDefinition,
  DECISION_PORTS,
  DECISION_RULE,
  type Diagnostic,
  inputPortsOf,
  outputPortsOf,
  type PlanIssue,
  planRun,
  wouldCreateCycle,
} from '@corral/core';

// Editor draft = the definition being edited. Every edit is a pure function here, so views
// only translate pointer and keyboard input into these calls. Where nodes sit is not stored:
// the team editor lays a team out from its structure.
// Connection rules come from the compiler's port table; the editor never invents its own.

/** Node kinds this editor creates. */
export type EditorNodeType = 'agent' | 'decision' | 'loop' | 'output';

export interface EditorDraft {
  definition: CorralDefinition;
  counters: Record<string, number>;
}

export interface ConnectionRequest {
  source: string;
  sourcePort: string;
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
  | 'sourceIsAdvisor'
  | 'targetNotCallable'
  | 'duplicateLink';

/**
 * The work tools an advisor may read with (team-graph.md structure rule 11). The compiler keeps
 * the same list; it does not export it.
 */
export const ADVISOR_READ_TOOLS = ['search', 'read_document', 'list_files', 'read_file'] as const;
export type AdvisorReadTool = (typeof ADVISOR_READ_TOOLS)[number];
const ADVISOR_COLLABORATION_TOOLS: AgentRole['allowedCollaborationTools'] = [
  'read_artifact',
  'advise',
];
const ADVISOR_PROMPT =
  'Watch the work of the agents you advise. Advise only when something would make the result wrong; otherwise say nothing.';

/** What an advisor's sheet edits; other changes to an advisor are left out. */
const ADVISOR_CHANGES: ReadonlySet<keyof NodeChange> = new Set([
  'label',
  'prompt',
  'modelProfile',
  'reasoning',
  'readTools',
]);

const isReadTool = (tool: string): tool is AdvisorReadTool =>
  (ADVISOR_READ_TOOLS as readonly string[]).includes(tool);
const isAdvisor = (node: CorralNode | undefined): node is ObserverAgentNode =>
  node?.type === 'agent' && node.invocation === 'observer';

export interface NodeChange {
  label?: string;
  prompt?: string;
  /** To or from an advisor too (features/canvas.md rule 11). */
  invocation?: AgentNode['invocation'];
  /** An advisor's read tools, out of ADVISOR_READ_TOOLS. */
  readTools?: AdvisorReadTool[];
  outputContract?: OutputContract;
  modelProfile?: string;
  reasoning?: AgentRole['reasoning'] | null;
  harness?: AgentRole['harness'] | null;
  mode?: Extract<DecisionNode, { rule: unknown }>['mode'];
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
    counters: {},
  };
}

/** A fresh id with this prefix, and the counters that remember it. */
export function nextId(
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
  return {
    nodeId: id,
    draft: withDefinition(
      { ...draft, counters },
      { ...draft.definition, roles, nodes: [...draft.definition.nodes, node] },
    ),
  };
}

/** A new advisor with its own role of advisor tools, watching nobody yet and outside any box. */
export function addAdvisor(draft: EditorDraft): { draft: EditorDraft; nodeId: string } {
  const { id, counters } = nextId(draft, 'advisor');
  const index = counters.advisor as number;
  const label = index === 1 ? 'Advisor' : `Advisor ${index}`;
  const role: AgentRole = {
    ...newRole(`${id}_role`, label),
    prompt: ADVISOR_PROMPT,
    allowedWorkTools: [...ADVISOR_READ_TOOLS],
    allowedCollaborationTools: [...ADVISOR_COLLABORATION_TOOLS],
    outputContract: 'notes',
  };
  const node: ObserverAgentNode = {
    id,
    type: 'agent',
    label,
    roleId: role.id,
    invocation: 'observer',
    outputName: 'notes',
  };
  return {
    nodeId: id,
    draft: withDefinition(
      { ...draft, counters },
      {
        ...draft.definition,
        roles: [...draft.definition.roles, role],
        nodes: [...draft.definition.nodes, node],
      },
    ),
  };
}

/** An advisor starts watching a scheduled or callable agent through an `advise` link. */
export function watchAgent(
  draft: EditorDraft,
  advisorId: string,
  agentId: string,
):
  | { ok: true; draft: EditorDraft; linkId: string }
  | { ok: false; reason: 'unknownNode' | 'watchNeedsAdvisor' | 'watchNeedsAgent' | 'duplicate' } {
  const advisor = findNode(draft, advisorId);
  const agent = findNode(draft, agentId);
  if (!advisor || !agent) return { ok: false, reason: 'unknownNode' };
  if (!isAdvisor(advisor)) return { ok: false, reason: 'watchNeedsAdvisor' };
  if (!isWorkAgent(agent)) return { ok: false, reason: 'watchNeedsAgent' };
  const links = draft.definition.capabilityLinks;
  if (
    links.some(
      (l) => l.kind === 'advise' && l.sourceNodeId === advisorId && l.targetNodeId === agentId,
    )
  )
    return { ok: false, reason: 'duplicate' };
  const { id, counters } = nextId(draft, 'link');
  return {
    ok: true,
    linkId: id,
    draft: withDefinition(
      { ...draft, counters },
      {
        ...draft.definition,
        capabilityLinks: [
          ...links,
          { id, kind: 'advise', sourceNodeId: advisorId, targetNodeId: agentId },
        ],
      },
    ),
  };
}

/**
 * Changes how an agent runs. Becoming an advisor takes it out of the flow: its control edges,
 * call links, inputs, retry and box go, and only advisor tools stay. An advisor that runs
 * otherwise stops watching. A role other nodes share is copied, so they keep theirs.
 */
function changeInvocation(
  draft: EditorDraft,
  node: AgentNode,
  invocation: AgentNode['invocation'],
): EditorDraft {
  const { definition } = draft;
  const role = definition.roles.find((r) => r.id === node.roleId);
  const shared = definition.nodes.some(
    (n) => n.id !== node.id && n.type === 'agent' && n.roleId === node.roleId,
  );
  let counters = draft.counters;
  let roleId = node.roleId;
  if (role && shared) {
    const fresh = nextId(draft, 'role');
    counters = fresh.counters;
    roleId = fresh.id;
  }
  const base = {
    id: node.id,
    type: 'agent' as const,
    label: node.label,
    roleId,
    outputName: node.outputName,
    ...(node.note !== undefined ? { note: node.note } : {}),
  };
  let next: AgentNode;
  let tools: Pick<AgentRole, 'allowedWorkTools' | 'allowedCollaborationTools'> | undefined;
  let { controlEdges, capabilityLinks } = definition;
  if (invocation === 'observer') {
    next = { ...base, invocation: 'observer' };
    controlEdges = controlEdges.filter((e) => e.source !== node.id && e.target !== node.id);
    capabilityLinks = capabilityLinks.filter(
      (l) => l.sourceNodeId !== node.id && l.targetNodeId !== node.id,
    );
    tools = role && {
      allowedWorkTools: role.allowedWorkTools.filter(isReadTool),
      allowedCollaborationTools: [...ADVISOR_COLLABORATION_TOOLS],
    };
  } else {
    // A working agent again: it reads the brief, as a new agent does, and works with a new
    // agent's tools besides the ones it read with.
    const fresh = newRole(roleId, node.label);
    next = { ...base, invocation, inputBindings: [{ kind: 'run_input', name: 'brief' }] };
    capabilityLinks = capabilityLinks.filter(
      (l) => !(l.kind === 'advise' && l.sourceNodeId === node.id),
    );
    tools = role && {
      allowedWorkTools: [...new Set([...role.allowedWorkTools, ...fresh.allowedWorkTools])],
      allowedCollaborationTools: [
        ...new Set([
          ...role.allowedCollaborationTools.filter((tool) => tool !== 'advise'),
          ...fresh.allowedCollaborationTools,
        ]),
      ],
    };
  }
  let roles = definition.roles;
  if (role && tools) {
    let changed: AgentRole = { ...role, id: roleId, ...tools };
    if (invocation === 'observer') {
      // What an advisor's sheet does not show takes a new advisor's value, so a converted
      // advisor's role has the shape of a new one: only its instructions, model, reasoning and
      // read tools carry over.
      const {
        harness: _harness,
        imageProfile: _image,
        editingMode: _editing,
        answer: _answer,
        ...kept
      } = changed;
      changed = { ...kept, outputContract: 'notes' };
    }
    roles = shared
      ? roles.flatMap((r) => (r.id === role.id ? [r, changed] : [r]))
      : roles.map((r) => (r.id === role.id ? changed : r));
  }
  // The team plan stays with a working agent.
  const { planOwnerRoleId, ...rest } = definition;
  const owner =
    invocation === 'observer' && planOwnerRoleId === roleId ? undefined : planOwnerRoleId;
  return withDefinition(
    { ...draft, counters },
    {
      ...rest,
      ...(owner ? { planOwnerRoleId: owner } : {}),
      roles,
      nodes: definition.nodes.map((n) => (n.id === node.id ? next : n)),
      controlEdges,
      capabilityLinks,
    },
  );
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
  return {
    nodeId: id,
    draft: withDefinition(
      { ...draft, counters },
      { ...draft.definition, roles, nodes: [...draft.definition.nodes, copy] },
    ),
  };
}

// ── definition changes ───────────────────────────────────────────────────────

export function updateNode(draft: EditorDraft, nodeId: string, change: NodeChange): EditorDraft {
  const node = findNode(draft, nodeId);
  if (!node) return draft;
  if (
    node.type === 'agent' &&
    change.invocation &&
    change.invocation !== node.invocation &&
    (change.invocation === 'observer' || node.invocation === 'observer')
  ) {
    const { invocation, ...others } = change;
    return updateNode(changeInvocation(draft, node, invocation), nodeId, others);
  }
  if (
    node.type === 'agent' &&
    node.invocation === 'observer' &&
    Object.keys(change).some((key) => !ADVISOR_CHANGES.has(key as keyof NodeChange))
  ) {
    // An advisor keeps advisor tools only, and what its sheet does not show does not change.
    const kept = Object.entries(change).filter(([key]) =>
      ADVISOR_CHANGES.has(key as keyof NodeChange),
    );
    return updateNode(draft, nodeId, Object.fromEntries(kept) as NodeChange);
  }
  let { nodes, roles, controlEdges, capabilityLinks } = draft.definition;
  const setNode = (next: CorralNode) => {
    nodes = nodes.map((n) => (n.id === nodeId ? next : n));
  };
  let next: CorralNode = { ...node };
  if (change.label !== undefined) next = { ...next, label: change.label };
  if (change.inputBindings && next.type === 'team') {
    // Only a referenced Team takes inputs; an empty list leaves none.
    const { inputBindings: _was, ...team } = next;
    if (team.source.kind === 'reference')
      next = change.inputBindings.length ? { ...team, inputBindings: change.inputBindings } : team;
  } else if (change.inputBindings && 'inputBindings' in next)
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
    if (change.readTools && next.invocation === 'observer')
      roleChange.allowedWorkTools = ADVISOR_READ_TOOLS.filter((tool) =>
        change.readTools?.includes(tool),
      );
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
  }
  // An advisor takes no inputs; changing to or from one happened above.
  if (next.type === 'agent' && next.invocation !== 'observer') {
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
        const { parentId: _loop, ...rest } = next;
        next = { ...rest, invocation: 'callable' };
      } else {
        // Nobody calls an agent in the flow; an advisor watching it keeps watching.
        capabilityLinks = capabilityLinks.filter(
          (l) => l.targetNodeId !== nodeId || l.kind === 'advise',
        );
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
    if (change.reviewRecipe) {
      // A recipe Loop can only end at its cap (team-graph.md structure rule 4): the recipe drops
      // any other limit policy, and an unlimited Loop takes the recipe's attempts as its cap.
      const { limitPolicy: _policy, ...capped } = rest;
      next = {
        ...capped,
        maxIterations: capped.maxIterations ?? change.reviewRecipe.maxAttempts,
        reviewRecipe: change.reviewRecipe,
      };
    } else next = rest;
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
      if (removed.type === 'loop' && next.parentId === nodeId) {
        const { parentId: _loop, ...rest } = next;
        next = rest as CorralNode;
      }
      if ('inputBindings' in next && next.inputBindings) {
        const inputBindings = next.inputBindings.filter((b) => b.sourceNodeId !== nodeId);
        if (inputBindings.length !== next.inputBindings.length) next = { ...next, inputBindings };
      }
      return next;
    });
  const usedRoles = new Set(nodes.flatMap((n) => (n.type === 'agent' ? [n.roleId] : [])));
  const { planOwnerRoleId, ...remainingDefinition } = definition;
  return withDefinition(draft, {
    ...remainingDefinition,
    ...(planOwnerRoleId && usedRoles.has(planOwnerRoleId) ? { planOwnerRoleId } : {}),
    nodes,
    roles: definition.roles.filter((r) => usedRoles.has(r.id)),
    controlEdges: definition.controlEdges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    capabilityLinks: definition.capabilityLinks.filter(
      (l) => l.sourceNodeId !== nodeId && l.targetNodeId !== nodeId,
    ),
  });
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
  if (boxBoundaryViolation(new Map(draft.definition.nodes.map((n) => [n.id, n])), request))
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

/** Call links; an advisor's `advise` links are made by `watchAgent`. */
export type CallLinkKind = Exclude<CapabilityLink['kind'], 'advise'>;

const TOOLS_FOR: Record<CallLinkKind, AgentRole['allowedCollaborationTools']> = {
  delegate: ['spawn_subagents', 'await_tasks'],
  question: ['ask'],
};

/** Drawing a call link is the user's grant: the source role gets the matching tools. */
export function connectCapability(
  draft: EditorDraft,
  sourceId: string,
  targetId: string,
  kind: CallLinkKind,
): { ok: true; draft: EditorDraft; linkId: string } | { ok: false; reason: CapabilityRejection } {
  const source = findNode(draft, sourceId);
  const target = findNode(draft, targetId);
  const refuse = (reason: CapabilityRejection) => ({ ok: false as const, reason });
  if (!source || !target) return refuse('unknownNode');
  if (sourceId === targetId) return refuse('selfConnection');
  if (source.type !== 'agent') return refuse('sourceNotAgent');
  // An advisor only watches (team-graph.md structure rule 11).
  if (source.invocation === 'observer') return refuse('sourceIsAdvisor');
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
export function withSuggestedBinding(
  definition: CorralDefinition,
  consumerId: string,
): CorralDefinition {
  const consumer = definition.nodes.find((n) => n.id === consumerId);
  if (!consumer || !('inputBindings' in consumer)) return definition;
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
  const existing = consumer.inputBindings ?? [];
  if (!source || existing.some((b) => b.sourceNodeId === source)) return definition;
  const sourceNode = definition.nodes.find((n) => n.id === source) as AgentNode;
  const names = new Set(existing.map((b) => b.name));
  let name = sourceNode.outputName;
  for (let i = 2; names.has(name); i++) name = `${sourceNode.outputName}_${i}`;
  const binding: InputBinding = { kind: 'task_output', name, sourceNodeId: source };
  return {
    ...definition,
    nodes: definition.nodes.map((n) =>
      n.id === consumerId && 'inputBindings' in n
        ? { ...n, inputBindings: [...(n.inputBindings ?? []), binding] }
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
  const queue: { id: string; viaPort: string | null }[] = [{ id: startId, viaPort: null }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { id, viaPort } = queue.shift() as { id: string; viaPort: string | null };
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

export function draftFromDefinition(definition: CorralDefinition): EditorDraft {
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
  return { definition: structuredCopy(definition), counters };
}

export function draftToDefinition(draft: EditorDraft): CorralDefinition {
  return draft.definition;
}

/** The definition as the JSON file a team is exported to. */
export function exportDefinition(draft: EditorDraft): string {
  return `${JSON.stringify(draft.definition, null, 2)}\n`;
}

export type ImportResult = { ok: true; draft: EditorDraft } | { ok: false; errors: string[] };

/**
 * Imports are untrusted: size-limited, strictly parsed, unknown fields and versions refused.
 * Unfinished drafts can be imported; running still requires the strict compile.
 */
export function importDefinition(text: string): ImportResult {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)
    return { ok: false, errors: ['The definition is larger than 1 MiB'] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['The definition is not valid JSON'] };
  }
  const definition = CorralDefinitionDraft.safeParse(raw);
  if (!definition.success) {
    return {
      ok: false,
      errors: definition.error.issues.map(
        (i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`,
      ),
    };
  }
  return { ok: true, draft: draftFromDefinition(definition.data) };
}

export function compileDraft(
  draft: EditorDraft,
  options: Pick<CompileOptions, 'resolveTeam' | 'knownModelProfiles'> = {},
): DraftCompilation {
  const compiled = compileDefinition(draft.definition, options);
  if (!compiled.ok)
    return { diagnostics: compiled.diagnostics, runnable: false, runtimeLimits: [] };
  const plan = planRun(compiled.definition, options);
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

export function withDefinition(draft: EditorDraft, definition: CorralDefinition): EditorDraft {
  return { ...draft, definition: { ...definition, entryNodeId: entryOf(definition) } };
}

/** Keeps the entry pointing where the flow starts: a scheduled agent, else a Loop or Team. */
function entryOf(definition: CorralDefinition): string {
  const targets = new Set(definition.controlEdges.map((e) => e.target));
  const starts = definition.nodes.filter((n) => !n.parentId && !targets.has(n.id));
  const candidates = [
    ...starts.filter((n) => n.type === 'agent' && n.invocation === 'scheduled'),
    ...starts.filter((n) => n.type === 'loop' || n.type === 'team'),
  ];
  if (candidates.some((n) => n.id === definition.entryNodeId)) return definition.entryNodeId;
  // An advisor is never the start: with nowhere else to start, the team has no start, as when
  // the start is deleted.
  const advisorStart = isAdvisor(definition.nodes.find((n) => n.id === definition.entryNodeId));
  return candidates[0]?.id ?? (advisorStart ? '' : definition.entryNodeId);
}

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
