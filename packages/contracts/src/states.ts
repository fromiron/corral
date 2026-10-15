import { z } from 'zod';

// Frozen state sets (specs/constitution.md §3). Changing any list requires a Change Request.

export const RunStatus = z.enum([
  'created',
  'validating',
  'running',
  'pausing',
  'paused',
  'awaiting_user',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ExecutionStatus = z.enum([
  'queued',
  'ready',
  'active',
  'waiting_children',
  'waiting_message',
  'waiting_approval',
  'pausing',
  'paused',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const ExecutionActivity = z.enum(['model', 'tool', 'finalizing']);
export type ExecutionActivity = z.infer<typeof ExecutionActivity>;

export const TaskStatus = z.enum([
  'queued',
  'in_progress',
  'blocked',
  'submitted',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const DirectiveStatus = z.enum([
  'accepted',
  'queued',
  'attached_to_request',
  'delivered',
  'not_delivered',
  'expired',
  'rejected',
  'delivery_unknown',
]);
export type DirectiveStatus = z.infer<typeof DirectiveStatus>;

export const ReceiptStatus = z.enum([
  'accepted',
  'queued',
  'applied',
  'rejected',
  'superseded',
  'expired',
  'cancelled',
]);
export type ReceiptStatus = z.infer<typeof ReceiptStatus>;

export const ReviewVerdict = z.enum(['pass', 'revise', 'inconclusive']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export const TERMINAL_EXECUTION_STATUSES = new Set<ExecutionStatus>([
  'succeeded',
  'failed',
  'cancelled',
]);
