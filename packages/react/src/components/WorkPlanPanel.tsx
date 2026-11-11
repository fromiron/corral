import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, fontWeights } from '../design-kit/index.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore } from '../run/session.ts';
import { useWorkPlanSnapshot, type WorkPlanRef } from '../run/work-plan-snapshot.ts';

export function WorkPlanPanel({ session }: { session: RunSessionStore }) {
  const t = useTranslations('WorkPlan');
  const plans = useRunDisplay(session, (s) => s.projection?.workPlans);
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
  const bodies = useStore(session, (s) => s.artifactTexts);
  const [failedEvidence, setFailedEvidence] = useState<string | null>(null);
  const { status, retry } = useRunWorkPlan(session, view);
  const plan = 'plan' in status ? status.plan : null;
  // A plan is named by the agent that wrote it, never by its execution identifier.
  const nodeId = useRunDisplay(session, (s) => s.projection?.executions[view.executionId]?.nodeId);
  const label = useStore(session, (s) => s.definition?.nodes.find((n) => n.id === nodeId)?.label);
  const owner = view.scope === 'team' ? t('team') : (label ?? nodeId ?? t('execution'));
  return (
    <details open className="rounded-lg fill-group p-3 text-body">
      <summary className="cursor-pointer" style={{ fontVariationSettings: fontWeights.semibold }}>
        {owner} · v{view.revision}
      </summary>
      {plan ? (
        <>
          {status.state === 'stale-criteria' || status.state === 'stale-attempt' ? (
            <p role="status" className="mt-2 text-warning">
              {t(status.state === 'stale-attempt' ? 'staleAttempt' : 'staleCriteria')}
            </p>
          ) : null}
          <ol className="mt-2 flex flex-col gap-2">
            {plan.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start gap-2">
                <span
                  className={item.status === 'completed' ? 'text-muted-foreground' : undefined}
                  style={
                    item.status === 'completed'
                      ? undefined
                      : { fontVariationSettings: fontWeights.semibold }
                  }
                >
                  {t(item.status)}
                </span>
                <span className="min-w-0 flex-1 break-words">{item.title}</span>
                {item.requiresVerification ? (
                  <span className="text-caption text-muted-foreground">{t('verification')}</span>
                ) : null}
                {item.evidenceRefs?.length ? (
                  <details className="w-full text-caption">
                    <summary className="cursor-pointer">
                      {t('evidence', { count: item.evidenceRefs.length })}
                    </summary>
                    {item.evidenceRefs.map((ref) => (
                      <div key={ref} className="mt-1">
                        <Button
                          type="button"
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
                          <p role="alert" className="text-caption text-danger">
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
        <Button type="button" variant="tertiary" onClick={retry}>
          {t('retry')}
        </Button>
      ) : null}
    </details>
  );
}

/** The plan a run shows first: the team plan, else the most recently recorded execution plan. */
export function primaryWorkPlan(
  plans: Record<string, WorkPlanRef> | undefined,
): WorkPlanRef | null {
  const all = Object.values(plans ?? {});
  return all.find((plan) => plan.scope === 'team') ?? all.at(-1) ?? null;
}

/** Reads and verifies one recorded work plan of the session's run, as the plan panel does. */
export function useRunWorkPlan(session: RunSessionStore, view: WorkPlanRef | null) {
  const runId = useStore(session, (s) => s.runId);
  const projection = useRunDisplay(session, (s) => s.projection);
  const bodies = useStore(session, (s) => s.artifactTexts);
  return useWorkPlanSnapshot({
    runId,
    ref: view,
    currentCriteriaVersionId: projection?.currentCriteriaVersionId,
    currentAttemptNo: view ? projection?.executions[view.executionId]?.attemptNo : undefined,
    runStatus: projection?.status,
    cacheScope: session,
    text: view ? bodies[view.bodyRef] : undefined,
    load: async (bodyRef, options) => {
      if (session.getState().runId !== runId) return null;
      await session.getState().loadArtifact(bodyRef, options);
      return session.getState().runId === runId
        ? (session.getState().artifactTexts[bodyRef] ?? null)
        : null;
    },
  });
}
