import { z } from 'zod';
import type { ErrorCode } from './errors.ts';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';

export const WorkspaceTarget = z.strictObject({
  hostId: z.string().min(1).max(200),
  projectId: Identifier,
  bindingId: Identifier,
  sessionId: Identifier,
  copyGeneration: z.int().min(1),
});
export type WorkspaceTarget = z.infer<typeof WorkspaceTarget>;

const Path = z.string().min(1).max(4096);
const DocumentCommandBase = z.strictObject({
  operationId: Identifier,
  target: WorkspaceTarget,
  path: Path,
});
export const DocumentCommand = z.discriminatedUnion('kind', [
  DocumentCommandBase.extend({
    kind: z.literal('save'),
    baseHash: ContentHash.nullable(),
    text: z.string().max(1024 * 1024),
    editVersion: z.int().min(0),
  }),
  DocumentCommandBase.extend({
    kind: z.literal('rename'),
    baseHash: ContentHash,
    toPath: Path,
  }),
  DocumentCommandBase.extend({
    kind: z.literal('delete'),
    baseHash: ContentHash,
    confirmed: z.literal(true),
  }),
]);
export type DocumentCommand = z.infer<typeof DocumentCommand>;

export interface DocumentVersion {
  sha256: string;
  bytes: number;
  encoding: 'utf-8';
  bom: boolean;
  eol: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
}
export interface FileDocument {
  target: WorkspaceTarget;
  path: string;
  content:
    | { kind: 'text'; text: string }
    | { kind: 'absent' }
    | { kind: 'binary'; bytes: number }
    | { kind: 'too_large'; bytes: number };
  version: DocumentVersion | null;
  writable: boolean;
}

export interface WorkbenchOperation {
  operationId: string;
  target: WorkspaceTarget;
  kind: string;
  requestHash: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export const DevelopmentStart = z.strictObject({
  operationId: Identifier,
  target: WorkspaceTarget,
});
export type DevelopmentStart = z.infer<typeof DevelopmentStart>;
export interface DevelopmentState {
  target: WorkspaceTarget;
  available: boolean;
  operation: WorkbenchOperation | null;
}
export interface DocumentMutationIntent {
  path: string;
  baseHash: string | null;
  submittedHash?: string;
  editVersion?: number;
  toPath?: string;
  checkpointId?: string;
}
export type DocumentMutationResult = (
  | { kind: 'pending' }
  | { kind: 'saved'; path: string; sha256: string; bytes: number; editVersion: number }
  | { kind: 'renamed'; path: string; toPath: string; sha256: string }
  | { kind: 'deleted'; path: string; checkpointId: string }
  | { kind: 'error'; code: ErrorCode; message: string }
) & { intent: DocumentMutationIntent };
export interface DocumentOperation extends WorkbenchOperation {
  kind: 'document.save' | 'document.rename' | 'document.delete';
  result: DocumentMutationResult | null;
}

/** CR-046 P15: a development task a person starts explicitly from the copy's package scripts. */
export const TaskStart = z.strictObject({
  operationId: Identifier,
  target: WorkspaceTarget,
  script: z.string().min(1).max(200),
});
export type TaskStart = z.infer<typeof TaskStart>;
export interface TaskCandidates {
  /** Chosen from the copy's lockfile; null when there is no package.json. */
  packageManager: 'pnpm' | 'yarn' | 'npm' | null;
  scripts: { name: string; command: string }[];
}
export interface UserTaskView {
  operationId: string;
  script: string;
  command: string;
  packageManager: 'pnpm' | 'yarn' | 'npm';
  state: WorkbenchOperation['state'];
  pid?: number;
  exitCode?: number | null;
  cleanupConfirmed?: boolean;
  createdAt: string;
  updatedAt: string;
}
