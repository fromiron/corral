import type { AutoModelChoice } from '@corral/contracts';
import { ChevronDown } from '@corral/react/icons';
import {
  Button,
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '@corral/react/ui';
import { useTranslations } from 'use-intl';
import { reasoningFrom, reasoningValue } from './autoChoice.ts';
import type { ProfileInfo } from './useModels.ts';

export function AutoModelMenu({
  value,
  profiles,
  showReasoning,
  ultra,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  value: AutoModelChoice;
  profiles: ProfileInfo[];
  showReasoning: boolean;
  ultra: boolean;
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
  const options = [
    { value: '', label: tq('legacy') },
    {
      value: 'provider_default',
      label: tq('provider_default'),
      disabled: !profile?.reasoningCapabilities?.providerDefault,
    },
    ...(profile?.reasoningCapabilities?.levels ?? []).map((level) => ({
      value: level,
      label: tq(`level.${level}`),
    })),
    {
      value: 'auto',
      label: tq('auto'),
      disabled: !profile?.reasoningCapabilities?.levels.includes('medium'),
    },
    {
      value: 'route',
      label: t('reasoningRoute'),
      disabled: !profile?.reasoningCapabilities?.levels.includes('medium'),
    },
  ];
  const requested = reasoningValue(value.reasoning);
  if (!options.some((option) => option.value === requested))
    options.push({
      value: requested,
      label: `${effort} · ${tc('unsupportedReasoning')}`,
      disabled: true,
    });
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <Button
            variant="ghost-muted"
            size="sm"
            className="min-w-0 max-w-full rounded-full"
            disabled={disabled}
            aria-label={t('autoModel')}
          />
        }
      >
        <span className="truncate">
          {profile?.label ?? value.modelProfile}
          {showReasoning ? ` · ${ultra ? tc('ultraMaximumShort') : effort}` : ''}
        </span>
        <ChevronDown className="size-3.5 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          aria-label={t('autoModel')}
          value={value.modelProfile}
          onValueChange={(modelProfile) =>
            onChange({ ...value, modelProfile: String(modelProfile) })
          }
        >
          {!profile ? (
            <MenuRadioItem value={value.modelProfile} disabled>
              {value.modelProfile}
            </MenuRadioItem>
          ) : null}
          {profiles.map((profile) => (
            <MenuRadioItem
              key={profile.profileId}
              value={profile.profileId}
              closeOnClick
              disabled={disabled}
            >
              {profile.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {showReasoning && !ultra ? (
          <>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>{tq('label')}</MenuSubTrigger>
              <MenuSubPopup>
                <MenuRadioGroup
                  aria-label={tq('label')}
                  value={requested}
                  onValueChange={(next) => {
                    const reasoning = reasoningFrom(String(next));
                    onChange({
                      modelProfile: value.modelProfile,
                      ...(reasoning ? { reasoning } : {}),
                    });
                  }}
                >
                  {options.map((option) => (
                    <MenuRadioItem
                      key={option.value}
                      value={option.value}
                      disabled={disabled || option.disabled}
                      closeOnClick
                    >
                      {option.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
