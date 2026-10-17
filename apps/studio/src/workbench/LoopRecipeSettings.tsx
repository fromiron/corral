import { type LoopNode, type RegisteredCheck, ReviewRecipeRevision } from '@corral/contracts';
import { reviewCriteriaHash } from '@corral/core';
import { useStudioStores } from '@corral/react';
import { Button } from '@corral/react/ui';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';

const field = 'rounded border border-line bg-surface p-2 text-sm';
export function LoopRecipeSettings({ node, projectId }: { node: LoopNode; projectId: string }) {
  const { editor } = useStudioStores(),
    { harnesses: api } = useServices();
  const definition = useStore(editor, (state) => state.draft.definition);
  const t = useTranslations('Recipe');
  const members = definition.nodes.flatMap((item) =>
    item.type === 'agent' && item.loopId === node.id ? [item] : [],
  );
  const candidates = members.filter(
    (item) => definition.roles.find((role) => role.id === item.roleId)?.outputContract !== 'review',
  );
  const reviewers = members.filter(
    (item) => definition.roles.find((role) => role.id === item.roleId)?.outputContract === 'review',
  );
  const [values, setValues] = useState<ReviewRecipeRevision>(
    () =>
      node.reviewRecipe ?? {
        recipeId: `recipe_${node.id}`,
        revision: 1,
        criteriaHash: reviewCriteriaHash(definition.input.criteria),
        candidateNodeId: candidates[0]?.id ?? '',
        evaluatorRoleId: reviewers[0]?.roleId ?? '',
        checkIds: [],
        criteriaFiles: [],
        maxAttempts: node.maxIterations,
        maxRepairs: Math.max(0, node.maxIterations - 1),
        maxWallMs: Math.min(definition.limits.runDeadlineMs, 300000),
        maxModelCalls: Math.min(definition.limits.maxModelCalls, 20),
        maxOutputTokens: Math.min(definition.limits.maxOutputTokens, 20000),
      },
  );
  const [paths, setPaths] = useState(
    (node.reviewRecipe?.criteriaFiles ?? []).map((file) => file.path).join('\n'),
  );
  const [checks, setChecks] = useState<RegisteredCheck[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.projectTools(projectId).then(
      (config) => {
        if (active) setChecks(config?.checks ?? []);
      },
      () => {
        if (active) setError(t('loadFailed'));
      },
    );
    return () => {
      active = false;
    };
  }, [api, projectId, t]);
  async function save() {
    const criteriaHash = reviewCriteriaHash(definition.input.criteria);
    setBusy(true);
    setError('');
    try {
      const selectedPaths = paths
        .split('\n')
        .map((path) => path.trim())
        .filter(Boolean);
      if (selectedPaths.length && !api) throw new Error(t('filesNeedServer'));
      const criteriaFiles =
        selectedPaths.length && api ? await api.criteriaFiles(projectId, selectedPaths) : [];
      const parsed = ReviewRecipeRevision.safeParse({
        ...values,
        revision: (node.reviewRecipe?.revision ?? 0) + 1,
        criteriaHash,
        criteriaFiles,
      });
      if (!parsed.success) throw new Error(t('invalid'));
      const current = editor.getState().draft.definition;
      const currentNode = current.nodes.find((item) => item.id === node.id);
      if (
        currentNode?.type !== 'loop' ||
        JSON.stringify(currentNode.reviewRecipe) !== JSON.stringify(node.reviewRecipe) ||
        reviewCriteriaHash(current.input.criteria) !== criteriaHash
      )
        throw new Error(t('changed'));
      editor.getState().updateNode(node.id, { reviewRecipe: parsed.data });
    } catch (error) {
      setError(error instanceof Error ? error.message : t('invalid'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={busy} className="flex flex-col gap-2 border-y border-line py-3">
      <legend className="text-sm font-semibold">{t('heading')}</legend>
      <p className="text-xs text-muted">{t('setupHint')}</p>
      {node.reviewRecipe ? (
        <p role="status" className="text-xs">
          {t('pinned', { revision: node.reviewRecipe.revision })}
        </p>
      ) : null}
      <label className="flex flex-col gap-1 text-xs">
        {t('candidate')}
        <select
          className={field}
          value={values.candidateNodeId}
          onChange={(event) =>
            setValues((value) => ({ ...value, candidateNodeId: event.target.value }))
          }
        >
          <option value="">{t('choose')}</option>
          {candidates.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t('evaluator')}
        <select
          className={field}
          value={values.evaluatorRoleId}
          onChange={(event) =>
            setValues((value) => ({ ...value, evaluatorRoleId: event.target.value }))
          }
        >
          <option value="">{t('choose')}</option>
          {reviewers.map((item) => (
            <option key={item.id} value={item.roleId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs font-medium">{t('criteria')}</p>
      <ul className="list-disc pl-4 text-xs">
        {definition.input.criteria.map((criterion) => (
          <li key={criterion}>{criterion}</li>
        ))}
      </ul>
      {node.reviewRecipe &&
      node.reviewRecipe.criteriaHash !== reviewCriteriaHash(definition.input.criteria) ? (
        <p role="alert" className="text-xs text-warning">
          {t('criteriaChanged')}
        </p>
      ) : null}
      {(
        [
          ['maxAttempts', 1, 10],
          ['maxRepairs', 0, 9],
          ['maxWallMs', 1000, 3600000],
          ['maxModelCalls', 1, 100],
          ['maxOutputTokens', 1, 256000],
        ] as const
      ).map(([key, min, max]) => (
        <label key={key} className="flex flex-col gap-1 text-xs">
          {t(key)}
          <input
            type="number"
            className={field}
            min={key === 'maxWallMs' ? min / 1000 : min}
            max={key === 'maxWallMs' ? max / 1000 : max}
            value={
              Number.isNaN(values[key])
                ? ''
                : key === 'maxWallMs'
                  ? values[key] / 1000
                  : values[key]
            }
            onChange={(event) =>
              setValues((value) => ({
                ...value,
                [key]: event.target.valueAsNumber * (key === 'maxWallMs' ? 1000 : 1),
              }))
            }
          />
        </label>
      ))}
      <p className="text-xs text-muted">{t('limitsHint')}</p>
      <p className="text-xs font-medium">{t('checks')}</p>
      {checks.map((check) => (
        <label key={check.id} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={values.checkIds.includes(check.id)}
            onChange={(event) =>
              setValues((value) => ({
                ...value,
                checkIds: event.target.checked
                  ? [...value.checkIds, check.id]
                  : value.checkIds.filter((id) => id !== check.id),
              }))
            }
          />
          {check.name}
        </label>
      ))}
      {values.checkIds
        .filter((id) => !checks.some((check) => check.id === id))
        .map((id) => (
          <label key={id} className="flex items-center gap-2 text-xs text-warning">
            <input
              type="checkbox"
              checked
              onChange={() =>
                setValues((value) => ({
                  ...value,
                  checkIds: value.checkIds.filter((item) => item !== id),
                }))
              }
            />
            {t('missingCheck', { id })}
          </label>
        ))}
      <p className="text-xs text-muted">{t('checksHint')}</p>
      <label className="flex flex-col gap-1 text-xs">
        {t('files')}
        <textarea
          className={field}
          rows={2}
          value={paths}
          onChange={(event) => setPaths(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted">{t('filesHint')}</p>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Button
        size="sm"
        disabled={!values.candidateNodeId || !values.evaluatorRoleId}
        onClick={() => void save()}
      >
        {t('save')}
      </Button>
      {node.reviewRecipe ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => editor.getState().updateNode(node.id, { reviewRecipe: null })}
        >
          {t('remove')}
        </Button>
      ) : null}
    </fieldset>
  );
}
