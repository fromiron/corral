import type { RunProjection } from '@corral/core';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { ReasoningSummary } from './ReasoningSummary.tsx';

type Decision = RunProjection['decisions'][string];
const LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

/**
 * reasoning_effort judgments of a run, request by request (CR-003, C-071). They are
 * observations: the panel says so and never presents one as applied. Failures read as plainly
 * as answers (Spec §4.4).
 */
export function EffortJudgments({ session }: { session: RunSessionStore }) {
  const t = useTranslations('Judgments');
  const tr = useTranslations('Reasoning');
  const headingId = useId();
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const settings = projection?.decisionSettings?.reasoning_effort;
  if (!projection) return null;
  const applied = Object.values(projection.modelCalls).filter((call) => call.reasoning);
  if (!settings && !applied.length) return null;
  const labelOf = (executionId: string) => {
    const nodeId = projection.executions[executionId]?.nodeId;
    return definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId ?? executionId;
  };
  // Requests in the order their judgments were committed: the run's own chronology.
  const byCall = new Map<string, Decision[]>();
  for (const d of Object.values(projection.decisions ?? {})) {
    byCall.set(d.modelCallId, [...(byCall.get(d.modelCallId) ?? []), d]);
  }
  const calls = [...byCall.keys()];
  const unavailable = settings?.providers.filter((p) => !p.available) ?? [];
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded fill-group p-2 text-xs"
    >
      <h3 id={headingId} className="font-semibold">
        {t('heading')}
      </h3>
      {applied.length ? (
        <details open>
          <summary className="font-medium">{tr('appliedHeading')}</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {applied.map((call) => (
              <li key={call.modelCallId} className="flex flex-col">
                <span>
                  {labelOf(call.executionId)} · {call.modelCallId}
                </span>
                <ReasoningSummary call={call} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {applied.length ? <h4 className="font-medium">{tr('observeHeading')}</h4> : null}
      {settings?.mode !== 'observe' ? (
        <p className="text-muted-foreground">{t('off')}</p>
      ) : (
        <>
          <p className="text-muted-foreground">{t('observeOnly')}</p>
          {unavailable.map((p) => (
            <p key={p.id} className="text-warning">
              {p.id}: {p.reason}
            </p>
          ))}
          {calls.length === 0 ? <p className="text-muted-foreground">{t('none')}</p> : null}
          <ul className="flex flex-col gap-1">
            {calls.map((call) => {
              const decisions = byCall.get(call) ?? [];
              const executionId = decisions[0]?.executionId ?? '';
              return (
                <li
                  key={call}
                  data-testid={`judgment-${call}`}
                  className="flex flex-col gap-1 rounded fill-group p-1.5"
                >
                  <span>
                    <span className="font-medium">{labelOf(executionId)}</span>{' '}
                    <span className="font-mono text-muted-foreground">{call}</span>
                  </span>
                  {decisions.map((d) => (
                    <Judgment key={d.decisionId} decision={d} />
                  ))}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function Judgment({ decision: d }: { decision: Decision }) {
  const t = useTranslations('Judgments');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-mono">{d.provider}</span>
      {d.status === 'observed' && d.answer ? (
        <span className="rounded fill-control px-1 font-medium" data-level={d.answer}>
          {t(`level.${d.answer}`)}
        </span>
      ) : null}
      {d.status === 'failed' ? (
        <span className="text-danger">
          {t('failed', { reason: t(`reason.${d.reason ?? 'provider_error'}`) })}
        </span>
      ) : null}
      {d.status === 'requested' ? (
        <span className="text-muted-foreground">{t('pending')}</span>
      ) : null}
      {d.status === 'not_collected' ? (
        <span className="text-muted-foreground">{t('notCollected')}</span>
      ) : null}
      {d.probabilities ? (
        <span className="text-muted-foreground">
          <span className="sr-only">{t('probabilities')}: </span>
          {LEVELS.map(
            (level) =>
              `${t(`level.${level}`)} ${Math.round((d.probabilities?.[level] ?? 0) * 100)}%`,
          ).join(' · ')}
        </span>
      ) : null}
      {d.evidenceLevel === 'rule' ? (
        <span className="text-muted-foreground">({t('rule')})</span>
      ) : null}
      {d.latencyMs !== null ? (
        <span className="text-muted-foreground">{t('latency', { ms: d.latencyMs })}</span>
      ) : null}
      {d.afterRequestFinished ? <span className="text-muted-foreground">{t('late')}</span> : null}
    </div>
  );
}
