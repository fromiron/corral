import { z } from 'zod';
import { ContentHash, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';
import type { RegisteredDebugAdapter, RegisteredDebugConfiguration } from './project-tools.ts';
import { WorkspaceTarget } from './workbench.ts';

export const DebugInspect = z.strictObject({
  target: WorkspaceTarget,
  configId: Identifier,
  attach: z
    .strictObject({ operationId: Identifier, port: z.int().min(1024).max(65535) })
    .optional(),
  preview: z.strictObject({ leaseId: Identifier }).optional(),
});
export type DebugInspect = z.infer<typeof DebugInspect>;
export interface DebugInspection {
  target: WorkspaceTarget;
  configuration: RegisteredDebugConfiguration;
  adapter: RegisteredDebugAdapter;
  configRevision: number;
  fingerprint: string;
  trusted: boolean;
}
export const DebugStart = DebugInspect.extend({
  requestId: Identifier,
  clientId: Identifier,
  configRevision: z.int().positive(),
  fingerprint: ContentHash,
  trust: z.boolean().default(false),
});
export type DebugStart = z.infer<typeof DebugStart>;
export const DebugScope = z.strictObject({ target: WorkspaceTarget, generation: Identifier });
export type DebugScope = z.infer<typeof DebugScope>;
export const DebugBreakpoints = DebugScope.extend({
  commandId: Identifier,
  path: ResourcePath,
  sha256: ContentHash,
  lines: z.array(z.int().positive().max(1000000)).max(128),
});
export type DebugBreakpoints = z.infer<typeof DebugBreakpoints>;
export const DebugCommand = DebugScope.extend({
  commandId: Identifier,
  revision: z.int().nonnegative(),
  pauseId: z.int().nonnegative(),
  kind: z.enum([
    'pause',
    'continue',
    'next',
    'stepIn',
    'stepOut',
    'evaluate',
    'disconnect',
    'stop',
  ]),
  threadId: z.string().max(100).optional(),
  frameId: z.string().max(100).optional(),
  expression: z.string().min(1).max(4000).optional(),
});
export type DebugCommand = z.infer<typeof DebugCommand>;
export const DebugQuery = DebugScope.extend({
  pauseId: z.int().nonnegative(),
  kind: z.enum(['threads', 'stack', 'scopes', 'variables']),
  threadId: z.string().max(100).optional(),
  frameId: z.string().max(100).optional(),
  variablesReference: z.string().max(100).optional(),
});
export type DebugQuery = z.infer<typeof DebugQuery>;
/** DAP positions are one-based UTF-16. Unknown and changed sources are not navigable. */
export interface DebugSource {
  path: string | null;
  name: string;
  sha256: string | null;
  line: number;
  column: number;
  mapped: boolean;
  reason: 'outside' | 'virtual' | 'changed' | 'unavailable' | null;
}
export interface DebugBreakpoint {
  path: string;
  sha256: string;
  requestedLine: number;
  line: number;
  verified: boolean;
  message: string | null;
}
export interface DebugSession {
  generation: string;
  clientId: string;
  configId: string;
  configRevision: number;
  fingerprint: string;
  runtime: 'node' | 'chromium';
  ownership: 'launched' | 'attached';
  state: 'starting' | 'running' | 'paused' | 'stopped' | 'failed' | 'uncertain';
  revision: number;
  pauseId: number;
  pausedThreadId: string | null;
  canDisconnect: boolean;
  canStop: boolean;
  breakpoints: DebugBreakpoint[];
  output: string;
  error: string | null;
}
export interface DebugState {
  target: WorkspaceTarget;
  available: boolean;
  unavailableReason: 'platform' | 'untrusted' | null;
  configurations: RegisteredDebugConfiguration[];
  session: DebugSession | null;
}
export interface DebugQueryResult {
  generation: string;
  pauseId: number;
  revision: number;
  threads?: { id: string; name: string }[];
  frames?: { id: string; name: string; source: DebugSource }[];
  scopes?: { name: string; variablesReference: string; expensive: boolean }[];
  variables?: {
    name: string;
    value: string;
    type: string | null;
    variablesReference: string | null;
  }[];
}
export interface DebugCommandResult {
  commandId: string;
  state: 'running' | 'succeeded' | 'failed' | 'uncertain';
  session: DebugSession;
  value?: string;
  variablesReference?: string | null;
  error?: string;
}
