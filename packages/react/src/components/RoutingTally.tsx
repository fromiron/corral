import type { RoutingFallbackReason } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { useId } from 'react';
import { useTranslations } from 'use-intl';

/** A run's judged requests, how many took the recommendation, and its fallbacks by reason. */
export function RoutingTally({ projection }: { projection: RunProjection }) {
  const t = useTranslations('Reasoning');
  const heading = useId();
  // A retry that reused a settled result is the same judgment, counted once.
  const judged = Object.values(projection.modelCalls).filter(
    (call) => call.reasoning?.route?.application === 'active' && call.reasoning.source !== 'reused',
  );
  if (!judged.length) return null;
  const applied = judged.filter((call) => call.reasoning?.source === 'router').length;
  const fallbacks = new Map<RoutingFallbackReason, number>();
  for (const call of judged) {
    const reason = call.reasoning?.route?.fallback?.reason;
    if (reason) fallbacks.set(reason, (fallbacks.get(reason) ?? 0) + 1);
  }
  const byCount = [...fallbacks].sort((a, b) => b[1] - a[1]);
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1 text-sm">
      <h3 id={heading} className="font-semibold">
        {t('tally.heading')}
      </h3>
      <p>
        {t('tally.judged', { count: judged.length })} · {t('tally.applied', { count: applied })}
      </p>
      {byCount.length ? (
        <>
          <h4 className="text-xs text-muted-foreground">{t('tally.fallbacks')}</h4>
          <ul className="flex flex-col gap-0.5 text-xs">
            {byCount.map(([reason, count]) => (
              <li key={reason}>
                {t(`route.reason.${reason}`)}: {count}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
