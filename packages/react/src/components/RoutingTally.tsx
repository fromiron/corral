import type { RoutingFallbackReason } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { KitCard, KitCardContent, KitCardHeader, KitCardTitle } from '../design-kit/index.ts';

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
    <KitCard role="region" aria-labelledby={heading}>
      <KitCardHeader>
        <h3 id={heading}>
          <KitCardTitle>{t('tally.heading')}</KitCardTitle>
        </h3>
      </KitCardHeader>
      <KitCardContent>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
          <dt>{t('tally.judged')}</dt>
          <dd>{judged.length}</dd>
          <dt>{t('tally.applied')}</dt>
          <dd>{applied}</dd>
          {byCount.map(([reason, count]) => (
            <Row
              key={reason}
              label={`${t('tally.fallback')} · ${t(`route.reason.${reason}`)}`}
              value={count}
            />
          ))}
        </dl>
      </KitCardContent>
    </KitCard>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
