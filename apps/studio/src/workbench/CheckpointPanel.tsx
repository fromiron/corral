import type { CheckpointRestore, CheckpointRestorePlan, FileCheckpoint } from '@corral/contracts';
import { Button, Input, Switch } from '@corral/react/design-kit';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { WORKSPACE_CHANGED } from '../pages/FilesViews.tsx';
import { useServices } from '../services.tsx';

export function CheckpointPanel({ sessionId }: { sessionId: string }) {
  const { workspaces, mode, repository } = useServices();
  const t = useTranslations('Checkpoints');
  const format = useFormatter();
  const [requests, setRequests] = useState<Record<string, string>>({});
  const id = useId();
  const [items, setItems] = useState<FileCheckpoint[]>([]);
  const [restores, setRestores] = useState<CheckpointRestore[]>([]);
  const [label, setLabel] = useState('');
  const [plan, setPlan] = useState<(CheckpointRestorePlan & { operationId: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = useRef<{ checkpointId: string; label: string } | null>(null);
  const mounted = useRef(true);
  const reload = useCallback(async () => {
    const [data, session] = await Promise.all([
      workspaces?.checkpoints(sessionId),
      repository.getSession(sessionId).catch(() => null),
    ]);
    if (data && mounted.current) {
      setItems(data.checkpoints);
      setRequests(
        Object.fromEntries(
          session?.entries.flatMap((entry) =>
            entry.runId && entry.intent !== 'steer' ? [[entry.runId, entry.text]] : [],
          ) ?? [],
        ),
      );
      setRestores(data.restores);
    }
  }, [workspaces, repository, sessionId]);
  useEffect(() => {
    mounted.current = true;
    void reload().catch(() => {
      if (mounted.current) setError(t('loadFailed'));
    });
    return () => {
      mounted.current = false;
    };
  }, [reload, t]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await reload();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : t('loadFailed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!workspaces) return null;
  if (mode === 'browser') return <p className="text-xs text-muted-foreground">{t('localOnly')}</p>;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-line pt-3 text-xs">
      <h4 id={id} className="font-medium">
        {t('heading')}
      </h4>
      <p className="text-muted-foreground">{t('scope')}</p>
      <label htmlFor={`${id}-label`} className="flex flex-col gap-1">
        {t('label')}
        <Input
          id={`${id}-label`}
          value={label}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="compact"
          variant="tertiary"
          disabled={busy || !label.trim()}
          onClick={() =>
            void act(async () => {
              if (capture.current?.label !== label.trim())
                capture.current = {
                  checkpointId: `checkpoint_${crypto.randomUUID().replaceAll('-', '')}`,
                  label: label.trim(),
                };
              await workspaces.captureCheckpoint(sessionId, capture.current);
              capture.current = null;
              setLabel('');
            })
          }
        >
          {t('capture')}
        </Button>
        <Button size="compact" variant="ghost" disabled={busy} onClick={() => void act(reload)}>
          {t('refresh')}
        </Button>
        <Button
          size="compact"
          variant="ghost"
          disabled={busy}
          onClick={() => void act(() => workspaces.pruneCheckpoints(sessionId))}
        >
          {t('prune')}
        </Button>
      </div>
      <p className="text-muted-foreground">{t('retention')}</p>
      <ul className="max-h-64 overflow-y-auto space-y-2">
        {items
          .filter((item) => item.state !== 'expired')
          .map((item) => (
            <li
              key={item.checkpointId}
              data-testid="checkpoint-row"
              className="border-l border-line pl-2"
            >
              <p>
                {item.kind === 'manual' ? item.label : t(`kind.${item.kind}`)} ·{' '}
                {t(item.target === 'original' ? 'original' : 'workingCopy')} ·{' '}
                {t(`state.${item.state}`)} · <code>{item.tree?.slice(0, 8)}</code>
              </p>
              <p className="text-muted-foreground">
                <time dateTime={item.createdAt}>
                  {format.dateTime(new Date(item.createdAt), {
                    dateStyle: 'short',
                    timeStyle: 'medium',
                  })}
                </time>
                {item.runId ? ` · ${requests[item.runId] ?? t('requestUnavailable')}` : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  label={t('pin')}
                  checked={item.pinned}
                  disabled={busy || item.state !== 'ready'}
                  onToggle={() =>
                    void act(() =>
                      workspaces.pinCheckpoint(sessionId, item.checkpointId, !item.pinned),
                    )
                  }
                />
                <Button
                  size="compact"
                  variant="ghost"
                  disabled={busy || item.state !== 'ready'}
                  onClick={() =>
                    void act(async () => {
                      const value = await workspaces.planCheckpointRestore(
                        sessionId,
                        item.checkpointId,
                        item.manifestHash!,
                      );
                      if (mounted.current)
                        setPlan({
                          ...value,
                          operationId: `restore_${crypto.randomUUID().replaceAll('-', '')}`,
                        });
                    })
                  }
                >
                  {t('preview')}
                </Button>
              </div>
            </li>
          ))}
      </ul>
      {plan ? (
        <section aria-label={t('preview')} className="rounded fill-group p-2">
          <p className="font-medium">
            {t(plan.target === 'original' ? 'original' : 'workingCopy')}
          </p>
          <p>{t('restoreExplain', { count: plan.files.length })}</p>
          <p className="font-mono">
            {plan.expectedTree.slice(0, 8)} → {plan.targetTree.slice(0, 8)}
          </p>
          <ul className="max-h-40 overflow-y-auto">
            {plan.files.map((file) => (
              <li key={file.path}>
                {file.status} · {file.path}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button
              size="compact"
              variant="tertiary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await workspaces.restoreCheckpoint(sessionId, {
                    operationId: plan.operationId,
                    checkpointId: plan.checkpointId,
                    manifestHash: plan.manifestHash,
                    expectedTree: plan.expectedTree,
                  });
                  setPlan(null);
                  window.dispatchEvent(new Event(WORKSPACE_CHANGED));
                })
              }
            >
              {t(plan.target === 'original' ? 'restoreOriginal' : 'restore')}
            </Button>
            <Button size="compact" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>
              {t('close')}
            </Button>
          </div>
        </section>
      ) : null}
      {restores.slice(0, 5).map((item) => (
        <p
          key={item.operationId}
          role="status"
          data-testid="checkpoint-restore"
          data-target={item.target ?? 'working_copy'}
        >
          {t(item.target === 'original' ? 'original' : 'workingCopy')} ·{' '}
          {t('restoreResult', { state: t(`restoreState.${item.state}`) })} ·{' '}
          <code>
            {item.from.slice(0, 8)} → {item.to.slice(0, 8)}
          </code>
        </p>
      ))}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
