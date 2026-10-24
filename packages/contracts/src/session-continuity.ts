import { z } from 'zod';
import type { RunLimits } from './definition.ts';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';

export const SessionSearchRequest = z.strictObject({
  query: z.string().trim().min(1).max(200),
  includeTranscript: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  projectId: Identifier.optional(),
  offset: z.int().min(0).max(10000).default(0),
});
export type SessionSearchRequest = z.input<typeof SessionSearchRequest>;
export interface SessionSearchHit {
  sessionId: string;
  title: string;
  projectId: string;
  kind: 'session' | 'entry' | 'artifact' | 'response' | 'interaction';
  runId: string | null;
  entryId: string | null;
  artifactVersionId: string | null;
  sequence: number | null;
  excerpt: string;
  archived: boolean;
}
export interface SessionSearchResult {
  indexVersion: 1;
  scope: 'metadata' | 'private_transcript';
  total: number;
  hits: SessionSearchHit[];
}

const MessageBranchFields = z.strictObject({
  sourceRunId: Identifier,
  artifactVersionId: Identifier.optional(),
  requestStart: z.literal(true).optional(),
  contextOnly: z.boolean().optional(),
});
const validPoint = (point: z.infer<typeof MessageBranchFields>) =>
  Boolean(point.artifactVersionId) !== Boolean(point.requestStart);
export const MessageBranchPoint = MessageBranchFields.refine(
  validPoint,
  'choose a result or the original request',
);
export type MessageBranchPoint = z.infer<typeof MessageBranchPoint>;
export const MessageBranchRequest = MessageBranchFields.extend({
  commandId: Identifier,
  expectedHash: ContentHash,
}).refine(validPoint, 'choose a result or the original request');
export type MessageBranchRequest = z.infer<typeof MessageBranchRequest>;
export const BranchedFrom = z.strictObject({
  runId: Identifier,
  artifactVersionId: Identifier.nullable(),
  sourceSeq: z.int().positive(),
  kind: z.enum(['checkpoint', 'context_only']),
  checkpointId: Identifier.nullable(),
  manifestHash: ContentHash.nullable(),
  tree: z.string().nullable(),
  contextRef: Identifier.nullable(),
  contextHash: ContentHash.nullable(),
});
export type BranchedFrom = z.infer<typeof BranchedFrom>;
export interface MessageBranchPreview {
  usageLimits?: 'none';
  hash: string;
  sourceRunId: string;
  artifactVersionId: string | null;
  sourceSeq: number;
  kind: 'checkpoint' | 'context_only';
  checkpointId: string | null;
  tree: string | null;
  modelProfile: string;
  limits: z.infer<typeof RunLimits>;
}
