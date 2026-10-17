import type { RunEvent, StreamFrame } from '@corral/contracts';
import type { RuntimeTransport } from '@corral/core';

export type DemoMethod = Exclude<keyof RuntimeTransport, 'subscribe'>;
export type DemoRequest = {
  [M in DemoMethod]: {
    type: 'request';
    id: number;
    method: M;
    args: Parameters<RuntimeTransport[M]>;
  };
}[DemoMethod];
/** The demo work folder's calls the page may make (demo/workspace.ts). */
export const DEMO_WORKSPACE_METHODS = [
  'listFiles',
  'readFile',
  'binding',
  'bind',
  'configure',
  'unbind',
  'worktree',
  'createWorktree',
  'removeWorktree',
  'changes',
  'fileVersions',
  'folderChanges',
  'folderFileVersions',
  'markReviewed',
  'verifications',
  'verify',
  'fileOperations',
  'runSnapshots',
  'listComments',
  'addComment',
  'setCommentState',
  'feedbackText',
  'recordFeedback',
  'decisions',
  'decide',
  'integrationPlan',
  'integrate',
  'integrations',
  'revert',
  'inboxFacts',
] as const;
export type DemoWorkspaceMethod = (typeof DEMO_WORKSPACE_METHODS)[number];

export type DemoMessage =
  | DemoRequest
  | { type: 'history'; id: number; runId: string }
  | { type: 'workspace'; id: number; method: DemoWorkspaceMethod; args: unknown[] }
  | { type: 'subscribe'; id: number; runId: string; afterSeq: number }
  | { type: 'unsubscribe'; id: number }
  | { type: 'configure'; delayMs: number };
export type DemoResponse =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }
  | { type: 'event'; id: number; event: RunEvent }
  | { type: 'frame'; id: number; frame: StreamFrame }
  | { type: 'subscription_error'; id: number; message: string };
