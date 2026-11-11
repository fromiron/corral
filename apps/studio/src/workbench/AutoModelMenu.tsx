import type { AutoModelChoice } from '@corral/contracts';
import { profileChoices } from '@corral/react';
import { type ModelOption, ModelPicker, type ModelPickerChoice } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { reasoningFrom, reasoningValue } from './autoChoice.ts';
import type { ProfileInfo } from './useModels.ts';

export function AutoModelMenu({
  value,
  profiles,
  showReasoning,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  value: AutoModelChoice;
  profiles: ProfileInfo[];
  showReasoning: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: AutoModelChoice) => void;
}) {
  const t = useTranslations('Sessions'),
    tq = useTranslations('Reasoning'),
    tc = useTranslations('Composer');
  const profile = profiles.find((p) => p.profileId === value.modelProfile);
  const effort =
    value.reasoning?.mode === 'fixed'
      ? tq(`level.${value.reasoning.level}`)
      : value.reasoning?.mode === 'route'
        ? t('reasoningRoute')
        : tq(value.reasoning?.mode ?? 'legacy');
  const visibleEffort = showReasoning && value.reasoning ? effort : null;
  const fixedLevel = value.reasoning?.mode === 'fixed' ? value.reasoning.level : null;
  const description = [tc('nextRequest'), profile?.label ?? value.modelProfile, visibleEffort]
    .filter(Boolean)
    .join(' · ');
  const levels: ModelPickerChoice[] = (profile?.reasoningCapabilities?.levels ?? []).map(
    (level) => ({
      value: level,
      label: tq(`level.${level}`),
    }),
  );
  if (fixedLevel !== null && !levels.some((option) => option.value === fixedLevel))
    levels.push({
      value: fixedLevel,
      label: `${effort} · ${tc('unsupportedReasoning')}`,
      disabled: true,
    });
  const options: ModelPickerChoice[] = [
    { value: '', label: tq('legacy'), shortLabel: tc('modelPicker.policyDefault') },
    {
      value: 'provider_default',
      label: tq('provider_default'),
      disabled: !profile?.reasoningCapabilities?.providerDefault,
    },
    ...levels,
    {
      value: 'auto',
      label: tq('auto'),
      shortLabel: tc('modelPicker.policyAuto'),
      // Automatic falls back to the provider default, so it needs a verified one.
      disabled: !profile?.reasoningCapabilities?.providerDefault,
    },
    {
      value: 'route',
      label: t('reasoningRoute'),
      shortLabel: tc('modelPicker.policyRoute'),
      disabled: !profile?.reasoningCapabilities?.levels.includes('medium'),
    },
  ];
  const requested = reasoningValue(value.reasoning);
  // Named profiles first, then one group per connected provider (features/model-connections.md).
  const models: ModelOption[] = profileChoices(profiles, {
    profiles: tc('modelPicker.profiles'),
    unavailable: tc('modelPicker.unavailable'),
  });
  if (!profile)
    models.unshift({
      id: value.modelProfile,
      name: value.modelProfile,
      description: tc('modelPicker.missing'),
      disabled: true,
    });

  return (
    <ModelPicker
      models={models}
      value={value.modelProfile}
      onValueChange={(modelProfile) => {
        if (!disabled) onChange({ ...value, modelProfile });
      }}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
      side="top"
      align="end"
      triggerDescription={description}
      labels={{
        model: t('autoModel'),
        settings: tc('modelPicker.settings'),
        trigger: () => t('autoModel'),
        empty: tc('modelPicker.empty'),
      }}
      footerText={tc('nextRequest')}
      search={{
        label: tc('modelPicker.search'),
        noMatch: (query) => tc('modelPicker.noMatch', { query }),
      }}
      reasoning={
        showReasoning
          ? {
              label: tc('modelPicker.reasoning'),
              ariaLabel: tq('label'),
              value: requested,
              options,
              onValueChange: (next) => {
                if (
                  disabled ||
                  !options.some((option) => option.value === next && !option.disabled)
                )
                  return;
                const reasoning = reasoningFrom(next);
                onChange({ modelProfile: value.modelProfile, ...(reasoning ? { reasoning } : {}) });
              },
              ...(value.reasoning?.mode === 'fixed'
                ? {
                    effort: {
                      label: tc('modelPicker.effort'),
                      value: value.reasoning.level,
                      options: levels,
                    },
                  }
                : {}),
            }
          : null
      }
    />
  );
}
