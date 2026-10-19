import { WorkPlan } from '@corral/contracts';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { Button } from '../ui/button.tsx';

export function WorkPlanPanel({ session }: { session: RunSessionStore }) {
  const t = useTranslations('WorkPlan');
  const projection = useStore(session, (s) => s.projection);
  const bodies = useStore(session, (s) => s.artifactTexts);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const plans = Object.values(projection?.workPlans ?? {});
  const refs = plans.map((plan) => plan.bodyRef).join(',');
  useEffect(() => {
    void retry;
    let current = true;
    setFailed(false);
    void Promise.all(
      refs
        .split(',')
        .filter(Boolean)
        .map((ref) => session.getState().loadArtifact(ref)),
    ).catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [session, refs, retry]);
  if (!plans.length) return null;
  return (
    <section aria-label={t('heading')} className="flex flex-col gap-2">
      {plans.map((view) => {
        let plan: WorkPlan | null = null;
        const text = bodies[view.bodyRef];
        try {
          const parsed = WorkPlan.parse(JSON.parse(text ?? 'null'));
          if (
            parsed.revision === view.revision &&
            parsed.executionId === view.executionId &&
            parsed.attemptNo === view.attemptNo &&
            parsed.criteriaVersionId === view.criteriaVersionId
          )
            plan = parsed;
        } catch {
          /* Unavailable plans cannot show completion. */
        }
        return (
          <details
            key={view.scope === 'team' ? 'team' : view.executionId}
            open
            className="rounded-lg border border-line p-3 text-sm"
          >
            <summary className="cursor-pointer font-medium">
              {t('heading')} · {t(view.scope)} · {view.executionId} · v{view.revision}
            </summary>
            {plan ? (
              <>
                <p className="my-2 text-xs text-muted">{t('scopeHint')}</p>
                {view.criteriaVersionId !== projection?.currentCriteriaVersionId ? (
                  <p role="status" className="text-warning">
                    {t('staleCriteria')}
                  </p>
                ) : null}
                <ol className="flex flex-col gap-2">
                  {plan.items.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-start gap-2">
                      <span className={item.status === 'completed' ? 'text-muted' : 'font-medium'}>
                        {t(item.status)}
                      </span>
                      <span className="min-w-0 flex-1 break-words">{item.title}</span>
                      {item.requiresVerification ? (
                        <span className="text-xs text-muted">{t('verification')}</span>
                      ) : null}
                      {item.evidenceRefs?.length ? (
                        <details className="w-full text-xs">
                          <summary className="cursor-pointer">
                            {t('evidence', { count: item.evidenceRefs.length })}
                          </summary>
                          {item.evidenceRefs.map((ref) => (
                            <div key={ref} className="mt-1">
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                onClick={() =>
                                  void session
                                    .getState()
                                    .loadArtifact(ref)
                                    .catch(() => setFailed(true))
                                }
                              >
                                {ref}
                              </Button>
                              {bodies[ref] ? (
                                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all">
                                  {bodies[ref]}
                                </pre>
                              ) : null}
                            </div>
                          ))}
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p role="status">{t(failed || text !== undefined ? 'unavailable' : 'loading')}</p>
            )}
            {!plan ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRetry((n) => n + 1)}
              >
                {t('retry')}
              </Button>
            ) : null}
          </details>
        );
      })}
      {failed ? (
        <p role="alert" className="text-xs text-danger">
          {t('unavailable')}
        </p>
      ) : null}
    </section>
  );
}
