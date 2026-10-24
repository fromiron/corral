import { z } from 'zod';
import { AgentRole, type RunLimits } from './definition.ts';
import { ContentHash, ProtectedContext } from './harness.ts';
import { Identifier } from './ids.ts';

export const RuntimeContext = z.strictObject({
  version: z.literal(1),
  piVersion: z.literal('1.3.0'),
  runtime: z.enum(['pi-core', 'pi-sdk']),
  context: z.strictObject({ messages: z.array(z.record(z.string(), z.unknown())) }),
  contextHash: ContentHash,
});
export type RuntimeContext = z.infer<typeof RuntimeContext>;
export const RuntimeFiles = z.strictObject({
  checkpointId: Identifier,
  manifestHash: ContentHash,
  tree: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export type RuntimeFiles = z.infer<typeof RuntimeFiles>;
export const RuntimeCheckpointManifest = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  piVersion: z.literal('1.3.0'),
  checkpointId: Identifier,
  runId: Identifier,
  sessionId: Identifier.nullable(),
  executionId: Identifier,
  attemptNo: z.int().positive(),
  eventSeq: z.int().positive(),
  runtime: z.enum(['pi-core', 'pi-sdk']),
  definitionHash: ContentHash,
  modelHash: ContentHash,
  harnessHash: ContentHash.nullable(),
  criteriaVersionId: Identifier,
  criteriaHash: ContentHash,
  contextRef: Identifier,
  contextHash: ContentHash,
  contextBytes: z
    .int()
    .min(0)
    .max(4 * 1024 * 1024),
  files: RuntimeFiles.nullable(),
  createdAt: z.iso.datetime(),
});
export type RuntimeCheckpointManifest = z.infer<typeof RuntimeCheckpointManifest>;
export const RuntimeCheckpointState = z.strictObject({
  version: z.literal(1),
  context: RuntimeContext,
  role: AgentRole,
  criteria: z.string(),
  protectedContext: ProtectedContext,
  sources: z
    .array(
      z.strictObject({
        sourceRef: Identifier,
        toolCallId: Identifier.optional(),
        text: z.string(),
      }),
    )
    .optional(),
});
export type RuntimeCheckpointState = z.infer<typeof RuntimeCheckpointState>;
export const RuntimeCheckpointRecord = z.strictObject({
  checkpointId: Identifier,
  executionId: Identifier,
  attemptNo: z.int().positive(),
  manifestRef: Identifier,
  manifestHash: ContentHash,
  contextRef: Identifier,
  contextBytes: z
    .int()
    .min(0)
    .max(4 * 1024 * 1024),
  contextHash: ContentHash,
  tree: z.string().nullable(),
});
export type RuntimeCheckpointRecord = z.infer<typeof RuntimeCheckpointRecord>;
export const ResumedFrom = z.strictObject({
  runId: Identifier,
  executionId: Identifier,
  attemptNo: z.int().positive(),
  checkpointId: Identifier,
  manifestHash: ContentHash,
  contextRef: Identifier,
});
export type ResumedFrom = z.infer<typeof ResumedFrom>;
export const ResumeRuntimeRequest = z.strictObject({
  commandId: Identifier,
  sourceRunId: Identifier,
  checkpointId: Identifier,
  manifestHash: ContentHash,
  expectedSourceSeq: z.int().positive(),
});
export type ResumeRuntimeRequest = z.infer<typeof ResumeRuntimeRequest>;
export interface RuntimeCheckpointView extends RuntimeCheckpointRecord {
  usageLimits?: 'none';
  sourceSeq: number;
  createdAt: string;
  runtime: 'pi-core' | 'pi-sdk';
  ready: boolean;
  blockers: string[];
  limits: z.infer<typeof RunLimits> | null;
}

const ContextChunkRef = z.strictObject({
  artifactVersionId: Identifier,
  hash: ContentHash,
  bytes: z.int().nonnegative(),
});
/** Private storage representation; workers receive a verified, hydrated RuntimeCheckpointState. */
export const ContextCheckpointV2 = z.strictObject({
  version: z.literal(2),
  piVersion: z.literal('1.3.0'),
  runtime: z.enum(['pi-core', 'pi-sdk']),
  contextHash: ContentHash,
  messages: z.array(ContextChunkRef),
  role: ContextChunkRef,
  criteria: ContextChunkRef,
  protectedContext: ContextChunkRef,
  sources: z.array(ContextChunkRef).optional(),
});
export type ContextCheckpointV2 = z.infer<typeof ContextCheckpointV2>;
