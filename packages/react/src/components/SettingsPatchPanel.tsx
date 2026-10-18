import { PatchPayload, type ReasoningPolicy, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { ReasoningSelect } from './ReasoningSelect.tsx';
import { StatusBadge } from './StatusBadge.tsx';

type PatchKind = PatchPayload['kind'];
type Field =
  | 'prompt'
  | 'modelProfile'
  | 'reasoning'
  | 'maxIterations'
  | 'criteria'
  | 'maxOutputTokens'
  | 'maxModelCalls'
  | 'maxSpawns';

export function SettingsPatchPanel({
  session,
  nodeId,
}: {
  session: RunSessionStore;
  nodeId?: string;
}) {
  const t = useTranslations('SettingsPatch');
  const id = useId();
  const definition = useStore(session, (s) => s.definition);
  const projection = useStore(session, (s) => s.projection);
  const pending = useStore(session, (s) => s.pendingCommandIds.length > 0);
  const [kind, setKind] = useState<PatchKind>('run_limits');
  const [selectedNode, setSelectedNode] = useState(nodeId ?? '');
  const [field, setField] = useState<Field>('maxOutputTokens');
  const [proposed, setProposed] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningPolicy | null>(null);
  const [reasoningModel, setReasoningModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    payload: PatchPayload;
    revision: number;
    before: string;
    after: string;
    target: string;
    field: Field;
  } | null>(null);
  const criteriaId = projection?.currentCriteriaVersionId;
  const criteriaText = useStore(session, (s) =>
    criteriaId ? s.artifactTexts[criteriaId] : undefined,
  );
  useEffect(() => {
    if (criteriaId) void session.getState().loadArtifact(criteriaId);
  }, [session, criteriaId]);
  if (!definition || !projection) return null;
  const terminal = TERMINAL_RUN_STATUSES.has(projection.status);

  const nodes = definition.nodes.filter((node) =>
    kind === 'loop_limit' ? node.type === 'loop' : node.type === 'agent',
  );
  const node = nodes.find((candidate) => candidate.id === selectedNode) ?? nodes[0];
  const role =
    node?.type === 'agent'
      ? definition.roles.find((candidate) => candidate.id === node.roleId)
      : undefined;
  const patches = Object.values(projection.patches).sort(
    (a, b) => a.controlRevision - b.controlRevision,
  );
  const nodeSettings = patches
    .filter((patch) => patch.kind === kind && patch.scope.nodeId === node?.id)
    .reduce<Record<string, unknown>>(
      (settings, patch) => Object.assign(settings, patch.after),
      node?.type === 'loop'
        ? { maxIterations: node.maxIterations }
        : { prompt: role?.prompt, modelProfile: role?.modelProfile, reasoning: role?.reasoning },
    );
  const limits = projection.limits ?? definition.limits;
  const current =
    kind === 'run_limits'
      ? String(limits[field as 'maxOutputTokens' | 'maxModelCalls' | 'maxSpawns'])
      : kind === 'criteria'
        ? criteriaId
          ? (criteriaText ?? t('loadingCriteria'))
          : definition.input.criteria.join('\n')
        : field === 'reasoning'
          ? JSON.stringify(nodeSettings.reasoning ?? null)
          : String(nodeSettings[field] ?? '');
  const target = kind === 'run_limits' || kind === 'criteria' ? projection.runId : (node?.id ?? '');
  const fields: Field[] =
    kind === 'run_limits'
      ? ['maxOutputTokens', 'maxModelCalls', 'maxSpawns']
      : kind === 'node_future'
        ? ['prompt', 'modelProfile', 'reasoning']
        : kind === 'loop_limit'
          ? ['maxIterations']
          : ['criteria'];
  const changeKind = (next: PatchKind) => {
    setKind(next);
    setField(
      next === 'run_limits'
        ? 'maxOutputTokens'
        : next === 'node_future'
          ? 'prompt'
          : next === 'loop_limit'
            ? 'maxIterations'
            : 'criteria',
    );
    setProposed('');
    setPreview(null);
    setError(null);
  };
  const prepare = () => {
    const value = proposed.trim();
    const candidate =
      kind === 'run_limits'
        ? { kind, changes: { [field]: Number(value) } }
        : kind === 'criteria'
          ? {
              kind,
              baseCriteriaVersionId: criteriaId,
              criteria: value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            }
          : kind === 'loop_limit'
            ? { kind, nodeId: node?.id, maxIterations: Number(value) }
            : field === 'reasoning'
              ? {
                  kind,
                  nodeId: node?.id,
                  reasoning,
                  ...(reasoningModel.trim() ? { modelProfile: reasoningModel.trim() } : {}),
                }
              : { kind, nodeId: node?.id, [field]: value };
    const parsed = PatchPayload.safeParse(candidate);
    if (!parsed.success || !value) {
      setError(t('invalid'));
      return;
    }
    setError(null);
    setPreview({
      payload: parsed.data,
      revision: projection.controlRevision,
      before: current,
      after: value,
      target,
      field,
    });
  };
  const confirm = async () => {
    if (!preview) return;
    try {
      const receipt = await session.getState().sendCommand({
        type: 'patch',
        expectedControlRevision: preview.revision,
        payload: preview.payload,
      });
      if (receipt.status === 'rejected')
        setError(`${receipt.error?.code ?? 'rejected'}: ${receipt.error?.message ?? ''}`);
      else {
        setPreview((current) => (current === preview ? null : current));
        setProposed((current) => (current.trim() === preview.after ? '' : current));
      }
    } catch {
      /* Session keeps the unconfirmed receipt visible. */
    }
  };
  const previewNodes =
    preview?.payload.kind === 'node_future' || preview?.payload.kind === 'loop_limit'
      ? [preview.payload.nodeId]
      : definition.nodes
          .filter((candidate) => candidate.type === 'agent')
          .map((candidate) => candidate.id);
  const liveCount = projection.executionOrder.filter((executionId) => {
    const execution = projection.executions[executionId];
    return (
      execution &&
      previewNodes.includes(execution.nodeId) &&
      !['succeeded', 'failed', 'cancelled'].includes(execution.status)
    );
  }).length;
  return (
    <details className="rounded border border-line p-2 text-xs">
      <summary className="cursor-pointer font-semibold">{t('heading')}</summary>
      <div className="mt-2 flex flex-col gap-2">
        {!terminal ? (
          <>
            <label htmlFor={`${id}-kind`}>{t('scope')}</label>
            <select
              id={`${id}-kind`}
              value={kind}
              onChange={(event) => changeKind(event.target.value as PatchKind)}
              className="rounded border border-line bg-surface p-1"
            >
              {(['run_limits', 'node_future', 'loop_limit', 'criteria'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`kind.${value}`)}
                </option>
              ))}
            </select>
            {kind === 'node_future' || kind === 'loop_limit' ? (
              <>
                <label htmlFor={`${id}-node`}>{t('node')}</label>
                <select
                  id={`${id}-node`}
                  value={node?.id ?? ''}
                  onChange={(event) => {
                    setSelectedNode(event.target.value);
                    setPreview(null);
                  }}
                  className="rounded border border-line bg-surface p-1"
                >
                  {nodes.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label} · {candidate.id}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <label htmlFor={`${id}-field`}>{t('fieldLabel')}</label>
            <select
              id={`${id}-field`}
              value={field}
              onChange={(event) => {
                setField(event.target.value as Field);
                setProposed('');
                setPreview(null);
              }}
              className="rounded border border-line bg-surface p-1"
            >
              {fields.map((value) => (
                <option key={value} value={value}>
                  {t(`field.${value}`)}
                </option>
              ))}
            </select>
            <p className="text-muted">
              {t('current')}: <span className="whitespace-pre-wrap break-words">{current}</span>
            </p>
            {field === 'reasoning' ? (
              <>
                <ReasoningSelect
                  value={reasoning}
                  onChange={(value) => {
                    setReasoning(value);
                    setProposed(value?.mode === 'fixed' ? value.level : (value?.mode ?? ''));
                    setPreview(null);
                  }}
                />
                <label className="flex flex-col gap-1">
                  {t('reasoningModel')}
                  <input
                    className="rounded border border-line bg-surface p-2"
                    placeholder={String(nodeSettings.modelProfile ?? '')}
                    value={reasoningModel}
                    onChange={(event) => {
                      setReasoningModel(event.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <label htmlFor={`${id}-value`}>{t('proposed')}</label>
                <textarea
                  id={`${id}-value`}
                  value={proposed}
                  onChange={(event) => {
                    setProposed(event.target.value);
                    setPreview(null);
                  }}
                  rows={3}
                  className="rounded border border-line bg-surface p-2"
                />
              </>
            )}
            <button
              type="button"
              disabled={
                pending ||
                !proposed.trim() ||
                ((kind === 'node_future' || kind === 'loop_limit') && !node) ||
                (kind === 'criteria' && (!criteriaId || criteriaText === undefined))
              }
              onClick={prepare}
              className="rounded border border-line px-2 py-1 disabled:opacity-50"
            >
              {t('preview')}
            </button>
            {error ? (
              <p role="alert" className="text-danger">
                {error}
              </p>
            ) : null}
            {preview ? (
              <div
                className="flex flex-col gap-2 rounded border border-accent p-2"
                data-testid="patch-preview"
              >
                <h4 className="font-semibold">{t('diff')}</h4>
                <p>
                  {t('target', { target: preview.target })} · {t(`field.${preview.field}`)}
                </p>
                <dl className="flex flex-col gap-1">
                  <dt className="text-muted">{t('current')}</dt>
                  <dd className="whitespace-pre-wrap break-words">{preview.before}</dd>
                  <dt className="text-muted">{t('proposed')}</dt>
                  <dd className="whitespace-pre-wrap break-words">{preview.after}</dd>
                </dl>
                <p>{t(`boundary.${preview.payload.kind}`)}</p>
                <p>{t('futureNodes', { count: previewNodes.length })}</p>
                <p className="text-muted">{t('dynamicCount')}</p>
                <p>
                  {preview.payload.kind === 'node_future'
                    ? t('unchanged', { count: liveCount })
                    : t('snapshotsUnchanged')}
                </p>
                <p>
                  {t('spent', {
                    spent: projection.budget.spent,
                    held: projection.budget.reserved + projection.budget.unknownOutstanding,
                  })}
                </p>
                {projection.controlRevision !== preview.revision ? (
                  <p role="alert" className="text-warning">
                    {t('stale')}
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={pending || projection.controlRevision !== preview.revision}
                  onClick={() => void confirm()}
                  className="rounded bg-accent px-2 py-1 text-on-accent disabled:opacity-50"
                >
                  {t('confirm')}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-muted">{t('finished')}</p>
        )}
        {patches.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h4 className="font-semibold">{t('history')}</h4>
            {patches.map((patch) => (
              <div key={patch.patchId} className="rounded border border-line p-1">
                <p>
                  <span className="font-mono">{patch.patchId}</span> · {t(`kind.${patch.kind}`)} ·{' '}
                  <StatusBadge status="applied" />
                </p>
                <p>{t('target', { target: patch.scope.nodeId ?? projection.runId })}</p>
                <p>{t('committed', { revision: patch.controlRevision })}</p>
                <p>
                  {patch.executionIds.length + patch.iterationIds.length > 0
                    ? t('activated', {
                        targets: [...patch.executionIds, ...patch.iterationIds].join(', '),
                      })
                    : t('notActivated')}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
