import type { FileBrowseScope, FileListView, WorktreeView } from '@corral/client';
import { useEffect, useState } from 'react';
import { WORKSPACE_CHANGED } from '../pages/FilesViews.tsx';
import { useServices } from '../services.tsx';

/** A source picker reads existing scopes; it never creates a working copy or grants tools. */
export function useWorkspaceFiles(
  projectId: string,
  sessionId: string,
  source?: 'project' | 'session',
  enabled = true,
) {
  const { workspaces } = useServices();
  const [tick, refresh] = useState(0);
  const [state, setState] = useState<{
    scope: FileBrowseScope | null;
    list: FileListView;
    hasCopy: boolean;
    copy: WorktreeView | null;
    loading: boolean;
    error: string | null;
  }>({
    scope: null,
    list: { files: [], truncated: false },
    hasCopy: false,
    copy: null,
    loading: false,
    error: null,
  });
  useEffect(() => {
    const changed = () => refresh((v) => v + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  useEffect(() => {
    void tick;
    if (!workspaces || !enabled) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    void (async () => {
      const [binding, copy] = await Promise.all([
        workspaces.binding(projectId),
        workspaces.worktree(sessionId),
      ]);
      const hasCopy = !!copy && !copy.missing && !copy.removedAt;
      const kind = source ?? (hasCopy ? 'session' : 'project');
      const scope: FileBrowseScope | null =
        kind === 'session'
          ? hasCopy
            ? { kind, id: sessionId }
            : null
          : binding
            ? { kind, id: projectId }
            : null;
      const list = scope ? await workspaces.listFiles(scope) : { files: [], truncated: false };
      if (live) setState({ scope, list, hasCopy, copy, loading: false, error: null });
    })().catch((error: unknown) => {
      if (live)
        setState((s) => ({
          ...s,
          scope: null,
          list: { files: [], truncated: false },
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    });
    return () => {
      live = false;
    };
  }, [workspaces, projectId, sessionId, source, tick, enabled]);
  return { ...state, refresh: () => refresh((v) => v + 1) };
}
