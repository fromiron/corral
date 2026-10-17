import { z } from 'zod';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';

export const VerificationOwner = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual'), sessionId: Identifier }),
  z.strictObject({
    kind: z.literal('execution'),
    runId: Identifier,
    executionId: Identifier,
    attemptNo: z.int().min(1),
    effectId: Identifier,
  }),
]);
export type VerificationOwner = z.infer<typeof VerificationOwner>;
export const VerificationReport = z.strictObject({
  verificationId: Identifier,
  owner: VerificationOwner,
  sessionId: Identifier,
  commandId: Identifier,
  configRevision: z.int().min(1),
  fingerprint: ContentHash,
  tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  state: z.enum(['queued', 'running', 'completed', 'error', 'cancelled']),
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'not_evaluated']),
  exitCode: z.int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  cleanupConfirmed: z.boolean(),
  durationMs: z.number().min(0),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  retainUntil: z.iso.datetime(),
  output: z.strictObject({
    text: z.string().max(65536),
    bytes: z.int().min(0),
    hash: ContentHash,
    truncated: z.boolean(),
  }),
});
export type VerificationReport = z.infer<typeof VerificationReport>;
