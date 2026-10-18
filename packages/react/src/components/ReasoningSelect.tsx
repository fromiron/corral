import {
  type ReasoningCapabilities,
  ReasoningLevel,
  type ReasoningPolicy,
} from '@corral/contracts';
import { useTranslations } from 'use-intl';
import { Select } from '../ui/select.tsx';

export function ReasoningSelect({
  value,
  capabilities,
  onChange,
  inherit = false,
}: {
  value?: ReasoningPolicy | null;
  capabilities?: ReasoningCapabilities | undefined;
  onChange: (policy: ReasoningPolicy | null) => void;
  inherit?: boolean;
}) {
  const t = useTranslations('Reasoning');
  const selected = value?.mode === 'fixed' ? value.level : (value?.mode ?? '');
  const levels = capabilities?.levels ?? ReasoningLevel.options;
  const unsupported = value?.mode === 'fixed' && !levels.includes(value.level);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{t('label')}</span>
      <Select
        label={t('label')}
        value={selected}
        onValueChange={(choice) => {
          onChange(
            !choice
              ? null
              : choice === 'auto' || choice === 'provider_default'
                ? { mode: choice }
                : { mode: 'fixed', level: ReasoningLevel.parse(choice) },
          );
        }}
        options={[
          { value: '', label: t(inherit ? 'inherit' : 'legacy') },
          {
            value: 'provider_default',
            label: t('provider_default'),
            disabled: capabilities?.providerDefault === false,
          },
          {
            value: 'auto',
            label: t('auto'),
            disabled: Boolean(capabilities && !levels.includes('medium')),
          },
          ...(unsupported
            ? [{ value: value.level, label: `${value.level} (${t('unsupported')})` }]
            : []),
          ...levels.map((level) => ({ value: level, label: t(`level.${level}`) })),
        ]}
      />
      {value?.mode === 'auto' ? (
        <a className="text-muted underline" href="/settings/models">
          {t('autoHint')}
        </a>
      ) : null}
      {unsupported ? (
        <p role="alert" className="text-warning">
          {t('unsupportedHint')}
        </p>
      ) : null}
    </div>
  );
}
