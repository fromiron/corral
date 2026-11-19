import { ApiError } from '@corral/client';
import {
  hasReviewLoop,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
  UNUSABLE_TEAM_PLAN_MESSAGE,
} from '@corral/contracts';
import { isReadOnlyTeam, planAfterModel, planWithPattern, type TeamWording } from '@corral/core';
import {
  draftFromDefinition,
  draftFromPlan,
  planFromGoal,
  setRequiredOutputReview,
} from '@corral/react';
import {
  Button,
  fontWeights,
  Input,
  KitBadge,
  Select,
  Switch,
  Textarea,
} from '@corral/react/design-kit';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMessages, useTranslations } from 'use-intl';
import { Modal } from './CommandPalette.tsx';
import { useServices } from './services.tsx';
import { draftWording, patternName } from './templates.ts';

/**
 * Goal → team draft. The person writes a goal, gets a plan from the local suggestion or
 * one model request, edits it, and only "Open in editor" saves it. Tools and wiring come from
 * the pattern (draftFromPlan), never from the plan's text.
 */
export function TeamDraftDialog({
  onClose,
  projectId,
}: {
  onClose: () => void;
  /** The project the drafted Corral is saved in. */
  projectId?: string;
}) {
  const t = useTranslations('TeamDraft');
  const shared = useTranslations('TeamEditor.sharedOutrider');
  const inspector = useTranslations('Inspector');
  const messages = useMessages();
  const wording = useMemo(() => draftWording(messages), [messages]);
  const { repository, models, live } = useServices();
  const navigate = useNavigate();
  const [goal, setGoal] = useState('');
  const [plan, setPlan] = useState<TeamPlan | null>(null);
  const [reviewTargets, setReviewTargets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<ReturnType<typeof planAfterModel>['recovery']>(null);
  const [askFailed, setAskFailed] = useState(false);
  const pendingRequest = useRef<AbortController | null>(null);
  const draftIntent = useRef<{ goal: string; id: string } | null>(null);
  useEffect(() => () => pendingRequest.current?.abort(), []);
  const goalId = useId();
  const goalRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!plan) goalRef.current?.focus();
  }, [plan]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const suggest = () => {
    setError(null);
    setAskFailed(false);
    setRecovery(null);
    setPlan(planFromGoal(goal, wording));
  };
  const ask = async () => {
    if (!models) return;
    setBusy(true);
    setError(null);
    setRecovery(null);
    const controller = new AbortController();
    pendingRequest.current?.abort();
    pendingRequest.current = controller;
    if (draftIntent.current?.goal !== goal.trim())
      draftIntent.current = { goal: goal.trim(), id: globalThis.crypto.randomUUID() };
    try {
      const result = await models.draftTeam(goal.trim(), {
        operationId: draftIntent.current.id,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setAskFailed(false);
        const resolved = planAfterModel(goal, result.plan, wording);
        setPlan(resolved.plan);
        setRecovery(resolved.recovery);
      }
    } catch (failure) {
      const unusable =
        failure instanceof ApiError &&
        failure.code === 'MODEL_UNAVAILABLE' &&
        failure.message.startsWith(UNUSABLE_TEAM_PLAN_MESSAGE);
      if (
        failure instanceof ApiError &&
        ['MODEL_UNAVAILABLE', 'CAPABILITY_DENIED'].includes(failure.code)
      )
        draftIntent.current = null;
      if (!controller.signal.aborted) {
        if (unusable) {
          const resolved = planAfterModel(goal, null, wording);
          if (resolved.plan) {
            setAskFailed(false);
            setPlan(resolved.plan);
            setRecovery(resolved.recovery);
            return;
          }
        }
        setAskFailed(true);
        // The server's words for an unusable answer are not in the screen's language.
        setError(
          unusable ? t('unusable') : failure instanceof Error ? failure.message : String(failure),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const checked = plan ? TeamPlan.safeParse(plan) : null;
  const base = checked?.success
    ? draftFromPlan(checked.data, 'preview', wording.labels).definition
    : null;
  const targets =
    plan?.outrider === 'required_review' && base
      ? base.nodes.flatMap((output) =>
          output.type === 'output'
            ? output.inputBindings.flatMap((binding) => {
                if (binding.kind !== 'task_output' || !binding.sourceNodeId) return [];
                const sourceId = binding.sourceNodeId;
                return [
                  {
                    key: JSON.stringify([output.id, binding.name, sourceId]),
                    outputId: output.id,
                    output: output.label,
                    bindingName: binding.name,
                    sourceId,
                    source: base.nodes.find((n) => n.id === sourceId)?.label ?? sourceId,
                  },
                ];
              })
            : [],
        )
      : [];
  let preview = base;
  const confirmed = targets.filter((target) => reviewTargets.includes(target.key));
  if (base && confirmed.length) {
    let draft = draftFromDefinition(base);
    for (const target of confirmed) {
      const change = setRequiredOutputReview(
        draft,
        target.outputId,
        target.bindingName,
        target.sourceId,
        true,
      );
      if (!change.ok) {
        preview = null;
        break;
      }
      draft = change.draft;
      preview = draft.definition;
    }
  }
  const unresolved =
    plan?.outrider === 'clarify_review' ||
    (plan?.outrider === 'required_review' && !confirmed.length);
  const open = async () => {
    if (!preview || busy || unresolved) return;
    setBusy(true);
    try {
      const saved = await repository.save({
        definition: { ...preview, id: `team_${globalThis.crypto.randomUUID().slice(0, 8)}` },
        expectedDefinitionRevision: null,
        ...(projectId ? { projectId } : {}),
      });
      if (!saved.ok) return setError(saved.message);
      onClose();
      await navigate({
        to: '/corrals/$corralId/edit',
        params: { corralId: saved.record.corralId },
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal label={t('title')} onClose={onClose}>
      <div className="flex max-h-[76vh] flex-col gap-3 overflow-y-auto p-4">
        <h2 className="text-title" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('title')}
        </h2>
        {recovery ? (
          <p role="alert" className="text-body">
            {t(recovery === 'unusable' ? 'localAfterInvalidModel' : 'localAfterMismatchedModel')}
          </p>
        ) : null}
        {!plan ? (
          <>
            <label
              htmlFor={goalId}
              className="text-subtitle"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {t('goalLabel')}
            </label>
            <Textarea
              id={goalId}
              ref={goalRef}
              value={goal}
              maxLength={2000}
              rows={4}
              onChange={(e) => {
                pendingRequest.current?.abort();
                draftIntent.current = null;
                setAskFailed(false);
                setGoal(e.target.value);
              }}
              placeholder={t('goalPlaceholder')}
            />
            <div className="flex flex-wrap items-start gap-3">
              <Button
                variant="primary"
                size="compact"
                type="button"
                disabled={!goal.trim() || busy}
                onClick={suggest}
                className="self-start"
              >
                {t('suggest')}
                <KitBadge size="compact" color="gray">
                  {t('noModelCall')}
                </KitBadge>
              </Button>
              {live && models ? (
                <Button
                  variant="tertiary"
                  size="compact"
                  type="button"
                  disabled={!goal.trim() || busy}
                  onClick={() => void ask()}
                  className="self-start"
                >
                  {busy ? t('asking') : askFailed ? t('retry') : t('ask')}
                  <KitBadge size="compact" color="gray">
                    {t('askCost')}
                  </KitBadge>
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {plan.outrider === 'clarify_review' ? (
              <div className="grid gap-2 rounded fill-group p-3">
                <p>{t('reviewQuestion')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => setPlan({ ...plan, outrider: 'artifact_review' })}
                  >
                    {t('reviewFeedback')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => setPlan({ ...plan, outrider: 'required_review' })}
                  >
                    {t('reviewRequired')}
                  </Button>
                </div>
              </div>
            ) : null}
            {targets.map((target, index) => {
              const hint = `${goalId}-review-${index}`;
              return (
                <div key={target.key} className="grid gap-1 rounded fill-group p-3">
                  <Switch
                    label={inspector('requireReview')}
                    aria-describedby={hint}
                    checked={reviewTargets.includes(target.key)}
                    onToggle={() =>
                      setReviewTargets((prev) =>
                        prev.includes(target.key)
                          ? prev.filter((key) => key !== target.key)
                          : [...prev, target.key],
                      )
                    }
                  />
                  <p id={hint} className="text-caption text-muted-foreground">
                    {target.output} ·{' '}
                    {inspector('requiredReviewSource', {
                      binding: target.bindingName,
                      source: target.source,
                    })}
                  </p>
                </div>
              );
            })}
            <PlanEditor
              plan={plan}
              wording={wording}
              onChange={(next) => {
                if (next.pattern !== plan.pattern) setReviewTargets([]);
                setPlan(next);
              }}
            />
            {preview ? (
              <div className="grid gap-1 rounded fill-group p-3 text-body">
                <h3 className="text-subtitle">{t('beforeSaving')}</h3>
                <p>{t(isReadOnlyTeam(preview) ? 'readOnlyWork' : 'changesWork')}</p>
                <p>{t(confirmed.length || hasReviewLoop(plan.pattern) ? 'hasReviewRound' : 'noReviewRound')}</p>
                <Switch
                  label={shared('observe')}
                  checked={Boolean(plan.observeWork)}
                  onToggle={() => {
                    const { observeWork, ...rest } = plan;
                    setPlan(observeWork ? rest : { ...rest, observeWork: true });
                  }}
                />
                {preview.sharedOutrider?.observation ? (
                  <p>
                    {t('observationSummary', {
                      model: preview.sharedOutrider.modelProfile,
                      interval: preview.sharedOutrider.observation.review.interval,
                      cap: preview.sharedOutrider.observation.review.maxRequestsPerReview,
                    })}
                  </p>
                ) : null}
                {preview.sharedOutrider ? (
                  <p>
                    {t(plan.outrider === 'artifact_review' ? 'artifactAdvice' : 'sharedAdvice')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        ) : null}
        {checked && !checked.success ? (
          <p className="text-caption text-danger">{t('invalid')}</p>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          {plan ? (
            <Button
              type="button"
              onClick={() => {
                draftIntent.current = null;
                setRecovery(null);
                setPlan(null);
              }}
              variant="tertiary"
            >
              {t('back')}
            </Button>
          ) : null}
          <Button type="button" onClick={onClose} variant="tertiary">
            {t('cancel')}
          </Button>
          {plan ? (
            <Button
              variant="primary"
              size="compact"
              type="button"
              disabled={!preview || busy || unresolved}
              onClick={() => void open()}
            >
              {t('open')}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function PlanEditor({
  plan,
  wording,
  onChange,
}: {
  plan: TeamPlan;
  wording: TeamWording;
  onChange(plan: TeamPlan): void;
}) {
  const t = useTranslations('TeamDraft');
  const messages = useMessages();
  const id = useId();
  // The raw text, so a new empty line can be typed; the plan keeps the non-empty lines.
  const [criteria, setCriteria] = useState(plan.criteria.join('\n'));
  // Criteria typed since the suggestion survive a pattern change; a new suggestion mounts a
  // new editor, and criteria from a model answer count as not typed.
  const [criteriaEdited, setCriteriaEdited] = useState(false);
  const changePattern = (pattern: TeamPattern) => {
    const next = planWithPattern(plan, pattern, wording, { keepCriteria: criteriaEdited });
    if (!criteriaEdited) setCriteria(next.criteria.join('\n'));
    onChange(next);
  };
  const ordered = TEAM_SLOTS[plan.pattern].map((slot) => plan.roles.find((r) => r.slot === slot));
  const setRole = (index: number, patch: { name?: string; duty?: string }) =>
    onChange({
      ...plan,
      roles: plan.roles.map((role) =>
        role.slot === ordered[index]?.slot ? { ...role, ...patch } : role,
      ),
    });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-body">
        <span aria-hidden="true">{t('patternLabel')}</span>
        <Select<TeamPattern>
          label={t('patternLabel')}
          value={plan.pattern}
          onValueChange={changePattern}
          options={TEAM_PATTERNS.map((pattern) => ({
            value: pattern,
            label: patternName(messages, pattern),
          }))}
          className="w-full"
        />
      </div>
      <label htmlFor={`${id}-name`} className="flex flex-col gap-1 text-body">
        {t('nameLabel')}
        <Input
          id={`${id}-name`}
          value={plan.name}
          maxLength={80}
          onChange={(e) => onChange({ ...plan, name: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-brief`} className="flex flex-col gap-1 text-body">
        {t('briefLabel')}
        <Textarea
          id={`${id}-brief`}
          value={plan.brief}
          rows={3}
          maxLength={2000}
          onChange={(e) => onChange({ ...plan, brief: e.target.value })}
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('rolesLabel')}
        </legend>
        {ordered.map((role, index) =>
          role ? (
            <div key={role.slot} className="flex flex-col gap-1 rounded fill-group p-2">
              <label htmlFor={`${id}-name-${index}`} className="sr-only">
                {t('roleName', { n: index + 1 })}
              </label>
              <Input
                id={`${id}-name-${index}`}
                value={role.name}
                maxLength={40}
                onChange={(e) => setRole(index, { name: e.target.value })}
                style={{ fontVariationSettings: fontWeights.semibold }}
              />
              <label htmlFor={`${id}-duty-${index}`} className="sr-only">
                {t('roleDuty', { n: index + 1 })}
              </label>
              <Textarea
                id={`${id}-duty-${index}`}
                value={role.duty}
                rows={2}
                maxLength={400}
                onChange={(e) => setRole(index, { duty: e.target.value })}
              />
            </div>
          ) : null,
        )}
      </fieldset>
      <label htmlFor={`${id}-criteria`} className="flex flex-col gap-1 text-body">
        {t('criteriaLabel')}
        <Textarea
          id={`${id}-criteria`}
          value={criteria}
          rows={3}
          onChange={(e) => {
            setCriteria(e.target.value);
            setCriteriaEdited(true);
            onChange({
              ...plan,
              criteria: e.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            });
          }}
        />
      </label>
      <div className="flex flex-wrap items-center gap-4 text-body">
        {hasReviewLoop(plan.pattern) ? (
          <div className="flex items-center gap-2">
            <span>{t('rounds')}</span>
            <Select
              label={t('rounds')}
              value={String(plan.reviewRounds ?? 2)}
              onValueChange={(value) => onChange({ ...plan, reviewRounds: Number(value) })}
              options={[1, 2, 3].map((value) => ({ value: String(value), label: String(value) }))}
            />
          </div>
        ) : null}
        <Switch
          label={t('approval')}
          checked={plan.finalApproval}
          onToggle={() => onChange({ ...plan, finalApproval: !plan.finalApproval })}
        />
      </div>
    </div>
  );
}
