/** A live, session-owned rendering lease; its URL is a short-lived capability. */
export interface WorkspacePreview {
  leaseId: string;
  sessionId: string;
  runId?: string;
  kind: 'static' | 'service';
  operationId?: string;
  url: string;
  origin: string;
  path: string;
  state: 'ready' | 'stopped';
  createdAt: string;
}

export type StartPreviewInput =
  | { path: string; runId?: string }
  | { operationId: string; port: number; entryPath?: string };
