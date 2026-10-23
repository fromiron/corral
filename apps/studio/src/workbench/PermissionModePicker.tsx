import type { PermissionMode } from '@corral/contracts';
import { Select } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';

/** A request choice, never a mutation of a running task's approval policy. */
export function PermissionModePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: PermissionMode | undefined;
  onChange: (mode: PermissionMode | undefined) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Composer.permissionMode');
  return (
    <Select
      variant="chip"
      label={t('label')}
      value={value ?? 'legacy'}
      disabled={disabled}
      onValueChange={(mode) => onChange(mode === 'legacy' ? undefined : mode)}
      options={(['legacy', 'ask', 'accept_edits', 'auto'] as const).map((mode) => ({
        value: mode,
        label: t(mode),
        hint: t(`${mode}Hint`),
      }))}
    />
  );
}
