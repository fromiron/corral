import type {
  CheckpointRestore,
  CheckpointRestorePlan,
  HunkSet,
  TextAttachment,
} from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { Button, Checkbox } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { type AttachmentCapture, beginAttachmentCapture } from './context/bridge.ts';

export function HunkActions({
  sessionId,
  projectId,
  from,
  to,
  path,
  active,
  onApplied,
  onAttach,
}: {
  sessionId: string;
  projectId: string;
  from: string;
  to: string;
  path: string;
  active: boolean;
  onApplied(): void;
  onAttach?(attachment: TextAttachment, capture: AttachmentCapture): void | Promise<void>;
}) {
  const { workspaces, mode, workspaceId } = useServices();
  const t = useTranslations('Hunks');
  const tc = useTranslations('Context');
  const [hunks, setHunks] = useState<HunkSet | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<(CheckpointRestorePlan & { operationId: string }) | null>(null);
  const [result, setResult] = useState<CheckpointRestore | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
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
      {!hunks ? (
        <Button
          size="compact"
          variant="tertiary"
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
                <Checkbox
                  label={`${t('part', { number: index + 1 })} · ${hunk.id.slice(0, 8)}`}
                  checked={selected.includes(hunk.id)}
                  disabled={busy}
                  onToggle={() => {
                    setSelected(
                      selected.includes(hunk.id)
                        ? selected.filter((id) => id !== hunk.id)
                        : [...selected, hunk.id],
                    );
                    setPlan(null);
                    setResult(null);
                    setAttached(false);
                  }}
                />
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    {t('showPatch')}
                  </summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{hunk.patch}</pre>
                </details>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {onAttach && workspaceId ? (
              <Button
                size="compact"
                variant="tertiary"
                disabled={busy || !selected.length}
                onClick={() =>
                  void act(async () => {
                    setAttached(false);
                    try {
                      const capture = beginAttachmentCapture({
                        hostId: workspaceId,
                        projectId,
                        sessionId,
                      });
                      const picked = hunks.hunks.filter((hunk) => selected.includes(hunk.id));
                      if (
                        !picked.length ||
                        hunks.from !== from ||
                        hunks.to !== to ||
                        hunks.path !== path
                      )
                        throw new Error('Changed comparison');
                      const attachment = createTextAttachment(
                        'selected-changes.patch',
                        'text/plain',
                        picked.map((hunk) => hunk.patch).join('\n'),
                        {
                          kind: 'hunk',
                          hostId: workspaceId,
                          projectId,
                          sessionId,
                          from: hunks.from,
                          to: hunks.to,
                          path: hunks.path,
                          patchHash: hunks.patchHash,
                          hunkIds: picked.map((hunk) => hunk.id),
                        },
                      );
                      await onAttach(attachment, capture);
                      if (mounted.current) setAttached(true);
                    } catch {
                      throw new Error(tc('attachFailed'));
                    }
                  })
                }
              >
                {t('attachSelected')}
              </Button>
            ) : null}
            <Button
              size="compact"
              variant="tertiary"
              disabled={busy || active || !selected.length}
              onClick={() => void prepare('apply_original')}
            >
              {t('planOriginal')}
            </Button>
            <Button
              size="compact"
              variant="tertiary"
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
            size="compact"
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
      {attached ? <p role="status">{tc('attached')}</p> : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
