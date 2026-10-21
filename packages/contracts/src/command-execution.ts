import { z } from 'zod';
import { ContentHash, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';

export const ShellId = z.enum(['powershell', 'pwsh', 'cmd', 'git-bash', 'bash', 'sh']);
export type ShellId = z.infer<typeof ShellId>;
export const RunCommandArgs = z.strictObject({
  command: z.string().min(1).max(32000),
  shellId: ShellId.optional(),
  cwd: z.union([z.literal('.'), ResourcePath]).optional(),
  timeoutMs: z.int().min(1000).max(1800000).optional(),
  mode: z.enum(['foreground', 'service']).optional(),
});
export type RunCommandArgs = z.infer<typeof RunCommandArgs>;
export interface CommandExecution {
  runId: string;
  executionId: string;
  attemptNo: number;
  effectId: string;
  request: RunCommandArgs;
}
/** Server-resolved launch identity; the broker must revalidate it under its writer lease. */
export const CommandPlan = z.strictObject({
  operationId: Identifier,
  hostId: Identifier,
  sessionId: Identifier,
  workspaceBindingId: Identifier,
  worktreeId: Identifier,
  rootIdentity: ContentHash,
  tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  shellId: ShellId,
  /** Reviewable source command; argv may use encoded shell transport. */
  command: z.string().min(1).max(32000).optional(),
  executable: z.string().min(1),
  argv: z.array(z.string()).min(1).max(30),
  cwd: z.union([z.literal('.'), ResourcePath]),
  environmentHash: ContentHash,
  timeoutMs: z.int().min(1000).max(1800000),
  mode: z.enum(['foreground', 'service']).optional(),
  fingerprint: ContentHash,
});
export type CommandPlan = z.infer<typeof CommandPlan>;
export const CommandReport = z.strictObject({
  operationId: Identifier,
  state: z.enum(['running', 'completed', 'failed', 'cancelled', 'uncertain']),
  exitCode: z.int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  cleanupConfirmed: z.boolean(),
  output: z.strictObject({
    text: z.string().max(65536),
    bytes: z.int().min(0),
    hash: ContentHash,
    truncated: z.boolean(),
  }),
});
export type CommandReport = z.infer<typeof CommandReport>;
