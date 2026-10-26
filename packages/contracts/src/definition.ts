import { z } from 'zod';
import { ImageAttachments } from './attachments.ts';
import { ContentHash, HarnessBindingRef, HarnessResourceRef } from './harness.ts';
import { Identifier, SchemaVersion } from './ids.ts';
import { ReasoningPolicy } from './reasoning.ts';
import { ReviewRecipeRevision } from './review-recipe.ts';

// Canonical definition of a Corral (Technical-Design §4.1). Layout lives in CanvasLayout.

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

// File tools (CR-012) work only inside a session's managed worktree.
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
  allowedCollaborationTools: z.array(CollaborationTool).max(8),
  outputContract: OutputContract,
  harness: HarnessBindingRef.optional(),
  /**
   * CR-055: the agent's last reply without a tool call is its result. It is offered neither
   * write_artifact nor submit_result; the Coordinator records and submits that reply.
   */
  answer: z.literal('final_reply').optional(),
});
export type AgentRole = z.infer<typeof AgentRole>;

const bindings = (min: number) => z.array(InputBinding).min(min).max(20);

export const AgentNode = z.strictObject({
  id: Identifier,
  type: z.literal('agent'),
  label: z.string().min(1),
  loopId: Identifier.optional(),
  roleId: Identifier,
  invocation: z.enum(['scheduled', 'callable']),
  inputBindings: bindings(0),
  outputName: z.string().min(1),
});
export type AgentNode = z.infer<typeof AgentNode>;

export const DecisionNode = z.strictObject({
  id: Identifier,
  type: z.literal('decision'),
  label: z.string().min(1),
  loopId: Identifier.optional(),
  mode: z.enum(['review', 'approval', 'rule']),
  rule: z.enum(['review_verdict', 'required_tasks_submitted', 'human_approval']),
  inputBindings: bindings(1),
});
export type DecisionNode = z.infer<typeof DecisionNode>;

export const LoopNode = z.strictObject({
  id: Identifier,
  type: z.literal('loop'),
  label: z.string().min(1),
  maxIterations: z.int().min(1).max(10),
  reviewRecipe: ReviewRecipeRevision.optional(),
});
export type LoopNode = z.infer<typeof LoopNode>;

export const OutputNode = z.strictObject({
  id: Identifier,
  type: z.literal('output'),
  label: z.string().min(1),
  inputBindings: bindings(1),
  requireApproval: z.boolean(),
});
export type OutputNode = z.infer<typeof OutputNode>;

export const CorralNode = z.discriminatedUnion('type', [
  AgentNode,
  DecisionNode,
  LoopNode,
  OutputNode,
]);
export type CorralNode = z.infer<typeof CorralNode>;
export type NodeType = CorralNode['type'];

export const SourcePort = z.enum([
  'out',
  'body',
  'next',
  'pass',
  'revise',
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
  sourcePort: SourcePort,
  target: Identifier,
  targetPort: TargetPort,
});
export type ControlEdge = z.infer<typeof ControlEdge>;

export const CapabilityLink = z.strictObject({
  id: Identifier,
  kind: z.enum(['delegate', 'question']),
  sourceNodeId: Identifier,
  targetNodeId: Identifier,
  /** Delegate-only opt-in: its child may ask the existing current parent execution. */
  parentQuestions: z.literal(true).optional(),
});
export type CapabilityLink = z.infer<typeof CapabilityLink>;

export const RunLimits = z.strictObject({
  maxDelegationDepth: z.literal(2),
  maxModelConcurrency: z.int().min(1),
  maxSpawns: z.int().min(1).max(32),
  maxModelCalls: z.int().min(1),
  maxOutputTokens: z.int().min(1),
  maxOutputTokensPerCall: z.int().min(1),
  maxQuestions: z.int().min(0).max(6),
  questionTimeoutMs: z.int().min(1000).max(300000),
  modelTimeoutMs: z.int().min(1000),
  runDeadlineMs: z.int().min(1000),
});
export type RunLimits = z.infer<typeof RunLimits>;

/** Starting limits from Spec §9; hard caps are enforced by the installation policy. */
export const DEFAULT_LIMITS: RunLimits = {
  maxDelegationDepth: 2,
  maxModelConcurrency: 6,
  maxSpawns: 12,
  maxModelCalls: 40,
  maxOutputTokens: 64000,
  maxOutputTokensPerCall: 4096,
  maxQuestions: 6,
  questionTimeoutMs: 120000,
  modelTimeoutMs: 180000,
  runDeadlineMs: 3600000,
};

/** What a run works on: the brief and the completion criteria (Spec §5.1). */
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
  assignment: z.enum(['scheduled', 'delegated', 'question']),
  outputContract: OutputContract,
  taskScope: z.enum(['work', 'review_only']),
  verificationScope: z.enum(['targeted', 'release']),
  canModifyFiles: z.boolean(),
  limits: RunLimits,
  /** An unlimited run (CR-052): `limits` are not applied. */
  usageLimits: z.literal('none').optional(),
  sourceRefs: z
    .array(z.strictObject({ name: z.string().min(1), artifactVersionId: Identifier.nullable() }))
    .max(1000),
  resources: z.array(HarnessResourceRef).max(64),
});
export type TaskBrief = z.infer<typeof TaskBrief>;

/** Model-visible metadata excludes inactive legacy caps and internal unlimited sentinels. */
export function taskBriefForModel(brief: TaskBrief | undefined) {
  if (!brief) return undefined;
  const {
    maxModelCalls,
    maxOutputTokens,
    maxOutputTokensPerCall,
    modelTimeoutMs,
    runDeadlineMs,
    ...resources
  } = brief.limits;
  const budget = {
    maxModelCalls,
    maxOutputTokens,
    maxOutputTokensPerCall,
    modelTimeoutMs,
    runDeadlineMs,
  };
  return {
    ...brief,
    limits: resources,
    usageBudget:
      brief.usageLimits === 'none'
        ? null
        : Object.fromEntries(
            Object.entries(budget).filter(([, value]) => value < Number.MAX_SAFE_INTEGER),
          ),
  };
}

export const ExecutionPolicy = z.strictObject({
  version: z.literal(2),
  budget: z
    .strictObject({
      maxModelCalls: z.int().positive().optional(),
      maxOutputTokens: z.int().positive().optional(),
      maxOutputTokensPerCall: z.int().positive().optional(),
      runDeadlineMs: z.int().min(1000).optional(),
      modelTimeoutMs: z.int().min(1000).optional(),
    })
    .optional(),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicy>;

export const CorralDefinition = z.strictObject({
  executionPolicy: ExecutionPolicy.optional(),
  planOwnerRoleId: Identifier.optional(),
  schemaVersion: SchemaVersion,
  id: Identifier,
  name: z.string().min(1),
  entryNodeId: Identifier,
  input: RunInput,
  roles: z.array(AgentRole).min(1).max(20),
  nodes: z.array(CorralNode).min(2).max(28),
  controlEdges: z.array(ControlEdge).min(1).max(40),
  capabilityLinks: z.array(CapabilityLink).max(40),
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
  roles: z.array(AgentRole).max(20),
  nodes: z.array(CorralNode).max(27),
  controlEdges: z.array(ControlEdge).max(40),
});
export type CorralDefinitionDraft = z.infer<typeof CorralDefinitionDraft>;
