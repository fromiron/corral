import type { AutoModelChoice } from '@corral/contracts';
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
} from '@corral/react/design-kit';
import { ChevronDown } from '@corral/react/icons';
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
    tc = useTranslations('Composer'),
    tm = useTranslations('Models');
  const profile = profiles.find((p) => p.profileId === value.modelProfile);
  const effort =
    value.reasoning?.mode === 'fixed'
      ? tq(`level.${value.reasoning.level}`)
      : value.reasoning?.mode === 'route'
        ? t('reasoningRoute')
        : tq(value.reasoning?.mode ?? 'legacy');
  const visibleEffort = showReasoning && value.reasoning ? effort : null;
  const description = [tc('nextRequest'), profile?.label ?? value.modelProfile, visibleEffort]
    .filter(Boolean)
    .join(' · ');
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
            variant="ghost"
            size="compact"
            className="h-auto min-h-9 pointer-coarse:min-h-11 min-w-0 max-w-full rounded-xl py-1 text-left whitespace-normal sm:rounded-full"
            disabled={disabled}
            aria-label={t('autoModel')}
            aria-description={description}
            title={description}
          />
        }
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="block text-2xs text-muted-foreground sm:mr-1.5 sm:inline">
            {tc('nextRequest')}
          </span>
          <span>{profile?.label ?? value.modelProfile}</span>
          {visibleEffort ? (
            <span className="block text-xs text-muted-foreground sm:inline sm:text-inherit">
              {' '}
              · {visibleEffort}
            </span>
          ) : null}
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
              <span className="text-xs text-muted-foreground">
                {tm(
                  profile.imageInput === true
                    ? 'imageSupported'
                    : profile.imageInput === false
                      ? 'textOnly'
                      : 'imageUnknown',
                )}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {showReasoning ? (
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
