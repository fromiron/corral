import type {
  CheckpointRestore,
  CheckpointRestorePlan,
  HunkSet,
  TextAttachment,
} from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { Button, Checkbox, fontWeights } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { type AttachmentCapture, beginAttachmentCapture } from './context/bridge.ts';

/**
 * The line numbers the diff shows on a part's changed lines: a removed line by its number in
 * the old file, an added one by its number in the new file. Null for a part without a header.
 */
export function partLines(patch: string): { start: number; end: number } | null {
  const [header = '', ...body] = patch.split('\n');
  const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!at) return null;
  let before = Number(at[1]);
  let after = Number(at[2]);
  const shown: number[] = [];
  for (const line of body) {
    if (line.startsWith('-')) shown.push(before++);
    else if (line.startsWith('+')) shown.push(after++);
    else if (line.startsWith(' ')) {
      before++;
      after++;
    }
  }
  if (!shown.length) return null;
  return { start: Math.min(...shown), end: Math.max(...shown) };
}

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
  const partName = (patch: string, index: number) => {
    const lines = partLines(patch);
    if (!lines) return t('part', { number: index + 1 });
    return lines.start === lines.end
      ? t('line', { line: lines.start })
      : t('lines', { start: lines.start, end: lines.end });
  };
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
    // The button names the part until it opens; no heading stands over that one control.
    <section
      className="flex flex-col gap-2 border-t border-border pt-3 text-caption"
      aria-label={t('heading')}
    >
      {!hunks ? (
        <Button
          size="compact"
          variant="tertiary"
          className="self-start"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const value = await workspaces.hunks(sessionId, { from, to, path });
              if (mounted.current) setHunks(value);
            })
          }
        >
          {t('heading')}
        </Button>
      ) : (
        <>
          {/* A long path keeps its file name: it is cut at the start. */}
          <p
            dir="rtl"
            title={path}
            className="m-0 truncate text-left font-mono text-muted-foreground"
          >
            <bdi>{path}</bdi>
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {hunks.hunks.map((hunk, index) => (
              // The part's number and hash stay on it for support; its name is its lines.
              <li
                key={hunk.id}
                title={`${t('part', { number: index + 1 })} · ${hunk.id.slice(0, 8)}`}
              >
                <Checkbox
                  label={partName(hunk.patch, index)}
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
                  <pre className="m-0 max-h-64 overflow-auto font-mono whitespace-pre-wrap">
                    {hunk.patch}
                  </pre>
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
        <div className="flex flex-col items-start gap-2 fill-group p-3">
          {/* The trees the preview goes between stay on its heading for support. */}
          <p
            className="m-0"
            style={{ fontVariationSettings: fontWeights.semibold }}
            title={`${plan.expectedTree.slice(0, 12)} → ${plan.targetTree.slice(0, 12)}`}
          >
            {t(plan.target === 'original' ? 'original' : 'workingCopy')}
          </p>
          <p className="m-0">{t('approval', { count: selected.length, path })}</p>
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
      {result ? (
        <p role="status" className="m-0">
          {t(`state.${result.state}`)}
        </p>
      ) : null}
      {attached ? (
        <p role="status" className="m-0">
          {tc('attached')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
