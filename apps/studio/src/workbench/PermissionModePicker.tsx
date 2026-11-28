import type { PermissionMode } from '@corral/contracts';
import { Select, Tooltip } from '@corral/react/design-kit';
import { Shield } from '@corral/react/icons';
import { cloneElement } from 'react';
import { useTranslations } from 'use-intl';
import { FOLD_CHIP, FOLD_MARK } from './chipFold.ts';

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
  const folds = value === undefined;
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
      {...(folds
        ? {
            icon: (
              <Shield
                data-policy-mark=""
                aria-hidden="true"
                strokeWidth={1.5}
                className={FOLD_MARK}
              />
            ),
            className: FOLD_CHIP,
            trigger: (control) => (
              <Tooltip content={t('defaultTip')}>
                {cloneElement(control, { 'data-folds': '' } as Record<string, string>)}
              </Tooltip>
            ),
          }
        : {})}
    />
  );
}
