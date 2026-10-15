import { z } from 'zod';

// API-Contract §3. Added in implementation: TARGET_NOT_FOUND (unknown target) and
// COMMAND_NOT_SUPPORTED (valid command whose runtime support arrives in a later phase).
export const ErrorCode = z.enum([
  'SCHEMA_INVALID',
  'GRAPH_INVALID',
  'CAPABILITY_DENIED',
  'STALE_CONTROL_REVISION',
  'IDEMPOTENCY_CONFLICT',
  'COMMAND_NOT_SUPPORTED',
  'TARGET_NOT_FOUND',
  'TARGET_TERMINAL',
  'RESOURCE_CAPACITY',
  'CRITERIA_CHANGE_REQUIRES_NEW_RUN',
  'RESTART_NOT_ALLOWED',
  'APPROVAL_STALE',
  'LIMIT_REACHED',
  'STORAGE_UNAVAILABLE',
  'SESSION_INVALID',
  'ORIGIN_REJECTED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const CommandError = z.strictObject({
  code: ErrorCode,
  message: z.string().min(1),
});
export type CommandError = z.infer<typeof CommandError>;
