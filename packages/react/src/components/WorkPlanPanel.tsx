import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button } from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { useWorkPlanSnapshot, type WorkPlanRef } from '../run/work-plan-snapshot.ts';

export function WorkPlanPanel({ session }: { session: RunSessionStore }) {
  const t = useTranslations('WorkPlan');
  const plans = useStore(session, (s) => s.projection?.workPlans);
  if (!plans || !Object.keys(plans).length) return null;
  return (
    <section aria-label={t('heading')} className="flex flex-col gap-2">
      {Object.values(plans).map((view) => (
        <WorkPlanDetails
          key={view.scope === 'team' ? 'team' : view.executionId}
          session={session}
          view={view}
        />
      ))}
    </section>
  );
}

function WorkPlanDetails({ session, view }: { session: RunSessionStore; view: WorkPlanRef }) {
  const t = useTranslations('WorkPlan');
  const runId = useStore(session, (s) => s.runId);
  const projection = useStore(session, (s) => s.projection);
  const bodies = useStore(session, (s) => s.artifactTexts);
  const [failedEvidence, setFailedEvidence] = useState<string | null>(null);
  const { status, retry } = useWorkPlanSnapshot({
    runId,
    ref: view,
    currentCriteriaVersionId: projection?.currentCriteriaVersionId,
    currentAttemptNo: projection?.executions[view.executionId]?.attemptNo,
    runStatus: projection?.status,
    cacheScope: session,
    text: bodies[view.bodyRef],
    load: async (bodyRef, options) => {
      if (session.getState().runId !== runId) return null;
      await session.getState().loadArtifact(bodyRef, options);
      return session.getState().runId === runId
        ? (session.getState().artifactTexts[bodyRef] ?? null)
        : null;
    },
  });
  const plan = 'plan' in status ? status.plan : null;
  return (
    <details open className="rounded-lg fill-group p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        {t('heading')} · {t(view.scope)} · {view.executionId} · v{view.revision}
      </summary>
      {plan ? (
        <>
          <p className="my-2 text-xs text-muted-foreground">{t('scopeHint')}</p>
          {status.state === 'stale-criteria' || status.state === 'stale-attempt' ? (
            <p role="status" className="text-warning">
              {t(status.state === 'stale-attempt' ? 'staleAttempt' : 'staleCriteria')}
            </p>
          ) : null}
          <ol className="flex flex-col gap-2">
            {plan.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start gap-2">
                <span
                  className={item.status === 'completed' ? 'text-muted-foreground' : 'font-medium'}
                >
                  {t(item.status)}
                </span>
                <span className="min-w-0 flex-1 break-words">{item.title}</span>
                {item.requiresVerification ? (
                  <span className="text-xs text-muted-foreground">{t('verification')}</span>
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
                          size="compact"
                          variant="ghost"
                          onClick={() => {
                            setFailedEvidence(null);
                            void session
                              .getState()
                              .loadArtifact(ref)
                              .then(() => {
                                if (
                                  session.getState().runId === runId &&
                                  session.getState().artifactTexts[ref] === undefined
                                ) {
                                  setFailedEvidence(ref);
                                }
                              })
                              .catch(() => {
                                if (session.getState().runId === runId) setFailedEvidence(ref);
                              });
                          }}
                        >
                          {ref}
                        </Button>
                        {bodies[ref] ? (
                          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all">
                            {bodies[ref]}
                          </pre>
                        ) : null}
                        {failedEvidence === ref ? (
                          <p role="alert" className="text-xs text-danger">
                            {t('unavailable')}
                          </p>
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
        <p role="status">{t(status.state === 'loading' ? 'loading' : 'unavailable')}</p>
      )}
      {status.state === 'error' || status.state === 'mismatch' ? (
        <Button type="button" variant="tertiary" size="compact" onClick={retry}>
          {t('retry')}
        </Button>
      ) : null}
    </details>
  );
}
