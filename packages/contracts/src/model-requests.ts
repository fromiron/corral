import { z } from 'zod';
import { Identifier } from './ids.ts';

export const ModelRequestOwner = z.strictObject({
  kind: z.enum(['execution', 'chooser', 'draft', 'voice', 'image', 'evaluation', 'judge']),
  id: z.string().min(1).max(256),
  runId: Identifier.optional(),
  sessionId: Identifier.optional(),
  executionId: Identifier.optional(),
  modelCallId: Identifier.optional(),
});
export const ModelRequestIntent = z.strictObject({
  requestId: z.string().min(1).max(256),
  retryIndex: z.int().min(0).max(2).optional(),
  owner: ModelRequestOwner,
  purpose: z.enum([
    'turn',
    'retry',
    'compaction',
    'extension',
    'chooser',
    'draft',
    'voice',
    'image',
    'reasoning_effort',
  ]),
  revision: z.int().nonnegative(),
});
export type ModelRequestIntent = z.infer<typeof ModelRequestIntent>;
export const RequestPolicySnapshotV2 = z.strictObject({
  version: z.literal(2),
  provider: z.string(),
  modelId: z.string(),
  api: z.string(),
  contextWindow: z.int().positive(),
  maxOutputTokens: z.int().positive(),
  cacheRetention: z.enum(['none', 'short', 'long']),
  maxRetries: z.literal(2),
  providerRetries: z.literal(0),
  profileId: Identifier.optional(),
  endpointHash: z.string().optional(),
  configRevision: z.string().optional(),
  cacheSource: z.enum(['profile', 'endpoint', 'environment', 'product']).optional(),
  auth: z.enum(['oauth', 'api_key', 'mock']).optional(),
});
export type RequestPolicySnapshotV2 = z.infer<typeof RequestPolicySnapshotV2>;
export const PreparedModelRequest = z.strictObject({
  inputRevision: z.int().nonnegative(),
  inputHash: z.string().min(1),
  estimatedInputTokens: z.int().nonnegative(),
  measurement: z.enum(['dsh-density-v2', 'usage-anchor-v2']),
  outputAllowance: z.int().positive(),
  cacheNamespace: z.string().nullable(),
});
export type PreparedModelRequest = z.infer<typeof PreparedModelRequest>;
const count = z.int().nonnegative().nullable();
export const UsageRecordV2 = z.strictObject({
  version: z.literal(2),
  inputTokens: count,
  outputTokens: count,
  reasoningTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  source: z.enum(['reported', 'estimated', 'unknown']),
  costStatus: z.enum(['reported', 'estimated', 'subscription', 'unknown']),
  costUsd: z.number().nonnegative().nullable(),
  pricing: z
    .strictObject({
      source: z.literal('pi-ai-1.3.0-catalog'),
      usdPerMillion: z.strictObject({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
      }),
    })
    .optional(),
});
export type UsageRecordV2 = z.infer<typeof UsageRecordV2>;
export const ModelAttempt = z.strictObject({
  version: z.literal(2),
  attemptId: z.string().min(1).max(256),
  intent: ModelRequestIntent,
  provider: z.string().min(1),
  modelId: z.string().min(1),
  status: z.enum(['started', 'completed', 'failed', 'cancelled', 'unknown']),
  startedAt: z.string().min(1),
  endedAt: z.string().nullable(),
  payloadHash: z.string().nullable(),
  payloadBytes: count,
  firstEventAt: z.string().nullable(),
  queueWaitMs: z.number().nonnegative().optional(),
  failure: z
    .strictObject({
      code: z.string(),
      status: z.int().nullable(),
      retryAfterMs: count,
      requestId: z.string().nullable(),
    })
    .nullable(),
  usage: UsageRecordV2,
  policy: RequestPolicySnapshotV2.optional(),
  prepared: PreparedModelRequest.optional(),
});
export type ModelAttempt = z.infer<typeof ModelAttempt>;
export interface ModelAttemptPage {
  items: ModelAttempt[];
  nextCursor: number | null;
}
export interface ModelAttemptStore {
  put(attempt: ModelAttempt): void;
  get(attemptId: string): ModelAttempt | null;
  list(ownerId?: string): ModelAttempt[];
}
