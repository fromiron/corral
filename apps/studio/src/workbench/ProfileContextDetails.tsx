import type { ProfileContextPolicy } from '@corral/contracts';
import { useTranslations } from 'use-intl';

export function ProfileContextDetails({
  policy,
  runtime,
}: {
  policy: ProfileContextPolicy | null | undefined;
  runtime?: 'pi-sdk' | 'pi-core' | 'mock';
}) {
  const t = useTranslations('ProfileContext');
  if (!policy) return <p className="text-xs text-muted">{t('unknown')}</p>;
  const fields = ['contextWindow', 'reserveTokens', 'keepRecentTokens'] as const;
  return (
    <div className="space-y-1 text-xs">
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        {fields.map((key) => (
          <div key={key}>
            <dt className="text-muted">{t(key)}</dt>
            <dd>
              {policy[key].toLocaleString()} · {t(`source.${policy.sources[key]}`)}
            </dd>
          </div>
        ))}
      </dl>
      <p>{t('threshold', { value: policy.contextWindow - policy.reserveTokens })}</p>
      <p className="text-muted">
        {t(
          runtime === 'pi-core'
            ? 'legacy'
            : runtime === 'mock'
              ? 'mock'
              : runtime === 'pi-sdk'
                ? 'sdk'
                : 'hint',
        )}
      </p>
      {policy.baseContextWindow !== null ? (
        <p className="text-muted">
          {t('base', { value: policy.baseContextWindow, source: t(`source.${policy.baseSource}`) })}
        </p>
      ) : null}
      {policy.warnings.map((warning) => (
        <p key={warning} className="text-warning">
          {t(`warning.${warning}`)}
        </p>
      ))}
      <p className="text-muted">
        {t('revision')} · <code>{policy.configRevision.slice(0, 12)}</code>
      </p>
    </div>
  );
}
