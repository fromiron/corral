import { ApiError } from '@corral/client';
import { TEAM_SLOTS, TeamPlan } from '@corral/contracts';
import { draftFromPlan, planFromGoal, type TeamWording } from '@corral/react';
import { Button, Input, Select, Switch, Textarea } from '@corral/react/design-kit';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useMessages, useTranslations } from 'use-intl';
import { Modal } from './CommandPalette.tsx';
import { useServices } from './services.tsx';

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
  const messages = useMessages() as { TeamDraft: { wording: TeamWording } };
  const { repository, models, live } = useServices();
  const navigate = useNavigate();
  const [goal, setGoal] = useState('');
  const [plan, setPlan] = useState<TeamPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setPlan(planFromGoal(goal, messages.TeamDraft.wording));
  };
  const ask = async () => {
    if (!models) return;
    setBusy(true);
    setError(null);
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
      if (!controller.signal.aborted) setPlan(result.plan);
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        ['MODEL_UNAVAILABLE', 'CAPABILITY_DENIED'].includes(failure.code)
      )
        draftIntent.current = null;
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const checked = plan ? TeamPlan.safeParse(plan) : null;
  const open = async () => {
    if (!checked?.success) return;
    setBusy(true);
    const draft = draftFromPlan(
      checked.data,
      `team_${globalThis.crypto.randomUUID().slice(0, 8)}`,
      messages.TeamDraft.wording.labels,
    );
    const saved = await repository.save({
      ...draft,
      expectedDefinitionRevision: null,
      ...(projectId ? { projectId } : {}),
    });
    setBusy(false);
    if (!saved.ok) return setError(saved.message);
    onClose();
    await navigate({ to: '/corrals/$corralId/edit', params: { corralId: saved.record.corralId } });
  };

  return (
    <Modal label={t('title')} onClose={onClose}>
      <div className="flex max-h-[76vh] flex-col gap-3 overflow-y-auto p-4">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        {!plan ? (
          <>
            <label htmlFor={goalId} className="text-sm font-medium">
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
                setGoal(e.target.value);
              }}
              placeholder={t('goalPlaceholder')}
            />
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex flex-col gap-1">
                <Button
                  variant="primary"
                  size="compact"
                  type="button"
                  disabled={!goal.trim() || busy}
                  onClick={suggest}
                  className="self-start"
                >
                  {t('suggest')}
                </Button>
                <span className="text-xs text-muted-foreground">{t('suggestHint')}</span>
              </div>
              {live && models ? (
                <div className="flex flex-col gap-1">
                  <Button
                    variant="tertiary"
                    size="compact"
                    type="button"
                    disabled={!goal.trim() || busy}
                    onClick={() => void ask()}
                    className="self-start"
                  >
                    {busy ? t('asking') : t('ask')}
                  </Button>
                  <span className="text-xs text-muted-foreground">{t('askHint')}</span>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <PlanEditor plan={plan} onChange={setPlan} />
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {checked && !checked.success ? <p className="text-xs text-danger">{t('invalid')}</p> : null}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          {plan ? (
            <Button
              type="button"
              onClick={() => {
                draftIntent.current = null;
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
              disabled={!checked?.success || busy}
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

function PlanEditor({ plan, onChange }: { plan: TeamPlan; onChange(plan: TeamPlan): void }) {
  const t = useTranslations('TeamDraft');
  const id = useId();
  // The raw text, so a new empty line can be typed; the plan keeps the non-empty lines.
  const [criteria, setCriteria] = useState(plan.criteria.join('\n'));
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
      <p className="text-sm">
        <span className="rounded bg-surface px-2 py-0.5 font-medium">
          {t(`patterns.${plan.pattern}`)}
        </span>
      </p>
      <label htmlFor={`${id}-name`} className="flex flex-col gap-1 text-sm">
        {t('nameLabel')}
        <Input
          id={`${id}-name`}
          value={plan.name}
          maxLength={80}
          onChange={(e) => onChange({ ...plan, name: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-brief`} className="flex flex-col gap-1 text-sm">
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
        <legend className="text-sm font-medium">{t('rolesLabel')}</legend>
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
                className="font-medium"
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
      <label htmlFor={`${id}-criteria`} className="flex flex-col gap-1 text-sm">
        {t('criteriaLabel')}
        <Textarea
          id={`${id}-criteria`}
          value={criteria}
          rows={3}
          onChange={(e) => {
            setCriteria(e.target.value);
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
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {plan.pattern !== 'single' ? (
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
