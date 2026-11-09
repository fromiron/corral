import {
  type AgentNode,
  type CapabilityLink,
  type ControlEdge,
  CorralDefinition,
  type CorralNode,
  type DecisionNodeMode,
  type DecisionRule,
  type JoinNode,
  type LoopNode,
  type RouterRoute,
  type TargetPort,
  type WorkTool,
} from '@corral/contracts';
import { SPEC_HARD_CAPS } from '../config.ts';
import { recipeAttempts, reviewCriteriaHash } from '../review-recipe.ts';
import { vertexOf } from './cycles.ts';
import {
  boxBoundaryViolation,
  DECISION_RULE,
  decisionPortsOf,
  inputPortsOf,
  isBox,
  isWithin,
  outputPortsOf,
  requiredBranchesOf,
} from './ports.ts';

export { vertexOf, wouldCreateCycle } from './cycles.ts';
export * from './ports.ts';

// Static validation and IR lowering (docs/specs/features/team-graph.md). The editor shows these
// diagnostics, and the runtime compiles again before running: the editor is not a trust boundary.

export type DiagnosticCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_REFERENCE'
  | 'BOX_PARENT'
  | 'CONTAINMENT_CYCLE'
  | 'TEAM_REFERENCE_MEMBERS'
  | 'INVALID_PORT'
  | 'CALLABLE_IN_CONTROL_FLOW'
  | 'BOX_BOUNDARY'
  | 'ENTRY_INVALID'
  | 'DEAD_END'
  | 'DECISION_RULE'
  | 'DECISION_BRANCH_MISSING'
  | 'ROUTER_ROUTES'
  | 'LOOP_NO_BODY'
  | 'LOOP_NO_EXIT'
  | 'LOOP_NO_REPEAT'
  | 'REPEAT_NEEDS_DECISION'
  | 'LOOP_DEAD_END'
  | 'TEAM_NO_MEMBERS'
  | 'TEAM_NO_BODY'
  | 'TEAM_NO_EXIT'
  | 'TEAM_INPUTS_INLINE'
  | 'TEAM_REF_NOT_FOUND'
  | 'TEAM_REF_CYCLE'
  | 'TEAM_REF_INVALID'
  | 'CYCLE_OUTSIDE_LOOP'
  | 'PARALLEL_MERGE_NEEDS_JOIN'
  | 'PARALLEL_UNJOINED'
  | 'JOIN_PARTIAL'
  | 'JOIN_SINGLE_INPUT'
  | 'PARALLEL_WRITERS'
  | 'UNREACHABLE'
  | 'NO_OUTPUT'
  | 'CAPABILITY_TARGET'
  | 'CAPABILITY_NOT_ALLOWED'
  | 'DEPTH_EXCEEDED'
  | 'BINDING_SOURCE'
  | 'REVIEW_CONTRACT'
  | 'REVIEW_WITHOUT_CRITERIA'
  | 'UNKNOWN_MODEL_PROFILE'
  | 'SPAWNS_CAPPED';

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

interface StepBase {
  nodeId: string;
  /** The box that holds this step. */
  parentId: string | null;
  /** The innermost Loop that holds this step. */
  loopId: string | null;
}

/** Each port leads to a list of targets: more than one is a parallel fan-out. */
export type PlanStep =
  | (StepBase & {
      kind: 'agent';
      roleId: string;
      next: PlanTarget[];
      error: PlanTarget[];
      retry: number;
    })
  | (StepBase & {
      kind: 'decision';
      mode: DecisionNodeMode;
      rule: DecisionRule | null;
      routes: RouterRoute[];
      branches: Record<string, PlanTarget[]>;
    })
  | (StepBase & {
      kind: 'loop';
      maxIterations: number;
      body: PlanTarget[];
      next: PlanTarget[];
      exhausted: PlanTarget[];
    })
  | (StepBase & {
      kind: 'team';
      source: 'inline' | 'reference';
      body: PlanTarget[];
      next: PlanTarget[];
    })
  | (StepBase & {
      kind: 'join';
      policy: JoinNode['policy'];
      next: PlanTarget[];
      /**
       * The fan-out whose branches this Join gathers: the source port (`node\u0000port`) and its
       * number of branches. Null when every connection in comes from one branch: it passes on.
       */
      gathers: { port: string; width: number } | null;
    })
  | (StepBase & { kind: 'output'; requireApproval: boolean });

export interface LoopPlan {
  nodeId: string;
  parentId: string | null;
  maxIterations: number;
  stallDetection: boolean;
  body: PlanTarget[];
  /** Direct members in execution order. */
  members: string[];
  next: PlanTarget[];
  exhausted: PlanTarget[];
}

export interface BoxPlan {
  nodeId: string;
  kind: 'loop' | 'team';
  parentId: string | null;
  members: string[];
}

export interface ReferencePlan {
  corralId: string;
  definitionRevision: number;
  plan: CompiledPlan;
}

export interface CompiledPlan {
  entryNodeId: string;
  /** Scheduled nodes in execution order (loop body once). Callable agents never appear here. */
  order: string[];
  steps: Record<string, PlanStep>;
  loops: Record<string, LoopPlan>;
  /** The box tree: every Loop and Team with its parent and direct members. */
  boxes: Record<string, BoxPlan>;
  /** The compiled plan of each referenced Team, by Team node id. */
  references: Record<string, ReferencePlan>;
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
    teams: number;
    joins: number;
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
  /**
   * The definition source for `reference` Teams: a saved team at a fixed revision, as stored.
   * Without it no reference resolves.
   */
  resolveTeam?: (corralId: string, definitionRevision: number) => unknown;
}

export function compileDefinition(input: unknown, options: CompileOptions = {}): CompileResult {
  return compile(input, options, []);
}

function compile(input: unknown, options: CompileOptions, teams: readonly string[]): CompileResult {
  const parsed = CorralDefinition.safeParse(input);
  if (!parsed.success) return fail(schemaDiagnostics(input, parsed.error.issues));
  const definition = parsed.data;

  const context = new Context(definition);
  checkIdentity(context);
  if (context.hasErrors()) return fail(context.diagnostics);
  checkContainment(context);
  if (context.hasErrors()) return fail(context.diagnostics);
  checkReferences(context, options, [...teams, definition.sourceTeam?.corralId ?? definition.id]);
  checkStructure(context);
  // Problems that make graph analysis meaningless stop here; the rest are reported together.
  if (context.diagnostics.some((d) => BLOCKING.has(d.code))) return fail(context.diagnostics);
  const graph = analyzeGraph(context);
  if (!graph) return fail(context.diagnostics);
  checkCapabilities(context, graph);
  checkBindings(context, graph);
  checkReviewerCriteria(context);
  checkReviewRecipes(context);
  checkModelProfiles(context, options);
  if (context.hasErrors()) return fail(context.diagnostics);
  checkSpawnCap(context);

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
  'BOX_BOUNDARY',
  'ENTRY_INVALID',
]);

function checkReviewRecipes(c: Context) {
  for (const loop of c.definition.nodes) {
    if (loop.type !== 'loop' || !loop.reviewRecipe) continue;
    const recipe = loop.reviewRecipe,
      candidate = c.nodes.get(recipe.candidateNodeId);
    const preparation = recipe.preparationNodeId ? c.nodes.get(recipe.preparationNodeId) : null;
    const members = c.definition.nodes.filter((node) => node.parentId === loop.id);
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
          preparation.parentId !== loop.id ||
          preparation.id === candidate?.id ||
          preparation.id === reviewer?.id ||
          !edge(loop.id, 'body', preparation.id) ||
          !edge(preparation.id, 'out', recipe.candidateNodeId))) ||
      candidate?.type !== 'agent' ||
      candidate.parentId !== loop.id ||
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
    c.warn(
      'REVIEW_WITHOUT_CRITERIA',
      'this reviewer does not receive the criteria; add the run input "criteria"',
      { nodeId: node.id },
    );
  }
}

// ── context ───────────────────────────────────────────────────────────────────

type At = Omit<Diagnostic, 'code' | 'message' | 'severity'>;

class Context {
  readonly diagnostics: Diagnostic[] = [];
  readonly nodes = new Map<string, CorralNode>();
  readonly definition: CorralDefinition;
  readonly references = new Map<string, ReferencePlan>();
  readonly outgoing = new Map<string, ControlEdge[]>();
  readonly incoming = new Map<string, ControlEdge[]>();
  /** What each Join gathers, found by the parallel check. */
  readonly gathers = new Map<string, { port: string; width: number }>();

  constructor(definition: CorralDefinition) {
    this.definition = definition;
    for (const node of definition.nodes)
      if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    for (const edge of definition.controlEdges) {
      this.outgoing.set(edge.source, [...(this.outgoing.get(edge.source) ?? []), edge]);
      this.incoming.set(edge.target, [...(this.incoming.get(edge.target) ?? []), edge]);
    }
  }

  error(code: DiagnosticCode, message: string, at: At = {}) {
    this.diagnostics.push({ code, severity: 'error', message, ...at });
  }

  warn(code: DiagnosticCode, message: string, at: At = {}) {
    this.diagnostics.push({ code, severity: 'warning', message, ...at });
  }

  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  /** Loops around a node, innermost first. */
  loopsAround(nodeId: string): string[] {
    const loops: string[] = [];
    const seen = new Set<string>();
    for (let at = this.nodes.get(nodeId)?.parentId; at && !seen.has(at); ) {
      seen.add(at);
      const box = this.nodes.get(at);
      if (box?.type === 'loop') loops.push(at);
      at = box?.parentId;
    }
    return loops;
  }

  nearestLoop(nodeId: string): string | null {
    return this.loopsAround(nodeId)[0] ?? null;
  }

  membersOf(boxId: string): CorralNode[] {
    return this.definition.nodes.filter((node) => node.parentId === boxId);
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

// ── identity, containment and references ────────────────────────────────────

function checkIdentity(c: Context) {
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
    if (node.parentId && !c.nodes.has(node.parentId)) {
      c.error('UNKNOWN_REFERENCE', `box ${node.parentId} does not exist`, { nodeId: node.id });
    }
    if ('inputBindings' in node) {
      for (const binding of node.inputBindings ?? []) {
        if (binding.sourceNodeId && !c.nodes.has(binding.sourceNodeId)) {
          c.error(
            'UNKNOWN_REFERENCE',
            `input "${binding.name}" reads from missing node ${binding.sourceNodeId}`,
            { nodeId: node.id },
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
}

function checkContainment(c: Context) {
  for (const node of c.definition.nodes) {
    if (!node.parentId) continue;
    const parent = c.nodes.get(node.parentId) as CorralNode;
    if (parent.type === 'team' && parent.source.kind === 'reference') {
      c.error('TEAM_REFERENCE_MEMBERS', 'a referenced Team brings its own members', {
        nodeId: node.id,
      });
    } else if (!isBox(parent)) {
      c.error('BOX_PARENT', `${parent.id} is not a Loop or a Team`, { nodeId: node.id });
    } else if (c.isCallable(node.id)) {
      c.error('BOX_PARENT', 'callable agents run only when called and stay outside boxes', {
        nodeId: node.id,
      });
    }
    const seen = new Set<string>();
    for (let at: string | undefined = node.parentId; at && !seen.has(at); ) {
      if (at === node.id) {
        c.error('CONTAINMENT_CYCLE', 'this box ends up inside itself', { nodeId: node.id });
        break;
      }
      seen.add(at);
      at = c.nodes.get(at)?.parentId;
    }
  }
}

/** Resolves and compiles every referenced Team; `teams` are the Corrals already being compiled. */
function checkReferences(c: Context, options: CompileOptions, teams: readonly string[]) {
  for (const node of c.definition.nodes) {
    if (node.type !== 'team' || node.source.kind !== 'reference') continue;
    const { corralId, definitionRevision } = node.source;
    const at = { nodeId: node.id };
    if (teams.includes(corralId)) {
      c.error('TEAM_REF_CYCLE', `${corralId} is already being expanded; references go round`, at);
      continue;
    }
    const resolved = options.resolveTeam?.(corralId, definitionRevision);
    if (resolved === undefined || resolved === null) {
      c.error(
        'TEAM_REF_NOT_FOUND',
        `team ${corralId} revision ${definitionRevision} is not found`,
        at,
      );
      continue;
    }
    const inner = compile(resolved, options, [...teams, corralId]);
    if (inner.ok) {
      c.references.set(node.id, { corralId, definitionRevision, plan: inner.plan });
    } else if (inner.diagnostics.some((d) => d.code === 'TEAM_REF_CYCLE')) {
      c.error('TEAM_REF_CYCLE', `team ${corralId} leads back to a team being expanded`, at);
    } else {
      const first = inner.diagnostics.find((d) => d.severity === 'error');
      c.error(
        'TEAM_REF_INVALID',
        `team ${corralId} revision ${definitionRevision} does not compile: ${first?.message ?? 'invalid'}`,
        at,
      );
    }
  }
}

// ── ports, decisions, boxes and boundaries ───────────────────────────────────

function checkStructure(c: Context) {
  const { definition } = c;

  for (const edge of definition.controlEdges) {
    const source = c.nodes.get(edge.source) as CorralNode;
    const target = c.nodes.get(edge.target) as CorralNode;
    const at = { edgeId: edge.id };
    if (c.isCallable(edge.source) || c.isCallable(edge.target)) {
      c.error(
        'CALLABLE_IN_CONTROL_FLOW',
        'callable agents run only when another agent calls them',
        at,
      );
      continue;
    }
    if (!outputPortsOf(source).includes(edge.sourcePort)) {
      c.error('INVALID_PORT', `${source.type} has no "${edge.sourcePort}" output`, at);
    }
    if (!inputPortsOf(target).includes(edge.targetPort)) {
      c.error('INVALID_PORT', `${target.type} has no "${edge.targetPort}" input`, at);
    }
    const why = boxBoundaryViolation(c.nodes, edge);
    if (why) c.error('BOX_BOUNDARY', why, at);
    if (edge.targetPort === 'repeat' && source.type !== 'decision') {
      c.error('REPEAT_NEEDS_DECISION', 'only a decision sends the work round again', at);
    }
  }

  for (const node of definition.nodes) {
    const out = (c.outgoing.get(node.id) ?? []).map((e) => e.sourcePort);
    const into = c.incoming.get(node.id) ?? [];
    const at = { nodeId: node.id };
    const deadEnd = (message: string) =>
      c.nearestLoop(node.id)
        ? c.error(
            'LOOP_DEAD_END',
            `${message}; inside a Loop every path ends at exit, repeat or an Output`,
            at,
          )
        : c.error('DEAD_END', message, at);
    switch (node.type) {
      case 'agent':
        if (node.invocation === 'scheduled' && !out.includes('out'))
          deadEnd('this agent has no next step');
        break;
      case 'decision': {
        if (node.mode === 'review' || node.mode === 'approval' || node.mode === 'rule') {
          if (DECISION_RULE[node.mode] !== node.rule)
            c.error(
              'DECISION_RULE',
              `${node.mode} decisions use the ${DECISION_RULE[node.mode]} rule`,
              at,
            );
        }
        if (node.mode === 'router') {
          const ids = node.routes.map((r) => r.id);
          if (ids.length < 2)
            c.error('ROUTER_ROUTES', 'a router chooses between at least two routes', at);
          if (new Set(ids).size !== ids.length)
            c.error('ROUTER_ROUTES', 'route ids must be unique', at);
        }
        const missing = requiredBranchesOf(node).filter((p) => !out.includes(p));
        if (missing.length > 0)
          c.warn(
            'DECISION_BRANCH_MISSING',
            `connect the ${missing.join(', ')} branch; until then the run waits for you there`,
            at,
          );
        break;
      }
      case 'join':
        if (into.length < 2)
          c.warn('JOIN_SINGLE_INPUT', 'a Join waits for two or more branches', at);
        if (!out.includes('out')) deadEnd('this Join has no next step');
        break;
      case 'loop': {
        if (c.membersOf(node.id).length === 0 || !out.includes('body'))
          c.error('LOOP_NO_BODY', 'connect "body" to the first step inside the Loop', at);
        if (!into.some((e) => e.targetPort === 'exit'))
          c.error('LOOP_NO_EXIT', 'connect a branch inside the Loop to "exit"', at);
        if (!into.some((e) => e.targetPort === 'repeat'))
          c.error('LOOP_NO_REPEAT', 'connect a decision inside the Loop to "repeat"', at);
        if (into.some((e) => e.targetPort === 'exit') && !out.includes('next'))
          deadEnd('connect "next" to the step after the Loop');
        break;
      }
      case 'team':
        if (node.source.kind === 'reference') {
          if (!out.includes('next')) deadEnd('connect "next" to the step after the Team');
          break;
        }
        if (node.inputBindings?.length)
          c.error(
            'TEAM_INPUTS_INLINE',
            'steps inside an inline Team read earlier steps by name; the Team takes no inputs',
            at,
          );
        if (c.membersOf(node.id).length === 0)
          c.error('TEAM_NO_MEMBERS', 'put at least one step inside the Team', at);
        if (!out.includes('body'))
          c.error('TEAM_NO_BODY', 'connect "body" to the first step inside the Team', at);
        if (out.includes('next') && !into.some((e) => e.targetPort === 'exit'))
          c.error('TEAM_NO_EXIT', 'connect a step inside the Team to "exit"', at);
        if (into.some((e) => e.targetPort === 'exit') && !out.includes('next'))
          deadEnd('connect "next" to the step after the Team');
        break;
      case 'output':
        break;
    }
  }

  const entry = c.nodes.get(definition.entryNodeId);
  const startable =
    (entry?.type === 'agent' && entry.invocation === 'scheduled') ||
    entry?.type === 'loop' ||
    entry?.type === 'team';
  if (!startable || entry?.parentId) {
    c.error(
      'ENTRY_INVALID',
      'the flow starts at a scheduled agent, a Loop or a Team outside any box',
      {
        nodeId: definition.entryNodeId,
      },
    );
  }
}

// ── graph: cycles, reachability, order, parallel branches ───────────────────

interface Graph {
  /** Scheduled nodes in execution order; a box sits where it is entered. */
  order: string[];
  /** ancestors.get(x) = scheduled nodes that always run before x in one pass. */
  ancestors: Map<string, Set<string>>;
  reached: Set<string>;
  callableDepth: Map<string, number>;
  maxStaticDepth: number;
}

const nodeOfVertex = (vertex: string) => vertex.replace(/#(in|out)$/, '');

/**
 * Which branch of which fan-out a path is on: fan-out port → branch indexes. Two paths can be
 * alive at once when, for some fan-out, they sit on different branches.
 */
type Branches = Map<string, Set<number>>;

function mergeBranches(into: Branches, from: Branches) {
  for (const [port, indexes] of from) {
    const set = into.get(port) ?? new Set<number>();
    for (const index of indexes) set.add(index);
    into.set(port, set);
  }
}

function concurrent(a: Branches, b: Branches): boolean {
  for (const [port, indexes] of a) {
    const other = b.get(port);
    if (other && ![...indexes].some((i) => other.has(i))) return true;
  }
  return false;
}

const WRITE_TOOLS = new Set<WorkTool>(['write_file', 'delete_file', 'move_file']);

// A box is split in two virtual vertices: B#in (enter → body) and B#out (exit → next, exhausted)
// joined by B#in → B#out. Edges into "repeat" are the only back edges a Corral may have.
function analyzeGraph(c: Context): Graph | null {
  const { definition } = c;
  const adjacency = new Map<string, { to: string; edge: ControlEdge | null }[]>();
  const link = (from: string, to: string, edge: ControlEdge | null) =>
    adjacency.set(from, [...(adjacency.get(from) ?? []), { to, edge }]);
  for (const edge of definition.controlEdges) {
    if (edge.targetPort === 'repeat') continue;
    link(
      vertexOf(c.nodes, edge.source, edge.sourcePort, 'source'),
      vertexOf(c.nodes, edge.target, edge.targetPort, 'target'),
      edge,
    );
  }
  for (const node of definition.nodes)
    if (isBox(node)) link(`${node.id}#in`, `${node.id}#out`, null);

  // Depth-first search from the entry: an edge to a vertex on the stack closes a cycle.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (vertex: string) => {
    state.set(vertex, 'open');
    for (const { to, edge } of adjacency.get(vertex) ?? []) {
      if (state.get(to) === 'open') {
        if (edge)
          c.error('CYCLE_OUTSIDE_LOOP', 'this connection closes a cycle; repeat work with a Loop', {
            edgeId: edge.id,
          });
      } else if (!state.has(to)) {
        visit(to);
      }
    }
    state.set(vertex, 'done');
  };
  visit(vertexOf(c.nodes, definition.entryNodeId, 'enter', 'target'));
  if (c.diagnostics.some((d) => d.code === 'CYCLE_OUTSIDE_LOOP')) return null;

  const reached = new Set<string>();
  for (const vertex of state.keys()) reached.add(nodeOfVertex(vertex));

  for (const node of definition.nodes) {
    if (!c.isCallable(node.id) && !reached.has(node.id)) {
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
    (position.get(nodeOfVertex(v)) ?? 0) * 2 + (v.endsWith('#out') ? 1 : 0);
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
      set.add(nodeOfVertex(v));
      indegree.set(to, (indegree.get(to) ?? 0) - 1);
      if (indegree.get(to) === 0) ready.push(to);
    }
  }
  const order = ordered.filter((v) => !v.endsWith('#out')).map(nodeOfVertex);
  const nodeAncestors = new Map<string, Set<string>>();
  for (const [v, set] of ancestors) {
    if (!v.endsWith('#out')) nodeAncestors.set(nodeOfVertex(v), set);
  }

  checkParallel(c, ordered, adjacency);

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

/**
 * Parallel branches: every connection carries the fan-out branches it is on. Connections into one
 * place that can be alive at once must meet at a Join; file writers on such branches are warned.
 */
function checkParallel(
  c: Context,
  ordered: string[],
  adjacency: Map<string, { to: string; edge: ControlEdge | null }[]>,
) {
  const fanOut = new Map<string, number>();
  for (const edge of c.definition.controlEdges) {
    const port = `${edge.source}\u0000${edge.sourcePort}`;
    fanOut.set(port, (fanOut.get(port) ?? 0) + 1);
  }
  const context = new Map<string, Branches>();
  const carried = new Map<string, Branches>();
  for (const v of ordered) {
    // A fan-out whose branches have all met again is closed and is not carried any further.
    const here = [...(context.get(v) ?? [])].filter(
      ([port, indexes]) => indexes.size < (fanOut.get(port) ?? 0),
    );
    const seenPerPort = new Map<string, number>();
    for (const { to, edge } of adjacency.get(v) ?? []) {
      const branches: Branches = new Map(here.map(([k, s]) => [k, new Set(s)]));
      if (edge) {
        const port = `${edge.source}\u0000${edge.sourcePort}`;
        const index = seenPerPort.get(port) ?? 0;
        seenPerPort.set(port, index + 1);
        if ((fanOut.get(port) ?? 0) > 1) branches.set(port, new Set([index]));
        carried.set(edge.id, branches);
      }
      const target = context.get(to) ?? new Map<string, Set<number>>();
      mergeBranches(target, branches);
      context.set(to, target);
    }
  }

  const into = new Map<string, ControlEdge[]>();
  for (const edge of c.definition.controlEdges) {
    if (edge.targetPort === 'repeat' || !carried.has(edge.id)) continue;
    const vertex = vertexOf(c.nodes, edge.target, edge.targetPort, 'target');
    into.set(vertex, [...(into.get(vertex) ?? []), edge]);
  }
  for (const [vertex, edges] of into) {
    if (c.nodes.get(vertex)?.type === 'join') continue;
    edges.forEach((edge, i) => {
      const mine = carried.get(edge.id) as Branches;
      if (
        edges.slice(0, i).some((earlier) => concurrent(mine, carried.get(earlier.id) as Branches))
      )
        c.error(
          'PARALLEL_MERGE_NEEDS_JOIN',
          'parallel branches meet here; bring them together with a Join',
          { nodeId: edge.target, edgeId: edge.id },
        );
    });
  }

  // Branches end only by rejoining: never at an Output, nor through the exit or repeat of the
  // box the fan-out sits in.
  const open = (branches: Branches) =>
    [...branches].filter(([port, indexes]) => indexes.size < (fanOut.get(port) ?? 0));
  const inBox = (port: string, boxId: string) => {
    const [source = '', sourcePort] = port.split('\u0000');
    if (source === boxId) return sourcePort === 'body';
    for (let id = c.nodes.get(source)?.parentId; id; id = c.nodes.get(id)?.parentId)
      if (id === boxId) return true;
    return false;
  };
  for (const edge of c.definition.controlEdges) {
    const branches =
      carried.get(edge.id) ??
      context.get(vertexOf(c.nodes, edge.source, edge.sourcePort, 'source'));
    if (!branches) continue;
    const unjoined = open(branches);
    const leaves =
      c.nodes.get(edge.target)?.type === 'output'
        ? unjoined.length > 0
        : (edge.targetPort === 'exit' || edge.targetPort === 'repeat') &&
          unjoined.some(([port]) => inBox(port, edge.target));
    if (leaves)
      c.error(
        'PARALLEL_UNJOINED',
        'this parallel branch ends before the branches meet again at a Join',
        { nodeId: edge.target, edgeId: edge.id },
      );
  }

  // A Join gathers the branches of one fan-out port: all of them, and nothing else open.
  for (const node of c.definition.nodes) {
    if (node.type !== 'join') continue;
    const edges = (into.get(node.id) ?? []).map((edge) => carried.get(edge.id) as Branches);
    if (edges.length === 0) continue;
    const ports = new Set(edges.flatMap((branches) => [...branches.keys()]));
    const differing = [...ports].filter((port) => {
      const sets = edges.map((branches) => [...(branches.get(port) ?? [])].sort().join(','));
      return new Set(sets).size > 1;
    });
    if (differing.length === 0) continue;
    const [port = ''] = differing;
    const width = fanOut.get(port) ?? 0;
    const covered = new Set(edges.flatMap((branches) => [...(branches.get(port) ?? [])]));
    if (
      differing.length > 1 ||
      covered.size !== width ||
      edges.some((branches) => branches.get(port)?.size !== 1)
    ) {
      c.error('JOIN_PARTIAL', 'a Join gathers every branch of one fan-out', {
        nodeId: node.id,
      });
      continue;
    }
    c.gathers.set(node.id, { port, width });
  }

  const writers = c.definition.nodes.filter(
    (n): n is AgentNode =>
      n.type === 'agent' &&
      n.invocation === 'scheduled' &&
      context.has(n.id) &&
      (c.roleOf(n.id)?.allowedWorkTools.some((tool) => WRITE_TOOLS.has(tool)) ?? false),
  );
  const warned = new Set<string>();
  for (const [i, a] of writers.entries()) {
    for (const b of writers.slice(i + 1)) {
      if (!concurrent(context.get(a.id) as Branches, context.get(b.id) as Branches)) continue;
      for (const node of [a, b]) {
        if (warned.has(node.id)) continue;
        warned.add(node.id);
        c.warn(
          'PARALLEL_WRITERS',
          'parallel branches change files in the same session working copy',
          { nodeId: node.id },
        );
      }
    }
  }
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
    if (!('inputBindings' in node)) continue;
    const bad = (why: string) => c.error('BINDING_SOURCE', why, { nodeId: node.id });
    const callable = c.isCallable(node.id);
    const before = graph.ancestors.get(node.id) ?? new Set<string>();
    for (const binding of node.inputBindings ?? []) {
      const label = `input "${binding.name}"`;
      const source = binding.sourceNodeId ? c.nodes.get(binding.sourceNodeId) : undefined;
      switch (binding.kind) {
        case 'run_input':
          if (binding.name !== 'brief' && binding.name !== 'criteria')
            bad(`${label}: run inputs are "brief" and "criteria"`);
          break;
        case 'task_output':
          if (
            !(source?.type === 'agent' && source.invocation === 'scheduled') &&
            !(source?.type === 'team' && source.source.kind === 'reference')
          ) {
            bad(`${label} must read a scheduled agent or a referenced Team`);
          } else if (!callable && !before.has(source.id)) {
            bad(`${label} reads ${source.id}, which does not run before this node`);
          }
          break;
        case 'previous_iteration_output': {
          const loops = c.loopsAround(node.id);
          const shared =
            source && loops.some((loop) => isWithin(c.nodes, source.parentId ?? null, loop));
          if (!shared) {
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
  for (const node of c.definition.nodes)
    if (node.type === 'decision' && node.mode === 'router' && node.modelProfile)
      if (!known.has(node.modelProfile))
        c.error('UNKNOWN_MODEL_PROFILE', `model profile ${node.modelProfile} is not configured`, {
          nodeId: node.id,
        });
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

// ── what this runtime executes ──────────────────────────────────────────────

const roundsOf = (loop: LoopNode) =>
  loop.reviewRecipe
    ? Math.min(loop.maxIterations, recipeAttempts(loop.reviewRecipe))
    : loop.maxIterations;

/** A warning for every construct the definition may hold but this runtime does not run yet. */
function checkSpawnCap(c: Context) {
  if (c.definition.limits.maxSpawns > SPEC_HARD_CAPS.maxSpawns)
    c.warn(
      'SPAWNS_CAPPED',
      `runs start at most ${SPEC_HARD_CAPS.maxSpawns} child executions; the run uses its installation's cap`,
    );
}

// ── lowering ─────────────────────────────────────────────────────────────────

function lower(c: Context, graph: Graph): CompiledPlan {
  const { definition } = c;
  const targetsOf = (source: string, port: string): PlanTarget[] =>
    (c.outgoing.get(source) ?? [])
      .filter((e) => e.sourcePort === port)
      .map((e) => ({ nodeId: e.target, port: e.targetPort }));
  const membersInOrder = (boxId: string) =>
    graph.order.filter((member) => c.nodes.get(member)?.parentId === boxId);

  const steps: Record<string, PlanStep> = {};
  const loops: Record<string, LoopPlan> = {};
  const boxes: Record<string, BoxPlan> = {};
  for (const id of graph.order) {
    const node = c.nodes.get(id) as CorralNode;
    const base: StepBase = {
      nodeId: id,
      parentId: node.parentId ?? null,
      loopId: c.nearestLoop(id),
    };
    switch (node.type) {
      case 'agent':
        steps[id] = {
          ...base,
          kind: 'agent',
          roleId: node.roleId,
          next: targetsOf(id, 'out'),
          error: targetsOf(id, 'error'),
          retry: node.retry?.maxAttempts ?? 0,
        };
        break;
      case 'decision':
        steps[id] = {
          ...base,
          kind: 'decision',
          mode: node.mode,
          rule: 'rule' in node ? node.rule : null,
          routes: node.mode === 'router' ? node.routes : [],
          branches: Object.fromEntries(
            decisionPortsOf(node).map((port) => [port, targetsOf(id, port)]),
          ),
        };
        break;
      case 'loop':
        steps[id] = {
          ...base,
          kind: 'loop',
          maxIterations: roundsOf(node),
          body: targetsOf(id, 'body'),
          next: targetsOf(id, 'next'),
          exhausted: targetsOf(id, 'exhausted'),
        };
        loops[id] = {
          nodeId: id,
          parentId: base.parentId,
          maxIterations: roundsOf(node),
          stallDetection: node.stallDetection ?? false,
          body: targetsOf(id, 'body'),
          members: membersInOrder(id),
          next: targetsOf(id, 'next'),
          exhausted: targetsOf(id, 'exhausted'),
        };
        break;
      case 'team':
        steps[id] = {
          ...base,
          kind: 'team',
          source: node.source.kind,
          body: targetsOf(id, 'body'),
          next: targetsOf(id, 'next'),
        };
        break;
      case 'join':
        steps[id] = {
          ...base,
          kind: 'join',
          policy: node.policy,
          next: targetsOf(id, 'out'),
          gathers: c.gathers.get(id) ?? null,
        };
        break;
      case 'output':
        steps[id] = { ...base, kind: 'output', requireApproval: node.requireApproval };
        break;
    }
    if (isBox(node))
      boxes[id] = {
        nodeId: id,
        kind: node.type,
        parentId: base.parentId,
        members: membersInOrder(id),
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
  const count = (type: CorralNode['type']) =>
    definition.nodes.filter((n) => n.type === type).length;
  return {
    entryNodeId: definition.entryNodeId,
    order: graph.order,
    steps,
    loops,
    boxes,
    references: Object.fromEntries(c.references),
    callables,
    summary: {
      scheduledAgents: agents.filter((a) => a.invocation === 'scheduled').length,
      callableAgents: agents.filter((a) => a.invocation === 'callable').length,
      decisions: count('decision'),
      loops: Object.keys(loops).length,
      teams: count('team'),
      joins: count('join'),
      outputs: count('output'),
      maxStaticDepth: graph.maxStaticDepth,
    },
  };
}
