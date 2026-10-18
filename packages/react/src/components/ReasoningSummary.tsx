import type { ModelCallView } from '@corral/core';
import { useTranslations } from 'use-intl';

export function ReasoningSummary({
  call,
}: {
  call: Pick<ModelCallView, 'reasoning' | 'reasoningWire'>;
}) {
  const t = useTranslations('Reasoning');
  const resolution = call.reasoning;
  if (!resolution) return <span className="text-muted">{t('unrecorded')}</span>;
  const requested =
    resolution.requested.mode === 'fixed'
      ? resolution.requested.level
      : t(resolution.requested.mode);
  return (
    <span
      data-testid="reasoning-summary"
      className="text-xs text-muted"
      title={[resolution.preparationId, resolution.judgeVersion, resolution.inputHash]
        .filter(Boolean)
        .join(' · ')}
    >
      {t('label')}: {requested} → {resolution.resolved ?? t('provider_default')}
      {' · '}
      {t(`source.${resolution.source}`)}
      {resolution.judged && resolution.judged !== resolution.resolved
        ? ` (${resolution.judged} → ${resolution.resolved})`
        : ''}
      {resolution.kind ? ` · ${t(`kind.${resolution.kind}`)}` : ''}
      {resolution.fallback ? ` (${t(`fallback.${resolution.fallback}`)})` : ''}
      {' · '}
      {t('payload')}:{' '}
      {call.reasoningWire ? (call.reasoningWire.value ?? t('omitted')) : t('unverified')}
    </span>
  );
}
