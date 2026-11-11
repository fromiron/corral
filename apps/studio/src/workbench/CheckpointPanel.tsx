import type { CheckpointRestore, CheckpointRestorePlan, FileCheckpoint } from '@corral/contracts';
import {
  type AgentCheckpoint,
  AgentCheckpoints,
  Button,
  fontWeights,
  Input,
  Switch,
} from '@corral/react/design-kit';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { WORKSPACE_CHANGED } from '../pages/FilesViews.tsx';
import { useServices } from '../services.tsx';
import { unchangedCheckpoints } from './fileReviewPresentation.ts';

const kindLabels: Partial<Record<FileCheckpoint['kind'], string>> = {
  before_run: 'Before Run',
  after_run: 'After Run',
  runtime: 'Runtime boundary',
  hunk_proposal: 'Selected hunk proposal',
};

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
  if (mode === 'browser')
    return <p className="text-caption text-muted-foreground">{t('localOnly')}</p>;
  const unchanged = unchangedCheckpoints(items);
  const visible = items.filter((item) => item.state !== 'expired');
  // The preview plans a restore and shows what it would change; restoring is its own button.
  const preview = (item: FileCheckpoint) =>
    act(async () => {
      if (!item.manifestHash) return;
      const value = await workspaces.planCheckpointRestore(
        sessionId,
        item.checkpointId,
        item.manifestHash,
      );
      if (mounted.current)
        setPlan({
          ...value,
          operationId: `restore_${crypto.randomUUID().replaceAll('-', '')}`,
        });
    });
  const title = (item: FileCheckpoint) =>
    item.kind === 'manual' ? item.label : t(`kind.${item.kind}`);
  // The kit lane runs oldest first, one lane per target; the API answers newest first.
  const lanes = (['working_copy', 'original'] as const)
    .map((target) => ({
      target,
      items: visible
        .filter((item) => (item.target ?? 'working_copy') === target)
        .toReversed()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .filter((lane) => lane.target === 'working_copy' || lane.items.length > 0);
  const laneItem = (item: FileCheckpoint): AgentCheckpoint => ({
    id: item.checkpointId,
    label: [
      title(item),
      item.pinned ? t('kept') : null,
      unchanged.has(item.checkpointId) ? t('unchangedShort') : null,
    ]
      .filter(Boolean)
      .join(' · '),
    status: item.state === 'ready' ? 'done' : 'failed',
    at: Date.parse(item.createdAt),
  });
  const rewind = (checkpointId: string) => {
    const item = visible.find((value) => value.checkpointId === checkpointId);
    if (item?.state === 'ready' && !busy) void preview(item);
  };
  return (
    <section aria-labelledby={id} className="@container flex flex-col gap-2 text-caption">
      <h4 id={id} className="text-body" style={{ fontVariationSettings: fontWeights.semibold }}>
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
        <Button variant="ghost" disabled={busy} onClick={() => void act(reload)}>
          {t('refresh')}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void act(() => workspaces.pruneCheckpoints(sessionId))}
        >
          {t('prune')}
        </Button>
      </div>
      <p className="text-muted-foreground">{t('retention')}</p>
      {/* The lane shows the timeline and asks for a restore preview; the rows beside it keep
          what the lane cannot show: time, request, target, notes and Keep. */}
      <div className="grid min-w-0 items-start gap-3 @2xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          {lanes.map((lane) => (
            <AgentCheckpoints
              key={lane.target}
              data-testid="checkpoint-lane"
              className="rounded-lg fill-group"
              title={t(lane.target === 'original' ? 'original' : 'workingCopy')}
              checkpoints={lane.items.map(laneItem)}
              startedAt={lane.items[0] ? Date.parse(lane.items[0].createdAt) : 0}
              onRewind={rewind}
              emptyLabel={t('empty')}
              labels={{
                count: (count) => t('lane.count', { count }),
                current: (label) => t('lane.current', { label }),
                rewindHint: (label) => t('lane.rewindHint', { label }),
                failed: t('state.incomplete'),
                rewind: t('preview'),
              }}
            />
          ))}
        </div>
        <ul className="max-h-96 overflow-y-auto space-y-2">
          {visible.map((item) => (
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
              {item.kind !== 'manual' && item.label && item.label !== kindLabels[item.kind] ? (
                <p className="text-muted-foreground">{item.label}</p>
              ) : null}
              {unchanged.has(item.checkpointId) ? (
                <p className="text-muted-foreground">{t('unchanged')}</p>
              ) : null}
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
                  variant="ghost"
                  disabled={busy || item.state !== 'ready'}
                  onClick={() => void preview(item)}
                >
                  {t('preview')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {plan ? (
        <section aria-label={t('preview')} className="rounded fill-group p-2">
          <p style={{ fontVariationSettings: fontWeights.semibold }}>
            {t(plan.target === 'original' ? 'original' : 'workingCopy')}
          </p>
          <p>{t('restoreExplain', { count: plan.files.length })}</p>
          {plan.files.length === 0 ? <p role="status">{t('alreadyMatches')}</p> : null}
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
              variant="tertiary"
              disabled={busy || plan.files.length === 0}
              onClick={() =>
                void act(async () => {
                  if (plan.files.length === 0) return;
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
            <Button variant="ghost" disabled={busy} onClick={() => setPlan(null)}>
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
