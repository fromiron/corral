import { TEAM_SLOTS, TeamPlan } from '@corral/contracts';
import { draftFromPlan, planFromGoal, type TeamWording } from '@corral/react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useMessages, useTranslations } from 'use-intl';
import { Modal } from './CommandPalette.tsx';
import { useServices } from './services.tsx';

/**
 * Goal → team draft (CR-006). The person writes a goal, gets a plan from the local suggestion or
 * one model request, edits it, and only "Open in editor" saves it. Tools and wiring come from
 * the pattern (draftFromPlan), never from the plan's text.
 */
export function TeamDraftDialog({
  onClose,
  projectId,
}: {
  onClose: () => void;
  /** The project the drafted Corral is saved in (CR-010). */
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
    try {
      setPlan((await models.draftTeam(goal.trim())).plan);
    } catch (failure) {
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
            <textarea
              id={goalId}
              ref={goalRef}
              value={goal}
              maxLength={2000}
              rows={4}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t('goalPlaceholder')}
              className="rounded border border-line bg-surface px-2 py-1 text-sm"
            />
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  disabled={!goal.trim() || busy}
                  onClick={suggest}
                  className="self-start rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
                >
                  {t('suggest')}
                </button>
                <span className="text-xs text-muted">{t('suggestHint')}</span>
              </div>
              {live && models ? (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    disabled={!goal.trim() || busy}
                    onClick={() => void ask()}
                    className="self-start rounded-md border border-accent px-3 py-1.5 text-sm text-accent disabled:opacity-50"
                  >
                    {busy ? t('asking') : t('ask')}
                  </button>
                  <span className="text-xs text-muted">{t('askHint')}</span>
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
            <button
              type="button"
              onClick={() => setPlan(null)}
              className="rounded border border-line px-3 py-1.5 text-sm"
            >
              {t('back')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line px-3 py-1.5 text-sm"
          >
            {t('cancel')}
          </button>
          {plan ? (
            <button
              type="button"
              disabled={!checked?.success || busy}
              onClick={() => void open()}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
            >
              {t('open')}
            </button>
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
  const field = 'rounded border border-line bg-surface px-2 py-1 text-sm';
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
      <label className="flex flex-col gap-1 text-sm">
        {t('nameLabel')}
        <input
          value={plan.name}
          maxLength={80}
          onChange={(e) => onChange({ ...plan, name: e.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('briefLabel')}
        <textarea
          value={plan.brief}
          rows={3}
          maxLength={2000}
          onChange={(e) => onChange({ ...plan, brief: e.target.value })}
          className={field}
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('rolesLabel')}</legend>
        {ordered.map((role, index) =>
          role ? (
            <div key={role.slot} className="flex flex-col gap-1 rounded border border-line p-2">
              <label htmlFor={`${id}-name-${index}`} className="sr-only">
                {t('roleName', { n: index + 1 })}
              </label>
              <input
                id={`${id}-name-${index}`}
                value={role.name}
                maxLength={40}
                onChange={(e) => setRole(index, { name: e.target.value })}
                className={`${field} font-medium`}
              />
              <label htmlFor={`${id}-duty-${index}`} className="sr-only">
                {t('roleDuty', { n: index + 1 })}
              </label>
              <textarea
                id={`${id}-duty-${index}`}
                value={role.duty}
                rows={2}
                maxLength={400}
                onChange={(e) => setRole(index, { duty: e.target.value })}
                className={field}
              />
            </div>
          ) : null,
        )}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        {t('criteriaLabel')}
        <textarea
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
          className={field}
        />
      </label>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {plan.pattern !== 'single' ? (
          <label className="flex items-center gap-2">
            {t('rounds')}
            <select
              value={plan.reviewRounds ?? 2}
              onChange={(e) => onChange({ ...plan, reviewRounds: Number(e.target.value) })}
              className={field}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={plan.finalApproval}
            onChange={(e) => onChange({ ...plan, finalApproval: e.target.checked })}
          />
          {t('approval')}
        </label>
      </div>
    </div>
  );
}
