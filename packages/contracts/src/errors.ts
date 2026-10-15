import { z } from 'zod';

// API-Contract §3. TARGET_NOT_FOUND was added for unknown run/execution/task targets.
export const ErrorCode = z.enum([
  'SCHEMA_INVALID',
  'GRAPH_INVALID',
  'CAPABILITY_DENIED',
  'STALE_CONTROL_REVISION',
  'IDEMPOTENCY_CONFLICT',
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
