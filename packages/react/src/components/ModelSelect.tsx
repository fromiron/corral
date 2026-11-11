import { useTranslations } from 'use-intl';
import { type AgentMark, type ModelOption, ModelPicker } from '../design-kit/index.ts';

/** A model profile as the pickers list it; the fields past `label` come from the server. */
export interface ProfileChoice {
  profileId: string;
  label: string;
  available: boolean;
  /** A named profile, or a model of a connected provider (no profile needed). */
  source?: 'profile' | 'connection' | undefined;
  provider?: string | undefined;
  providerName?: string | undefined;
  modelId?: string | undefined;
  modelName?: string | null | undefined;
}

/** The kit's brand mark for a provider, where it has one; otherwise its initial shows. */
export function providerMark(providerId: string | undefined): AgentMark | undefined {
  if (!providerId) return undefined;
  if (providerId === 'openai' || providerId === 'openai-codex' || providerId === 'azure-openai')
    return 'openai';
  if (providerId === 'anthropic') return 'claude';
  if (providerId.startsWith('google') || providerId === 'gemini') return 'gemini';
  if (providerId === 'mistral') return 'mistral';
  if (providerId === 'github-copilot') return 'github';
  if (providerId === 'vercel-ai-gateway') return 'vercel';
  return undefined;
}

/**
 * Picker rows for model profiles: the named profiles first, then one group per connected
 * provider. A row is the model's name; a profile's own name shows only when it is not the
 * model id, and a profile that cannot run says so.
 */
export function profileChoices(
  profiles: readonly ProfileChoice[],
  labels: { profiles: string; unavailable: string },
): ModelOption[] {
  const named: ModelOption[] = [];
  const groups = new Map<string, ModelOption[]>();
  for (const profile of profiles) {
    const connection = profile.source === 'connection';
    const group = connection
      ? (profile.providerName ?? profile.provider ?? labels.profiles)
      : labels.profiles;
    const mark = providerMark(profile.provider);
    const own = !connection && profile.modelId !== profile.profileId ? profile.profileId : '';
    const option: ModelOption = {
      id: profile.profileId,
      name:
        profile.modelName ??
        (profile.modelId && profile.providerName ? profile.modelId : profile.label),
      description: [own, profile.available ? '' : labels.unavailable].filter(Boolean).join(' · '),
      group,
      keywords: [profile.profileId, profile.modelId, profile.providerName, profile.provider]
        .filter(Boolean)
        .join(' '),
      ...(mark ? { mark } : {}),
      ...(profile.providerName ? { markText: profile.providerName } : {}),
    };
    if (!connection) named.push(option);
    else groups.set(group, [...(groups.get(group) ?? []), option]);
  }
  return [
    ...named,
    ...[...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .flatMap(([, options]) => options),
  ];
}

/**
 * A model chosen in a form (a team role, a meeting participant, a schedule): a field that opens
 * the searchable, grouped model list. A saved value that is no longer listed stays visible as a
 * choice that cannot be picked again.
 */
export function ModelSelect({
  id,
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  missingLabel,
  placeholder,
  open,
  onOpenChange,
  className,
}: {
  id?: string;
  /** The field's name; the trigger reads "label: model". */
  label: string;
  value: string;
  options: ModelOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  /** The note on a saved value that is not listed. */
  missingLabel?: string;
  /** The trigger's text while nothing is chosen. */
  placeholder?: string;
  /** The list's open state, for a form that opens it itself (such as on adding a row). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const t = useTranslations('ModelSelect');
  const models =
    value && !options.some((option) => option.id === value)
      ? [
          {
            id: value,
            name: value,
            description: missingLabel ?? t('missing'),
            disabled: true,
          },
          ...options,
        ]
      : options;
  return (
    <ModelPicker
      {...(id ? { triggerId: id } : {})}
      {...(className ? { className } : {})}
      trigger="field"
      footer={false}
      reasoning={null}
      closeOnSelect
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
      {...(placeholder ? { placeholder } : {})}
      models={models}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (!disabled && next !== value) onValueChange(next);
      }}
      search={{ label: t('search'), noMatch: (query) => t('noMatch', { query }) }}
      labels={{
        model: label,
        settings: label,
        trigger: (name) => `${label}: ${name}`,
        empty: t('empty'),
      }}
    />
  );
}
