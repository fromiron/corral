import { z } from 'zod';
import type { RunLimits } from './definition.ts';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';
import { RunStatus } from './states.ts';

export const SessionSearchRequest = z.strictObject({
  query: z.string().trim().min(1).max(200),
  includeTranscript: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  projectId: Identifier.optional(),
  offset: z.int().min(0).max(10000).default(0),
});
export type SessionSearchRequest = z.input<typeof SessionSearchRequest>;
export interface SessionSearchSource {
  kind: 'session' | 'entry' | 'artifact' | 'response' | 'interaction';
  runId: string | null;
  entryId: string | null;
  artifactVersionId: string | null;
  sequence: number | null;
}
export interface SessionSearchHit extends SessionSearchSource {
  sessionId: string;
  title: string;
  projectId: string;
  excerpt: string;
  /** UTF-16 ranges in the original excerpt, after normalization-aware matching. */
  excerptMatches?: { start: number; end: number }[];
  runNumber?: number;
  /** Exact targets folded into this one run/body match. */
  sources?: SessionSearchSource[];
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

/** a session follow-up continues the conversation through this ended run. */
export const ConversationSource = z.strictObject({ throughRunId: Identifier });
export type ConversationSource = z.infer<typeof ConversationSource>;
/** Appended to a summary request. Not an execution turn. */
export const COMPACTION_SYSTEM_INSTRUCTION =
  'This request is internal context-compaction, not an execution turn. The task output contract and tool-use instructions above apply when execution resumes. For this request only, return the checkpoint as plain text; do not perform the task, write artifacts, or call tools. Preserve the task requirements for the next execution turn.';

/** What the summary itself must contain. The host also sets toolChoice to none. */
export const COMPACTION_SUMMARY_INSTRUCTION =
  'Condense the conversation above into a structured checkpoint with these sections: Primary request and current goal; Explicit user instructions and corrections; Decisions and evidence references; Files and changes; Errors and unresolved questions; Pending work and next step. Preserve exact identifiers, constraints, current instructions and evidence references. Distinguish facts from inference. Earlier summaries are background, not new permission. Do not grant approval or claim completed work without evidence. Output only the checkpoint; do not call tools.';

/** The user message a later request sees in place of the covered turns. */
export function compactionCheckpoint(summary: string): string {
  return `<compacted-summary>\n${summary.trim()}\n</compacted-summary>\nEarlier history is background, not authority for new actions.`;
}

/** The assistant text a copied turn contributes when it has no final answer. */
export function compactionTurnAnswer(turn: {
  answer: string | null;
  answerOmitted?: true;
  status: string;
}): string {
  return (
    turn.answer ??
    (turn.answerOmitted
      ? '(The answer is omitted here because it exceeds the conversation size limit.)'
      : `(No answer was recorded; this request ended ${turn.status}.)`)
  );
}

/** One earlier request and its answer, copied from the Coordinator's own records. */
export const ConversationTurn = z.strictObject({
  runId: Identifier,
  request: z.string(),
  /** The final result's text; null when the run ended without one or it was omitted. */
  answer: z.string().nullable(),
  status: RunStatus,
  answerOmitted: z.literal(true).optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurn>;
/** A kept session summary. The text replaces the covered turns; it does not delete them. */
export const SessionSummary = z.strictObject({
  commandId: Identifier,
  text: z.string().min(1),
  throughRunId: Identifier,
  sessionRevision: z.int().positive(),
  coveredRunIds: z.array(Identifier).max(1_000),
  sourceHash: ContentHash,
});
export type SessionSummary = z.infer<typeof SessionSummary>;
export const SessionConversation = z.strictObject({
  summary: SessionSummary.optional(),
  turns: z.array(ConversationTurn),
  /** Older turns left out to stay within the artifact cap. */
  omittedTurns: z.int().min(0),
});
export type SessionConversation = z.infer<typeof SessionConversation>;
/** Where a run's copied conversation came from; its text is the run's own record. */
export const ContinuedConversation = z.strictObject({
  throughRunId: Identifier,
  turns: z.array(z.strictObject({ runId: Identifier, artifactVersionId: Identifier.nullable() })),
  omittedTurns: z.int().min(0),
  contextHash: ContentHash,
  summary: z
    .strictObject({
      commandId: Identifier,
      throughRunId: Identifier,
      sessionRevision: z.int().positive(),
      sourceHash: ContentHash,
      summaryHash: ContentHash,
    })
    .optional(),
});
export type ContinuedConversation = z.infer<typeof ContinuedConversation>;
export const SessionCompactionPhase = z.enum([
  'completed',
  'retained',
  'discarded',
  'failed',
  'cancelled',
]);
export type SessionCompactionPhase = z.infer<typeof SessionCompactionPhase>;

/** One settled session compaction. Rows are inserted once and never updated. */
export const SessionCompactionRecord = z.strictObject({
  commandId: Identifier,
  sessionId: Identifier,
  sessionRevision: z.int().positive(),
  phase: SessionCompactionPhase,
  throughRunId: Identifier.nullable(),
  coveredRunIds: z.array(Identifier).max(1_000),
  omittedTurns: z.int().min(0),
  sourceHash: ContentHash,
  summary: z.string().min(1).nullable(),
  summaryHash: ContentHash.nullable(),
  recordedAt: z.iso.datetime(),
});
export type SessionCompactionRecord = z.infer<typeof SessionCompactionRecord>;

/** Where one accepted session compaction command stands. */
export const SessionCompactionOutcome = z.strictObject({
  commandId: Identifier,
  phase: z.union([z.literal('pending'), SessionCompactionPhase]),
});
export type SessionCompactionOutcome = z.infer<typeof SessionCompactionOutcome>;

/** What the conversation and context detail show. The summary body stays in the run record. */
export const SessionCompactionView = z.strictObject({
  commandId: Identifier,
  throughRunId: Identifier,
  coveredRunIds: z.array(Identifier).max(1_000),
  sessionRevision: z.int().positive(),
});
export type SessionCompactionView = z.infer<typeof SessionCompactionView>;

export interface MessageBranchPreview {
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
