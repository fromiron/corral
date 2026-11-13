import { z } from 'zod';
import { ImageAttachments } from './attachments.ts';
import { ContentHash, HarnessBindingRef, HarnessResourceRef } from './harness.ts';
import { Identifier, SchemaVersion } from './ids.ts';
import { ReasoningLevel, ReasoningPolicy } from './reasoning.ts';
import { ReviewRecipeRevision } from './review-recipe.ts';

// Canonical definition of a Corral. Where nodes are drawn is derived from it, never stored.

export const InputBindingKind = z.enum([
  'run_input',
  'task_output',
  'previous_iteration_output',
  'explicit_version',
  'question_answer',
]);
export type InputBindingKind = z.infer<typeof InputBindingKind>;

export const InputBinding = z.strictObject({
  kind: InputBindingKind,
  name: z.string().min(1),
  sourceNodeId: Identifier.optional(),
  artifactVersionId: Identifier.optional(),
  optional: z.boolean().optional(),
});
export type InputBinding = z.infer<typeof InputBinding>;

export const ItemRef = z.strictObject({
  batchId: Identifier,
  index: z.int().min(1).max(4),
  total: z.int().min(1).max(4),
});
export type ItemRef = z.infer<typeof ItemRef>;

// File tools work only inside a session's managed worktree.
export const WorkTool = z.enum([
  'search',
  'read_document',
  'write_artifact',
  'list_files',
  'read_file',
  'write_file',
  'delete_file',
  'move_file',
  'run_command',
  'generate_image',
  'preview_file',
  'preview_app',
  'preview_action',
]);
export const FILE_TOOLS = [
  'list_files',
  'read_file',
  'write_file',
  'delete_file',
  'move_file',
] as const;
export type FileToolName = (typeof FILE_TOOLS)[number];
export type WorkTool = z.infer<typeof WorkTool>;

export const CollaborationTool = z.enum([
  'spawn_subagents',
  'await_tasks',
  'ask',
  'reply',
  'read_artifact',
  'submit_result',
  'ask_user',
  'update_plan',
  'advise',
]);
export type CollaborationTool = z.infer<typeof CollaborationTool>;

export const OutputContract = z.enum(['text', 'notes', 'draft', 'review']);
export type OutputContract = z.infer<typeof OutputContract>;

export const AgentRole = z.strictObject({
  id: Identifier,
  name: z.string().min(1),
  prompt: z.string().min(1).max(20000),
  modelProfile: Identifier,
  reasoning: ReasoningPolicy.optional(),
  allowedWorkTools: z.array(WorkTool).max(13),
  imageProfile: Identifier.optional(),
  editingMode: z.enum(['pi', 'hashline']).optional(),
  allowedCollaborationTools: z.array(CollaborationTool).max(9),
  outputContract: OutputContract,
  harness: HarnessBindingRef.optional(),
  /**
   * the agent's last reply without a tool call is its result. It is offered neither
   * write_artifact nor submit_result; the Coordinator records and submits that reply.
   */
  answer: z.literal('final_reply').optional(),
});
export type AgentRole = z.infer<typeof AgentRole>;

const bindings = (min: number) => z.array(InputBinding).min(min).max(20);

/**
 * Fields every node has. `parentId` names the Loop or inline Team that holds the node; `note` is
 * for people only and never reaches a run (docs/specs/features/team-graph.md).
 */
const nodeBase = {
  id: Identifier,
  label: z.string().min(1),
  parentId: Identifier.optional(),
  note: z.string().max(4000).optional(),
};

/** An Agent in the run order, or one other Agents call through capability links. */
export const WorkAgentNode = z.strictObject({
  ...nodeBase,
  type: z.literal('agent'),
  roleId: Identifier,
  invocation: z.enum(['scheduled', 'callable']),
  inputBindings: bindings(0),
  outputName: z.string().min(1),
  /** Further attempts after a failure; then the `error` port. */
  retry: z.strictObject({ maxAttempts: z.int().min(0) }).optional(),
});
export type WorkAgentNode = z.infer<typeof WorkAgentNode>;

/** How often an advisor reviews and how many model requests one review may make. */
export const AdvisorReview = z.strictObject({
  interval: z.int().min(1),
  maxRequestsPerReview: z.int().min(1),
});
export type AdvisorReview = z.infer<typeof AdvisorReview>;

/** An absent `review` (docs/specs/features/advisor.md). */
export const DEFAULT_ADVISOR_REVIEW: AdvisorReview = { interval: 3, maxRequestsPerReview: 8 };

/**
 * An advisor: outside the run order, it watches the Agents its `advise` links point to
 * (docs/specs/features/advisor.md). It takes no input bindings and no retry.
 */
export const ObserverAgentNode = z.strictObject({
  ...nodeBase,
  type: z.literal('agent'),
  roleId: Identifier,
  invocation: z.literal('observer'),
  outputName: z.string().min(1),
  review: AdvisorReview.optional(),
});
export type ObserverAgentNode = z.infer<typeof ObserverAgentNode>;

export const AgentNode = z.discriminatedUnion('invocation', [WorkAgentNode, ObserverAgentNode]);
export type AgentNode = z.infer<typeof AgentNode>;
export type AgentInvocation = AgentNode['invocation'];

/** The review settings an advisor node runs with: its own, or the defaults. */
export function advisorReview(node: ObserverAgentNode): AdvisorReview {
  return node.review ?? DEFAULT_ADVISOR_REVIEW;
}

export const DecisionRule = z.enum([
  'review_verdict',
  'required_tasks_submitted',
  'human_approval',
]);
export type DecisionRule = z.infer<typeof DecisionRule>;

export const RuleDecisionNode = z.strictObject({
  ...nodeBase,
  type: z.literal('decision'),
  mode: z.enum(['review', 'approval', 'rule']),
  rule: DecisionRule,
  inputBindings: bindings(1),
});

/** Branches on registered checks only: no user code or expression is evaluated. */
export const CheckDecisionNode = z.strictObject({
  ...nodeBase,
  type: z.literal('decision'),
  mode: z.literal('check'),
  checkIds: z.array(Identifier).min(1).max(20),
  inputBindings: bindings(1),
});

export const RouterRoute = z.strictObject({
  id: Identifier,
  label: z.string().min(1),
  description: z.string().max(2000).optional(),
});
export type RouterRoute = z.infer<typeof RouterRoute>;

/** A model picks one of the named routes; each route id is one outgoing port. */
export const RouterDecisionNode = z.strictObject({
  ...nodeBase,
  type: z.literal('decision'),
  mode: z.literal('router'),
  routes: z.array(RouterRoute).max(20),
  modelProfile: Identifier.optional(),
  inputBindings: bindings(1),
});

export const DecisionNode = z.discriminatedUnion('mode', [
  RuleDecisionNode,
  CheckDecisionNode,
  RouterDecisionNode,
]);
export type DecisionNode = z.infer<typeof DecisionNode>;
export type DecisionNodeMode = DecisionNode['mode'];

/**
 * What a Loop does when a round that asks to repeat reaches its cap or stalls: end, raise its
 * Agents' reasoning or switch them to an upper model for more rounds, or have no cap at all
 * (docs/specs/features/team-graph.md, "루프 실행"). Absent is `exhaust`.
 */
export const LoopLimitPolicy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exhaust') }),
  z.strictObject({ kind: z.literal('raise_reasoning'), level: ReasoningLevel }),
  z.strictObject({ kind: z.literal('upper_model'), modelProfile: Identifier }),
  z.strictObject({ kind: z.literal('unlimited') }),
]);
export type LoopLimitPolicy = z.infer<typeof LoopLimitPolicy>;

export const LoopNode = z.strictObject({
  ...nodeBase,
  type: z.literal('loop'),
  /** Absent only with the `unlimited` policy (a compiler rule). */
  maxIterations: z.int().min(1).optional(),
  limitPolicy: LoopLimitPolicy.optional(),
  stallDetection: z.boolean().optional(),
  reviewRecipe: ReviewRecipeRevision.optional(),
});
export type LoopNode = z.infer<typeof LoopNode>;

export const TeamSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inline') }),
  z.strictObject({
    kind: z.literal('reference'),
    corralId: Identifier,
    definitionRevision: z.int().min(1),
  }),
]);
export type TeamSource = z.infer<typeof TeamSource>;

export const TeamNode = z.strictObject({
  ...nodeBase,
  type: z.literal('team'),
  source: TeamSource,
  /** A reference Team's inputs: its child run's brief. An inline Team takes none. */
  inputBindings: bindings(0).optional(),
});
export type TeamNode = z.infer<typeof TeamNode>;

export const JoinNode = z.strictObject({
  ...nodeBase,
  type: z.literal('join'),
  policy: z.enum(['all', 'any']),
});
export type JoinNode = z.infer<typeof JoinNode>;

export const OutputNode = z.strictObject({
  ...nodeBase,
  type: z.literal('output'),
  inputBindings: bindings(1),
  requireApproval: z.boolean(),
});
export type OutputNode = z.infer<typeof OutputNode>;

export const CorralNode = z.discriminatedUnion('type', [
  AgentNode,
  DecisionNode,
  LoopNode,
  TeamNode,
  JoinNode,
  OutputNode,
]);
export type CorralNode = z.infer<typeof CorralNode>;
export type NodeType = CorralNode['type'];
/** Nodes that hold other nodes. */
export type BoxNode = LoopNode | TeamNode;

/** A scheduled or callable Agent: one that runs work, as opposed to an advisor. */
export function isWorkAgent(node: CorralNode | undefined): node is WorkAgentNode {
  return node?.type === 'agent' && node.invocation !== 'observer';
}

/** Named ports of the port table; a router adds one port per route id. */
export const SourcePort = z.enum([
  'out',
  'error',
  'body',
  'next',
  'exhausted',
  'pass',
  'revise',
  'fail',
  'approve',
  'reject',
  'yes',
  'no',
]);
export type SourcePort = z.infer<typeof SourcePort>;
export const TargetPort = z.enum(['in', 'enter', 'repeat', 'exit']);
export type TargetPort = z.infer<typeof TargetPort>;

export const ControlEdge = z.strictObject({
  id: Identifier,
  source: Identifier,
  /** A port of the port table, or a router route id. */
  sourcePort: Identifier,
  target: Identifier,
  targetPort: TargetPort,
});
export type ControlEdge = z.infer<typeof ControlEdge>;

export const CapabilityLink = z.strictObject({
  id: Identifier,
  kind: z.enum(['delegate', 'question', 'advise']),
  sourceNodeId: Identifier,
  targetNodeId: Identifier,
  /** Delegate-only opt-in: its child may ask the existing current parent execution. */
  parentQuestions: z.literal(true).optional(),
});
export type CapabilityLink = z.infer<typeof CapabilityLink>;

export const RunLimits = z.strictObject({
  maxDelegationDepth: z.int().min(1),
  maxModelConcurrency: z.int().min(1),
  maxSpawns: z.int().min(1),
  maxQuestions: z.int().min(0).max(6),
  questionTimeoutMs: z.int().min(1000).max(300000),
});
export type RunLimits = z.infer<typeof RunLimits>;

/** Starting limits from product contract §9; hard caps are enforced by the installation policy. */
export const DEFAULT_LIMITS: RunLimits = {
  maxDelegationDepth: 2,
  maxModelConcurrency: 6,
  maxSpawns: 12,
  maxQuestions: 6,
  questionTimeoutMs: 120000,
};

/** What a run works on: the brief and the completion criteria. */
export const RunInput = z.strictObject({
  images: ImageAttachments.optional(),
  taskScope: z.enum(['work', 'review_only']).optional(),
  verificationScope: z.enum(['targeted', 'release']).optional(),
  brief: z.string().min(1),
  criteria: z.array(z.string().min(1)).min(1).max(20),
});
export type RunInput = z.infer<typeof RunInput>;

/** A projection of owned inputs and effective capabilities, not another task state machine. */
export const TaskBrief = z.strictObject({
  version: z.literal(1),
  inputHash: ContentHash,
  criteriaVersionId: Identifier,
  assignment: z.enum(['scheduled', 'delegated', 'question', 'advisor']),
  outputContract: OutputContract,
  taskScope: z.enum(['work', 'review_only']),
  verificationScope: z.enum(['targeted', 'release']),
  canModifyFiles: z.boolean(),
  limits: RunLimits,
  sourceRefs: z
    .array(z.strictObject({ name: z.string().min(1), artifactVersionId: Identifier.nullable() }))
    .max(1000),
  resources: z.array(HarnessResourceRef).max(64),
});
export type TaskBrief = z.infer<typeof TaskBrief>;

export const CorralDefinition = z.strictObject({
  sourceTeam: z
    .strictObject({ corralId: Identifier, name: z.string().min(1), revision: z.int().min(1) })
    .optional(),
  planOwnerRoleId: Identifier.optional(),
  schemaVersion: SchemaVersion,
  id: Identifier,
  name: z.string().min(1),
  entryNodeId: Identifier,
  input: RunInput,
  roles: z.array(AgentRole).min(1),
  nodes: z.array(CorralNode).min(2),
  controlEdges: z.array(ControlEdge).min(1),
  capabilityLinks: z.array(CapabilityLink),
  limits: RunLimits,
});
export type CorralDefinition = z.infer<typeof CorralDefinition>;

/**
 * A definition still being drawn: same fields and the same refusal of unknown fields and
 * versions, but without the minimum counts a runnable definition needs. Saving and importing
 * use this; starting a run always compiles the strict CorralDefinition.
 */
export const CorralDefinitionDraft = CorralDefinition.extend({
  entryNodeId: z.union([Identifier, z.literal('')]),
  roles: z.array(AgentRole),
  nodes: z.array(CorralNode),
  controlEdges: z.array(ControlEdge),
});
export type CorralDefinitionDraft = z.infer<typeof CorralDefinitionDraft>;
