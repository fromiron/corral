import { canonicalJson, type WorkspaceTarget } from '@corral/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { WorkspacesClient } from '../demo/workspaces-client.ts';
import { useServices } from '../services.tsx';
import { DebugControls } from './debug/DebugControls.tsx';
import { debugCopyKey, debugStore } from './debug/store.ts';
import { documentStore } from './documents/store.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

export function DebuggerPanel({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const { workspaces, workspaceId, mode } = useServices();
  const t = useTranslations('Debugger');
  if (
    !workspaces ||
    !workspaceId ||
    mode !== 'server' ||
    typeof workspaces.debugState !== 'function'
  )
    return <p className="text-xs text-muted-foreground">{t('serverRequired')}</p>;
  return (
    <SessionDebugger
      key={canonicalJson([workspaceId, projectId, sessionId])}
      api={workspaces}
      hostId={workspaceId}
      projectId={projectId}
      sessionId={sessionId}
    />
  );
}
function SessionDebugger({
  api,
  hostId,
  projectId,
  sessionId,
}: {
  api: WorkspacesClient;
  hostId: string;
  projectId: string;
  sessionId: string;
}) {
  const t = useTranslations('Debugger');
  const [target, setTarget] = useState<WorkspaceTarget | null>(null),
    [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const copy = await api.worktree(sessionId);
        if (!live) return;
        if (copy && !copy.missing && copy.sessionId === sessionId) {
          const next = {
            hostId,
            projectId,
            sessionId,
            bindingId: copy.bindingId,
            copyGeneration: copy.copyGeneration,
          };
          setTarget((previous) =>
            previous && canonicalJson(previous) === canonicalJson(next) ? previous : next,
          );
        } else setTarget(null);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      } finally {
        reading = false;
        if (live) setLoaded(true);
      }
    };
    void refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => {
      live = false;
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [api, hostId, projectId, sessionId]);
  if (failed)
    return (
      <p role="alert" className="text-xs text-danger">
        {t('loadFailed')}
      </p>
    );
  if (!loaded)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t('loading')}
      </p>
    );
  if (!target)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t('noCopy')}
      </p>
    );
  return <CopyDebugger key={debugCopyKey(target)} api={api} target={target} />;
}
function CopyDebugger({ api, target }: { api: WorkspacesClient; target: WorkspaceTarget }) {
  const store = useMemo(() => debugStore(api, documentStore(api)), [api]);
  const copy = useStore(store, (state) => state.copies[debugCopyKey(target)]);
  useEffect(() => store.retain(target), [store, target]);
  return <DebugControls api={api} target={target} copy={copy} store={store} />;
}
