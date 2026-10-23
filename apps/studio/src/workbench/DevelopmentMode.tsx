import { ApiError, type DevelopmentState } from '@corral/client';
import { Button } from '@corral/react/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

/** One explicit server-owned mode, reused at the copy header and the task entry point. */
export function DevelopmentMode({
  sessionId,
  onlyActive = false,
}: {
  sessionId: string;
  onlyActive?: boolean;
}) {
  const { workspaces, workspaceId, mode } = useServices();
  const t = useTranslations('Development');
  const query = useMemo(
    () => ({ workspaces, workspaceId, sessionId }),
    [workspaces, workspaceId, sessionId],
  );
  const current = useRef(query);
  current.current = query;
  const [loaded, setLoaded] = useState<{ query: typeof query; state: DevelopmentState } | null>(
    null,
  );
  const [error, setError] = useState<{ query: typeof query; message: string } | null>(null);
  const [busy, setBusy] = useState<typeof query | null>(null);
  const request = useRef<{ query: typeof query; operationId: string } | null>(null);
  const state = loaded?.query === query ? loaded.state : null;
  const read = useCallback(async () => {
    if (!query.workspaces?.developmentState || mode !== 'server') return;
    const next = await query.workspaces.developmentState(query.sessionId);
    if (
      current.current === query &&
      next.target.sessionId === query.sessionId &&
      next.target.hostId === query.workspaceId
    )
      setLoaded({ query, state: next });
  }, [query, mode]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (live) void read().catch(() => {});
    };
    refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    const timer = setInterval(refresh, 3000);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [read]);
  if (!state || (!state.available && !state.operation) || (onlyActive && !state.operation))
    return null;
  const operation = state.operation;
  const change = async () => {
    if (!workspaces || busy === query) return;
    setBusy(query);
    setError(null);
    try {
      if (operation)
        await workspaces.finishDevelopment(sessionId, operation.operationId, state.target);
      else {
        if (request.current?.query !== query)
          request.current = {
            query,
            operationId: `development_${crypto.randomUUID().replaceAll('-', '')}`,
          };
        await workspaces.startDevelopment(sessionId, {
          operationId: request.current.operationId,
          target: state.target,
        });
      }
      if (current.current !== query) return;
      request.current = null;
      await read();
      window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    } catch (failure) {
      if (current.current === query) {
        setError({
          query,
          message:
            failure instanceof ApiError && failure.code === 'RUN_ALREADY_ACTIVE'
              ? t('blocked')
              : failure instanceof Error
                ? failure.message
                : String(failure),
        });
        await read().catch(() => {});
      }
    } finally {
      if (current.current === query) setBusy(null);
    }
  };
  return (
    <section className="flex flex-col gap-1.5 text-xs" aria-label={t('label')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={operation ? 'text-warning' : 'text-muted'}>
          {t(operation?.state === 'uncertain' ? 'uncertain' : operation ? 'shared' : 'strict')}
        </span>
        <Button size="xs" variant="outline" disabled={busy === query} onClick={() => void change()}>
          {t(operation ? 'finish' : 'start')}
        </Button>
      </div>
      {operation ? (
        <p className="text-muted">
          {t(operation.state === 'uncertain' ? 'recoveryNote' : 'sharedNote')}
        </p>
      ) : null}
      {error?.query === query ? (
        <p role="alert" className="text-danger">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
