import {
  type AgentNode,
  type CapabilityLink,
  type ControlEdge,
  CorralDefinition,
  type CorralNode,
  type DecisionNode,
  type SourcePort,
  type TargetPort,
} from '@corral/contracts';
import { recipeAttempts, reviewCriteriaHash } from '../review-recipe.ts';
import {
  DECISION_PORTS,
  DECISION_RULE,
  inputPortsOf,
  loopBoundaryViolation,
  outputPortsOf,
  REQUIRED_BRANCHES,
} from './ports.ts';

export { wouldCreateCycle } from './cycles.ts';
export * from './ports.ts';

// Static validation and IR lowering (Technical-Design §4.2, Spec §5.4). The editor shows these
// diagnostics, and the runtime compiles again before running: the editor is not a trust boundary.

export type DiagnosticCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_REFERENCE'
  | 'TOO_MANY_LOOPS'
  | 'INVALID_PORT'
  | 'DUPLICATE_PORT_EDGE'
  | 'CALLABLE_IN_CONTROL_FLOW'
  | 'ENTRY_INVALID'
  | 'DEAD_END'
  | 'DECISION_RULE'
  | 'DECISION_BRANCH_MISSING'
  | 'LOOP_STRUCTURE'
  | 'LOOP_BOUNDARY'
  | 'CYCLE_OUTSIDE_LOOP'
  | 'UNREACHABLE'
  | 'NO_OUTPUT'
  | 'CAPABILITY_TARGET'
  | 'CAPABILITY_NOT_ALLOWED'
  | 'DEPTH_EXCEEDED'
  | 'BINDING_SOURCE'
  | 'REVIEW_CONTRACT'
  | 'REVIEW_WITHOUT_CRITERIA'
  | 'UNKNOWN_MODEL_PROFILE';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  /** English fallback; the UI looks up `code` in its message catalog. */
  message: string;
  nodeId?: string;
  edgeId?: string;
  linkId?: string;
}

export interface PlanTarget {
  nodeId: string;
  port: TargetPort;
}

export type PlanStep =
  | {
      kind: 'agent';
      nodeId: string;
      roleId: string;
      loopId: string | null;
      next: PlanTarget | null;
    }
  | {
      kind: 'decision';
      nodeId: string;
      mode: DecisionNode['mode'];
      rule: DecisionNode['rule'];
      loopId: string | null;
      branches: Partial<Record<SourcePort, PlanTarget | null>>;
    }
  | { kind: 'loop'; nodeId: string; maxIterations: number; body: PlanTarget; next: PlanTarget }
  | { kind: 'output'; nodeId: string; requireApproval: boolean };

export interface LoopPlan {
  nodeId: string;
  maxIterations: number;
  bodyEntryNodeId: string;
  members: string[];
  next: PlanTarget;
}

export interface CompiledPlan {
  entryNodeId: string;
  /** Scheduled nodes in execution order (loop body once). Callable agents never appear here. */
  order: string[];
  steps: Record<string, PlanStep>;
  loops: Record<string, LoopPlan>;
  /** Who may call whom (capability links). Calls happen only when an agent asks at runtime. */
  callables: Record<
    string,
    {
      delegate: string[];
      question: string[];
      parentQuestion?: string[];
      replyToChildren?: boolean;
    }
  >;
  summary: {
    scheduledAgents: number;
    callableAgents: number;
    decisions: number;
    loops: number;
    outputs: number;
    maxStaticDepth: number;
  };
}

export type CompileResult =
  | { ok: true; definition: CorralDefinition; plan: CompiledPlan; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface CompileOptions {
  /** Profiles the runtime can resolve; omitted in the editor before profiles are known. */
  knownModelProfiles?: readonly string[];
}

export function compileDefinition(input: unknown, options: CompileOptions = {}): CompileResult {
  const parsed = CorralDefinition.safeParse(input);
  if (!parsed.success) return fail(schemaDiagnostics(input, parsed.error.issues));
  const definition = parsed.data;

  const context = new Context(definition);
  if (definition.nodes.length > 20)
    context.error('SCHEMA_INVALID', 'this version supports at most 20 nodes per Corral');
  checkIdentity(context, options);
  if (context.hasErrors()) return fail(context.diagnostics);
  checkStructure(context);
  // Problems that make graph analysis meaningless stop here; the rest are reported together.
  if (context.diagnostics.some((d) => BLOCKING.has(d.code))) return fail(context.diagnostics);
  const graph = analyzeGraph(context);
  if (context.hasErrors() || !graph) return fail(context.diagnostics);
  checkCapabilities(context, graph);
  checkBindings(context, graph);
  checkReviewerCriteria(context);
  checkReviewRecipes(context);
  checkModelProfiles(context, options);
  if (context.hasErrors()) return fail(context.diagnostics);

  return {
    ok: true,
    definition,
    plan: lower(context, graph),
    diagnostics: sortDiagnostics(context.diagnostics),
  };
}

const BLOCKING = new Set<DiagnosticCode>([
  'INVALID_PORT',
  'CALLABLE_IN_CONTROL_FLOW',
  'DUPLICATE_PORT_EDGE',
  'LOOP_BOUNDARY',
  'ENTRY_INVALID',
]);

function checkReviewRecipes(c: Context) {
  for (const loop of c.definition.nodes) {
    if (loop.type !== 'loop' || !loop.reviewRecipe) continue;
    const recipe = loop.reviewRecipe,
      candidate = c.nodes.get(recipe.candidateNodeId);
    const preparation = recipe.preparationNodeId ? c.nodes.get(recipe.preparationNodeId) : null;
    const members = c.definition.nodes.filter(
      (node) => 'loopId' in node && node.loopId === loop.id,
    );
    const reviewer = members.find(
      (node) => node.type === 'agent' && node.roleId === recipe.evaluatorRoleId,
    );
    const decision = members.find((node) => node.type === 'decision' && node.mode === 'review');
    const edge = (from: string, port: string, to: string, targetPort = 'in') =>
      c.definition.controlEdges.some(
        (edge) =>
          edge.source === from &&
          edge.sourcePort === port &&
          edge.target === to &&
          edge.targetPort === targetPort,
      );
    if (recipe.criteriaHash !== reviewCriteriaHash(c.definition.input.criteria))
      c.error('REVIEW_CONTRACT', 'recipe criteria changed; save a new recipe revision', {
        nodeId: loop.id,
      });
    if (
      members.length !== (recipe.preparationNodeId ? 4 : 3) ||
      (recipe.preparationNodeId &&
        (preparation?.type !== 'agent' ||
          preparation.invocation !== 'scheduled' ||
          preparation.loopId !== loop.id ||
          preparation.id === candidate?.id ||
          preparation.id === reviewer?.id ||
          !edge(loop.id, 'body', preparation.id) ||
          !edge(preparation.id, 'out', recipe.candidateNodeId))) ||
      candidate?.type !== 'agent' ||
      candidate.loopId !== loop.id ||
      candidate.invocation !== 'scheduled' ||
      reviewer?.type !== 'agent' ||
      reviewer.id === candidate.id ||
      c.roleOf(reviewer.id)?.outputContract !== 'review' ||
      decision?.type !== 'decision' ||
      (!recipe.preparationNodeId && !edge(loop.id, 'body', candidate.id)) ||
      !edge(candidate.id, 'out', reviewer.id) ||
      !edge(reviewer.id, 'out', decision.id) ||
      !edge(decision.id, 'pass', loop.id, 'exit') ||
      !edge(decision.id, 'revise', loop.id, 'repeat') ||
      !reviewer.inputBindings.some(
        (binding) => binding.kind === 'task_output' && binding.sourceNodeId === candidate.id,
      ) ||
      !reviewer.inputBindings.some(
        (binding) => binding.kind === 'run_input' && binding.name === 'criteria',
      ) ||
      decision.inputBindings[0]?.sourceNodeId !== reviewer.id
    )
      c.error(
        'REVIEW_CONTRACT',
        'recipe requires a candidate, criteria-bound reviewer and review decision in this Loop',
        { nodeId: loop.id },
      );
  }
}

/**
 * A reviewer that is not given the criteria text can only guess what to check (#20). A warning:
 * the Corral still runs, and the editor offers to add the input.
 */
function checkReviewerCriteria(c: Context) {
  const contracts = new Map(c.definition.roles.map((r) => [r.id, r.outputContract]));
  for (const node of c.definition.nodes) {
    if (node.type !== 'agent' || contracts.get(node.roleId) !== 'review') continue;
    if (node.inputBindings.some((b) => b.kind === 'run_input' && b.name === 'criteria')) continue;
    c.diagnostics.push({
      code: 'REVIEW_WITHOUT_CRITERIA',
      severity: 'warning',
      message: 'this reviewer does not receive the criteria; add the run input "criteria"',
      nodeId: node.id,
    });
  }
}

// ── context ───────────────────────────────────────────────────────────────────

class Context {
  readonly diagnostics: Diagnostic[] = [];
  readonly nodes = new Map<string, CorralNode>();
  readonly loop: CorralNode | undefined;
  readonly definition: CorralDefinition;

  constructor(definition: CorralDefinition) {
    this.definition = definition;
    for (const node of definition.nodes)
      if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    this.loop = definition.nodes.find((node) => node.type === 'loop');
  }

  error(
    code: DiagnosticCode,
    message: string,
    at: Omit<Diagnostic, 'code' | 'message' | 'severity'> = {},
  ) {
    this.diagnostics.push({ code, severity: 'error', message, ...at });
  }

  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  loopIdOf(nodeId: string): string | null {
    const node = this.nodes.get(nodeId);
    return node && 'loopId' in node && node.loopId ? node.loopId : null;
  }

  isCallable(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    return node?.type === 'agent' && node.invocation === 'callable';
  }

  roleOf(nodeId: string) {
    const node = this.nodes.get(nodeId);
    return node?.type === 'agent'
      ? this.definition.roles.find((r) => r.id === node.roleId)
      : undefined;
  }
}

function fail(diagnostics: Diagnostic[]): CompileResult {
  return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const key = (d: Diagnostic) =>
    [d.severity, d.code, d.nodeId ?? '', d.edgeId ?? '', d.linkId ?? '', d.message].join('\u0000');
  return [...diagnostics].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Plain words for what an unfinished draft is missing; other issues keep the schema text. */
function plainMessage(issue: { path: PropertyKey[]; code?: string }): string | null {
  const path = issue.path.map(String).join('.');
  if (issue.code === 'too_small') {
    if (path === 'nodes') return 'Add at least two nodes: an Agent and an Output.';
    if (path === 'controlEdges') return 'Connect the nodes to define the order.';
    if (path === 'roles') return 'Add at least one Agent.';
    if (/^nodes\.\d+\.inputBindings$/.test(path)) return 'This node needs at least one input.';
  }
  if (path === 'entryNodeId') return 'Add an Agent where the flow starts.';
  return null;
}

function schemaDiagnostics(
  input: unknown,
  issues: { path: PropertyKey[]; message: string; code?: string }[],
): Diagnostic[] {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const idAt = (collection: string, index: PropertyKey | undefined): string | undefined => {
    const list = raw[collection];
    const item = Array.isArray(list) && typeof index === 'number' ? list[index] : undefined;
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? id : undefined;
  };
  return issues.map((issue) => {
    const [collection, index] = issue.path;
    const id = typeof collection === 'string' ? idAt(collection, index) : undefined;
    const at =
      collection === 'nodes' && id
        ? { nodeId: id }
        : collection === 'controlEdges' && id
          ? { edgeId: id }
          : collection === 'capabilityLinks' && id
            ? { linkId: id }
            : {};
    const path = issue.path.map(String).join('.') || '(root)';
    return {
      code: 'SCHEMA_INVALID',
      severity: 'error',
      message: plainMessage(issue) ?? `${path}: ${issue.message}`,
      ...at,
    };
  });
}

// ── identity and references ─────────────────────────────────────────────────

function checkIdentity(c: Context, options: CompileOptions) {
  const { definition } = c;
  const seen = new Set<string>();
  for (const node of definition.nodes) {
    if (seen.has(node.id))
      c.error('DUPLICATE_ID', `node id ${node.id} is used twice`, { nodeId: node.id });
    seen.add(node.id);
  }
  const roles = new Set<string>();
  for (const role of definition.roles) {
    if (roles.has(role.id)) c.error('DUPLICATE_ID', `role id ${role.id} is used twice`);
    roles.add(role.id);
  }
  if (
    definition.planOwnerRoleId &&
    (!roles.has(definition.planOwnerRoleId) ||
      definition.nodes.filter((n) => n.type === 'agent' && n.roleId === definition.planOwnerRoleId)
        .length !== 1)
  )
    c.error(
      'UNKNOWN_REFERENCE',
      'the team plan owner must name one role with exactly one agent node',
    );
  const connections = new Set<string>();
  for (const edge of definition.controlEdges) {
    if (connections.has(edge.id))
      c.error('DUPLICATE_ID', `connection id ${edge.id} is used twice`, { edgeId: edge.id });
    connections.add(edge.id);
  }
  for (const link of definition.capabilityLinks) {
    if (connections.has(link.id))
      c.error('DUPLICATE_ID', `connection id ${link.id} is used twice`, { linkId: link.id });
    connections.add(link.id);
  }

  if (!c.nodes.has(definition.entryNodeId)) {
    c.error('UNKNOWN_REFERENCE', `entry node ${definition.entryNodeId} does not exist`);
  }
  for (const node of definition.nodes) {
    if (node.type === 'agent' && !roles.has(node.roleId)) {
      c.error('UNKNOWN_REFERENCE', `role ${node.roleId} does not exist`, { nodeId: node.id });
    }
    if ('loopId' in node && node.loopId && c.nodes.get(node.loopId)?.type !== 'loop') {
      c.error('UNKNOWN_REFERENCE', `${node.loopId} is not a Loop`, { nodeId: node.id });
    }
    if (node.type !== 'loop') {
      for (const binding of node.inputBindings) {
        if (binding.sourceNodeId && !c.nodes.has(binding.sourceNodeId)) {
          c.error(
            'UNKNOWN_REFERENCE',
            `input "${binding.name}" reads from missing node ${binding.sourceNodeId}`,
            {
              nodeId: node.id,
            },
          );
        }
      }
    }
  }
  for (const edge of definition.controlEdges) {
    for (const end of [edge.source, edge.target]) {
      if (!c.nodes.has(end))
        c.error('UNKNOWN_REFERENCE', `node ${end} does not exist`, { edgeId: edge.id });
    }
  }
  for (const link of definition.capabilityLinks) {
    for (const end of [link.sourceNodeId, link.targetNodeId]) {
      if (!c.nodes.has(end))
        c.error('UNKNOWN_REFERENCE', `node ${end} does not exist`, { linkId: link.id });
    }
  }
  const loops = definition.nodes.filter((node) => node.type === 'loop');
  for (const extra of loops.slice(1)) {
    c.error('TOO_MANY_LOOPS', 'this version supports one Loop per Corral', { nodeId: extra.id });
  }
}

// ── ports, decisions, loop structure and boundary ────────────────────────────

function checkStructure(c: Context) {
  const { definition } = c;
  const usedPorts = new Set<string>();
  const outgoing = new Map<string, ControlEdge[]>();
  const incoming = new Map<string, ControlEdge[]>();

  for (const edge of definition.controlEdges) {
    const source = c.nodes.get(edge.source) as CorralNode;
    const target = c.nodes.get(edge.target) as CorralNode;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);

    if (c.isCallable(edge.source) || c.isCallable(edge.target)) {
      c.error(
        'CALLABLE_IN_CONTROL_FLOW',
        'callable agents run only when another agent calls them',
        {
          edgeId: edge.id,
        },
      );
      continue;
    }
    if (!outputPortsOf(source).includes(edge.sourcePort)) {
      c.error('INVALID_PORT', `${source.type} has no "${edge.sourcePort}" output`, {
        edgeId: edge.id,
      });
    }
    if (!inputPortsOf(target).includes(edge.targetPort)) {
      c.error('INVALID_PORT', `${target.type} has no "${edge.targetPort}" input`, {
        edgeId: edge.id,
      });
    }
    const port = `${edge.source}:${edge.sourcePort}`;
    if (usedPorts.has(port)) {
      c.error(
        'DUPLICATE_PORT_EDGE',
        `"${edge.sourcePort}" of ${edge.source} already has a next step`,
        {
          edgeId: edge.id,
        },
      );
    }
    usedPorts.add(port);
    checkBoundary(c, edge, source, target);
  }

  for (const node of definition.nodes) {
    const out = (outgoing.get(node.id) ?? []).map((e) => e.sourcePort);
    if (node.type === 'decision') {
      if (DECISION_RULE[node.mode] !== node.rule) {
        c.error(
          'DECISION_RULE',
          `${node.mode} decisions use the ${DECISION_RULE[node.mode]} rule`,
          { nodeId: node.id },
        );
      }
      const missing = REQUIRED_BRANCHES[node.mode].filter((p) => !out.includes(p));
      if (missing.length > 0) {
        c.error('DECISION_BRANCH_MISSING', `connect the ${missing.join(', ')} branch`, {
          nodeId: node.id,
        });
      }
    }
    if (node.type === 'agent' && node.invocation === 'scheduled' && out.length === 0) {
      c.error('DEAD_END', 'this agent has no next step', { nodeId: node.id });
    }
    if (node.type === 'agent' && node.invocation === 'callable' && node.loopId) {
      c.error('LOOP_STRUCTURE', 'callable agents cannot be Loop members', { nodeId: node.id });
    }
    if ((node.type === 'output' || node.type === 'loop') && 'loopId' in node && node.loopId) {
      c.error('LOOP_STRUCTURE', `${node.type} nodes cannot be inside a Loop`, { nodeId: node.id });
    }
  }

  const entry = c.nodes.get(definition.entryNodeId);
  if (entry?.type !== 'agent' || entry.invocation !== 'scheduled' || entry.loopId) {
    c.error('ENTRY_INVALID', 'the entry must be a scheduled agent outside any Loop', {
      nodeId: definition.entryNodeId,
    });
  }

  const loop = c.loop;
  if (loop?.type === 'loop') {
    const out = outgoing.get(loop.id) ?? [];
    const into = incoming.get(loop.id) ?? [];
    const members = definition.nodes.filter((n) => 'loopId' in n && n.loopId === loop.id);
    const problems: string[] = [];
    if (members.length === 0) problems.push('put at least one node inside the Loop');
    if (!out.some((e) => e.sourcePort === 'body'))
      problems.push('connect "body" to the first node inside');
    if (!out.some((e) => e.sourcePort === 'next'))
      problems.push('connect "next" to the step after the Loop');
    if (!into.some((e) => e.targetPort === 'enter')) problems.push('connect a step into "enter"');
    if (!into.some((e) => e.targetPort === 'repeat'))
      problems.push('connect a branch inside the Loop to "repeat"');
    if (!into.some((e) => e.targetPort === 'exit'))
      problems.push('connect a branch inside the Loop to "exit"');
    for (const problem of problems) c.error('LOOP_STRUCTURE', problem, { nodeId: loop.id });
  }
}

function checkBoundary(c: Context, edge: ControlEdge, source: CorralNode, target: CorralNode) {
  const why = loopBoundaryViolation(source, edge.sourcePort, target, edge.targetPort);
  if (why) c.error('LOOP_BOUNDARY', why, { edgeId: edge.id });
}

// ── graph: cycles, reachability, order ──────────────────────────────────────

interface Graph {
  /** Scheduled nodes in execution order. */
  order: string[];
  /** ancestors.get(x) = scheduled nodes that always run before x in one pass. */
  ancestors: Map<string, Set<string>>;
  reached: Set<string>;
  callableDepth: Map<string, number>;
  maxStaticDepth: number;
}

// A Loop is split in two virtual vertices: L#in (enter, repeat → body) and L#out (exit → next).
// Edges into "repeat" are the only back edges a Corral may have.
function analyzeGraph(c: Context): Graph | null {
  const { definition } = c;
  const vertexOfTarget = (edge: ControlEdge) => {
    const target = c.nodes.get(edge.target) as CorralNode;
    if (target.type !== 'loop') return edge.target;
    return edge.targetPort === 'exit' ? `${target.id}#out` : `${target.id}#in`;
  };
  const vertexOfSource = (edge: ControlEdge) => {
    const source = c.nodes.get(edge.source) as CorralNode;
    if (source.type !== 'loop') return edge.source;
    return edge.sourcePort === 'next' ? `${source.id}#out` : `${source.id}#in`;
  };

  const adjacency = new Map<string, { to: string; edge: ControlEdge }[]>();
  for (const edge of definition.controlEdges) {
    if (edge.targetPort === 'repeat') continue;
    const from = vertexOfSource(edge);
    adjacency.set(from, [...(adjacency.get(from) ?? []), { to: vertexOfTarget(edge), edge }]);
  }

  // Depth-first search from the entry: an edge to a vertex on the stack closes a cycle.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (vertex: string) => {
    state.set(vertex, 'open');
    for (const { to, edge } of adjacency.get(vertex) ?? []) {
      if (state.get(to) === 'open') {
        c.error('CYCLE_OUTSIDE_LOOP', 'this connection closes a cycle; repeat work with a Loop', {
          edgeId: edge.id,
        });
      } else if (!state.has(to)) {
        visit(to);
      }
    }
    state.set(vertex, 'done');
  };
  visit(definition.entryNodeId);
  if (c.diagnostics.some((d) => d.code === 'CYCLE_OUTSIDE_LOOP')) return null;

  const reached = new Set<string>();
  for (const vertex of state.keys()) reached.add(vertex.replace(/#(in|out)$/, ''));

  for (const node of definition.nodes) {
    const scheduled = !(node.type === 'agent' && node.invocation === 'callable');
    if (scheduled && !reached.has(node.id)) {
      c.error('UNREACHABLE', 'the flow from the entry never reaches this node', {
        nodeId: node.id,
      });
    }
  }
  if (![...reached].some((id) => c.nodes.get(id)?.type === 'output')) {
    c.error('NO_OUTPUT', 'the flow never reaches an Output');
  }

  // Topological order (Kahn) with definition order as the tie-break, so the plan is stable.
  const vertices = [...state.keys()];
  const position = new Map(definition.nodes.map((n, i) => [n.id, i]));
  const rank = (v: string) =>
    (position.get(v.replace(/#(in|out)$/, '')) ?? 0) * 2 + (v.endsWith('#out') ? 1 : 0);
  const indegree = new Map(vertices.map((v) => [v, 0]));
  for (const v of vertices)
    for (const { to } of adjacency.get(v) ?? []) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const ready = vertices.filter((v) => indegree.get(v) === 0);
  const ordered: string[] = [];
  const ancestors = new Map<string, Set<string>>(vertices.map((v) => [v, new Set<string>()]));
  while (ready.length > 0) {
    ready.sort((a, b) => rank(a) - rank(b));
    const v = ready.shift() as string;
    ordered.push(v);
    for (const { to } of adjacency.get(v) ?? []) {
      const set = ancestors.get(to) as Set<string>;
      for (const a of ancestors.get(v) ?? []) set.add(a);
      set.add(v.replace(/#(in|out)$/, ''));
      indegree.set(to, (indegree.get(to) ?? 0) - 1);
      if (indegree.get(to) === 0) ready.push(to);
    }
  }
  const order = ordered.filter((v) => !v.endsWith('#out')).map((v) => v.replace(/#in$/, ''));
  const nodeAncestors = new Map<string, Set<string>>();
  for (const [v, set] of ancestors) {
    if (!v.endsWith('#out')) nodeAncestors.set(v.replace(/#in$/, ''), set);
  }

  // Capability reachability: minimum delegation depth and the longest static chain.
  const links = definition.capabilityLinks;
  const callableDepth = new Map<string, number>();
  const queue: (readonly [string, number])[] = definition.nodes
    .filter((n) => n.type === 'agent' && n.invocation === 'scheduled' && reached.has(n.id))
    .map((n) => [n.id, 0] as const);
  const best = new Map<string, number>(queue);
  for (let i = 0; i < queue.length; i++) {
    const [id, depth] = queue[i] as readonly [string, number];
    for (const link of links) {
      if (link.sourceNodeId !== id || !c.isCallable(link.targetNodeId)) continue;
      if ((best.get(link.targetNodeId) ?? Number.POSITIVE_INFINITY) <= depth + 1) continue;
      best.set(link.targetNodeId, depth + 1);
      callableDepth.set(link.targetNodeId, depth + 1);
      queue.push([link.targetNodeId, depth + 1]);
    }
  }
  const longest = (id: string, seen: Set<string>): number => {
    let deepest = 0;
    for (const link of links) {
      if (
        link.sourceNodeId !== id ||
        seen.has(link.targetNodeId) ||
        !c.isCallable(link.targetNodeId)
      )
        continue;
      deepest = Math.max(
        deepest,
        1 + longest(link.targetNodeId, new Set([...seen, link.targetNodeId])),
      );
    }
    return deepest;
  };
  const maxStaticDepth = Math.max(
    0,
    ...queue.filter(([, depth]) => depth === 0).map(([id]) => longest(id, new Set([id]))),
  );

  return { order, ancestors: nodeAncestors, reached, callableDepth, maxStaticDepth };
}

// ── capabilities, bindings, profiles ─────────────────────────────────────────

const TOOL_FOR: Record<CapabilityLink['kind'], 'spawn_subagents' | 'ask'> = {
  delegate: 'spawn_subagents',
  question: 'ask',
};

function checkCapabilities(c: Context, graph: Graph) {
  const limit = c.definition.limits.maxDelegationDepth;
  for (const link of c.definition.capabilityLinks) {
    const source = c.nodes.get(link.sourceNodeId);
    if (source?.type !== 'agent' || !c.isCallable(link.targetNodeId)) {
      c.error('CAPABILITY_TARGET', 'calls go from an agent to a callable agent', {
        linkId: link.id,
      });
      continue;
    }
    const role = c.roleOf(source.id);
    if (link.parentQuestions) {
      const child = c.roleOf(link.targetNodeId);
      if (link.kind !== 'delegate') {
        c.error('CAPABILITY_TARGET', 'parent questions are an opt-in on delegate links only', {
          linkId: link.id,
        });
      }
      if (
        !role?.allowedCollaborationTools.includes('reply') ||
        !child?.allowedCollaborationTools.includes('ask')
      ) {
        c.error(
          'CAPABILITY_NOT_ALLOWED',
          'parent questions require the parent to allow reply and the child to allow ask',
          { linkId: link.id },
        );
      }
    }
    if (!role?.allowedCollaborationTools.includes(TOOL_FOR[link.kind])) {
      c.error(
        'CAPABILITY_NOT_ALLOWED',
        `the ${role?.id ?? 'source'} role may not use ${TOOL_FOR[link.kind]}`,
        {
          linkId: link.id,
        },
      );
    }
  }
  for (const node of c.definition.nodes) {
    if (!c.isCallable(node.id)) continue;
    const depth = graph.callableDepth.get(node.id);
    if (depth === undefined) {
      c.error('UNREACHABLE', 'no reachable agent may call this agent', { nodeId: node.id });
    } else if (depth > limit) {
      c.error(
        'DEPTH_EXCEEDED',
        `reachable only at delegation depth ${depth}; the limit is ${limit}`,
        {
          nodeId: node.id,
        },
      );
    }
  }
}

function checkBindings(c: Context, graph: Graph) {
  const asks = new Set(
    c.definition.capabilityLinks.flatMap((link) =>
      link.kind === 'question'
        ? [link.sourceNodeId]
        : link.parentQuestions
          ? [link.targetNodeId]
          : [],
    ),
  );
  for (const node of c.definition.nodes) {
    if (node.type === 'loop') continue;
    const bad = (why: string) => c.error('BINDING_SOURCE', why, { nodeId: node.id });
    const callable = c.isCallable(node.id);
    const before = graph.ancestors.get(node.id) ?? new Set<string>();
    for (const binding of node.inputBindings) {
      const label = `input "${binding.name}"`;
      const source = binding.sourceNodeId ? c.nodes.get(binding.sourceNodeId) : undefined;
      switch (binding.kind) {
        case 'run_input':
          if (binding.name !== 'brief' && binding.name !== 'criteria')
            bad(`${label}: run inputs are "brief" and "criteria"`);
          break;
        case 'task_output':
          if (source?.type !== 'agent' || source.invocation !== 'scheduled') {
            bad(`${label} must read a scheduled agent's output`);
          } else if (!callable && !before.has(source.id)) {
            bad(`${label} reads ${source.id}, which does not run before this node`);
          }
          break;
        case 'previous_iteration_output': {
          const loopId = c.loopIdOf(node.id);
          if (!loopId || !source || c.loopIdOf(source.id) !== loopId) {
            bad(`${label} must read a node in the same Loop`);
          } else if (!binding.optional) {
            bad(`${label} must be optional: the first iteration has no previous output`);
          }
          break;
        }
        case 'explicit_version':
          if (!binding.artifactVersionId) bad(`${label} needs an artifact version`);
          break;
        case 'question_answer':
          if (!asks.has(node.id)) bad(`${label} needs a question link from this agent`);
          break;
      }
    }
    if (node.type === 'decision' && node.mode === 'review') {
      const reviewed = node.inputBindings.some(
        (b) =>
          b.kind === 'task_output' &&
          b.sourceNodeId &&
          c.roleOf(b.sourceNodeId)?.outputContract === 'review',
      );
      if (!reviewed) {
        c.error(
          'REVIEW_CONTRACT',
          'a review decision reads the output of an agent with the review contract',
          {
            nodeId: node.id,
          },
        );
      }
    }
    if (node.type === 'output' && node.inputBindings.some((b) => b.kind !== 'task_output')) {
      bad('an Output receives submitted task outputs only');
    }
  }
}

function checkModelProfiles(c: Context, options: CompileOptions) {
  if (!options.knownModelProfiles) return;
  const known = new Set(options.knownModelProfiles);
  for (const role of c.definition.roles) {
    if (known.has(role.modelProfile)) continue;
    const user = c.definition.nodes.find((n) => n.type === 'agent' && n.roleId === role.id);
    c.error(
      'UNKNOWN_MODEL_PROFILE',
      `model profile ${role.modelProfile} (role ${role.id}) is not configured`,
      {
        ...(user ? { nodeId: user.id } : {}),
      },
    );
  }
}

// ── lowering ─────────────────────────────────────────────────────────────────

function lower(c: Context, graph: Graph): CompiledPlan {
  const { definition } = c;
  const targetOf = (source: string, port: SourcePort): PlanTarget | null => {
    const edge = definition.controlEdges.find((e) => e.source === source && e.sourcePort === port);
    return edge ? { nodeId: edge.target, port: edge.targetPort } : null;
  };

  const steps: Record<string, PlanStep> = {};
  for (const id of graph.order) {
    const node = c.nodes.get(id) as CorralNode;
    switch (node.type) {
      case 'agent':
        steps[id] = {
          kind: 'agent',
          nodeId: id,
          roleId: node.roleId,
          loopId: node.loopId ?? null,
          next: targetOf(id, 'out'),
        };
        break;
      case 'decision':
        steps[id] = {
          kind: 'decision',
          nodeId: id,
          mode: node.mode,
          rule: node.rule,
          loopId: node.loopId ?? null,
          branches: Object.fromEntries(
            DECISION_PORTS[node.mode].map((port) => [port, targetOf(id, port)]),
          ),
        };
        break;
      case 'loop':
        steps[id] = {
          kind: 'loop',
          nodeId: id,
          maxIterations: node.reviewRecipe
            ? Math.min(node.maxIterations, recipeAttempts(node.reviewRecipe))
            : node.maxIterations,
          body: targetOf(id, 'body') as PlanTarget,
          next: targetOf(id, 'next') as PlanTarget,
        };
        break;
      case 'output':
        steps[id] = { kind: 'output', nodeId: id, requireApproval: node.requireApproval };
        break;
    }
  }

  const loops: Record<string, LoopPlan> = {};
  for (const id of graph.order) {
    const step = steps[id];
    if (step?.kind !== 'loop') continue;
    loops[id] = {
      nodeId: id,
      maxIterations: step.maxIterations,
      bodyEntryNodeId: step.body.nodeId,
      members: graph.order.filter((member) => c.loopIdOf(member) === id),
      next: step.next,
    };
  }

  const callables: CompiledPlan['callables'] = {};
  for (const link of definition.capabilityLinks) {
    const entry = callables[link.sourceNodeId] ?? { delegate: [], question: [] };
    entry[link.kind].push(link.targetNodeId);
    callables[link.sourceNodeId] = entry;
    if (link.kind === 'delegate' && link.parentQuestions) {
      entry.replyToChildren = true;
      const child = callables[link.targetNodeId] ?? { delegate: [], question: [] };
      child.parentQuestion = [...new Set([...(child.parentQuestion ?? []), link.sourceNodeId])];
      callables[link.targetNodeId] = child;
    }
  }

  const agents = definition.nodes.filter((n): n is AgentNode => n.type === 'agent');
  return {
    entryNodeId: definition.entryNodeId,
    order: graph.order,
    steps,
    loops,
    callables,
    summary: {
      scheduledAgents: agents.filter((a) => a.invocation === 'scheduled').length,
      callableAgents: agents.filter((a) => a.invocation === 'callable').length,
      decisions: definition.nodes.filter((n) => n.type === 'decision').length,
      loops: Object.keys(loops).length,
      outputs: definition.nodes.filter((n) => n.type === 'output').length,
      maxStaticDepth: graph.maxStaticDepth,
    },
  };
}
