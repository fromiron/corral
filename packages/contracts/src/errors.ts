import { z } from 'zod';

// API-Contract §3. Added in implementation: TARGET_NOT_FOUND (unknown target),
// COMMAND_NOT_SUPPORTED (valid command whose runtime support arrives in a later phase) and
// RUN_ALREADY_ACTIVE (a workspace runs one Run at a time, Spec §6.2, C-057) and
// REVISION_CONFLICT (a Corral save based on an older definition revision, PUT /corrals/:id).
export const ErrorCode = z.enum([
  'SCHEMA_INVALID',
  'GRAPH_INVALID',
  'CAPABILITY_DENIED',
  'STALE_CONTROL_REVISION',
  'IDEMPOTENCY_CONFLICT',
  'COMMAND_NOT_SUPPORTED',
  'TARGET_NOT_FOUND',
  'TARGET_TERMINAL',
  'RUN_ALREADY_ACTIVE',
  'REVISION_CONFLICT',
  'RESOURCE_CAPACITY',
  'CRITERIA_CHANGE_REQUIRES_NEW_RUN',
  'RESTART_NOT_ALLOWED',
  'APPROVAL_STALE',
  'LIMIT_REACHED',
  'STORAGE_UNAVAILABLE',
  'SESSION_INVALID',
  'ORIGIN_REJECTED',
  /** An admission gate failed; the call is refused, never let through (ADR-024). */
  'POLICY_ERROR',
  /** A model request outside a Run failed, or its answer did not fit the contract (CR-006). */
  'MODEL_UNAVAILABLE',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const CommandError = z.strictObject({
  code: ErrorCode,
  message: z.string().min(1),
});
export type CommandError = z.infer<typeof CommandError>;
