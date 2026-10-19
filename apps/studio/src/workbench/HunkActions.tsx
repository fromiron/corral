import type { CheckpointRestore, CheckpointRestorePlan, HunkSet } from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

export function HunkActions({
  sessionId,
  from,
  to,
  path,
  active,
  onApplied,
}: {
  sessionId: string;
  from: string;
  to: string;
  path: string;
  active: boolean;
  onApplied(): void;
}) {
  const { workspaces, mode } = useServices();
  const t = useTranslations('Hunks');
  const [hunks, setHunks] = useState<HunkSet | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<(CheckpointRestorePlan & { operationId: string }) | null>(null);
  const [result, setResult] = useState<CheckpointRestore | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (mode !== 'server' || !workspaces) return null;
  const prepare = (action: 'apply_original' | 'revert_working_copy') =>
    act(async () => {
      if (!hunks || !selected.length) return;
      const value = await workspaces.planHunks(sessionId, {
        planId: `hunk_${crypto.randomUUID().replaceAll('-', '')}`,
        from,
        to,
        path,
        patchHash: hunks.patchHash,
        hunkIds: selected,
        action,
      });
      if (mounted.current) {
        setPlan({ ...value, operationId: `restore_${crypto.randomUUID().replaceAll('-', '')}` });
        setResult(null);
      }
    });
  return (
    <section className="mt-4 space-y-2 border-t border-line pt-3 text-xs" aria-label={t('heading')}>
      <h3 className="font-medium">{t('heading')}</h3>
      <p className="text-muted">{t('hint')}</p>
      {!hunks ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const value = await workspaces.hunks(sessionId, { from, to, path });
              if (mounted.current) setHunks(value);
            })
          }
        >
          {t('load')}
        </Button>
      ) : (
        <>
          <ul className="space-y-2">
            {hunks.hunks.map((hunk, index) => (
              <li key={hunk.id}>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={selected.includes(hunk.id)}
                    disabled={busy}
                    onChange={(event) => {
                      setSelected(
                        event.target.checked
                          ? [...selected, hunk.id]
                          : selected.filter((id) => id !== hunk.id),
                      );
                      setPlan(null);
                      setResult(null);
                    }}
                  />
                  {t('part', { number: index + 1 })} · <code>{hunk.id.slice(0, 8)}</code>
                </label>
                <details>
                  <summary className="cursor-pointer text-muted">{t('showPatch')}</summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{hunk.patch}</pre>
                </details>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || active || !selected.length}
              onClick={() => void prepare('apply_original')}
            >
              {t('planOriginal')}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || active || !selected.length}
              onClick={() => void prepare('revert_working_copy')}
            >
              {t('planRevert')}
            </Button>
          </div>
        </>
      )}
      {plan && !result ? (
        <div className="space-y-2 rounded fill-group p-2">
          <p className="font-medium">
            {t(plan.target === 'original' ? 'original' : 'workingCopy')}
          </p>
          <p>{t('approval', { count: selected.length, path })}</p>
          <p className="font-mono">
            {plan.expectedTree.slice(0, 12)} → {plan.targetTree.slice(0, 12)}
          </p>
          <Button
            size="xs"
            disabled={busy || active}
            onClick={() =>
              void act(async () => {
                const applied = await workspaces.restoreCheckpoint(sessionId, {
                  operationId: plan.operationId,
                  checkpointId: plan.checkpointId,
                  manifestHash: plan.manifestHash,
                  expectedTree: plan.expectedTree,
                });
                if (mounted.current) {
                  setResult(applied);
                  if (applied.state === 'applied') onApplied();
                }
              })
            }
          >
            {t(plan.target === 'original' ? 'applyOriginal' : 'revertCopy')}
          </Button>
        </div>
      ) : null}
      {result ? <p role="status">{t(`state.${result.state}`)}</p> : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
