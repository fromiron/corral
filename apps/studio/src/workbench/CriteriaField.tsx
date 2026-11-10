import { SESSION_CRITERIA_MAX, SESSION_CRITERION_MAX } from '@corral/core';
import { Textarea } from '@corral/react/design-kit';
import type { Ref } from 'react';
import { useTranslations } from 'use-intl';
import { criteriaProblem } from './sessionCriteria.ts';

/**
 * A work session's completion criteria, one per line (docs/specs/workbench.md#세션-완료-기준).
 * Enter adds a line; nothing here submits. The limits show on the field only once they are
 * passed. `labelHidden` keeps the name for a dialog whose title already says it.
 */
export function CriteriaField({
  id,
  value,
  disabled,
  labelHidden = false,
  fieldRef,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  labelHidden?: boolean;
  fieldRef?: Ref<HTMLTextAreaElement>;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('Sessions');
  const problem = criteriaProblem(value);
  const error = `${id}-error`;
  const field = (
    <Textarea
      ref={fieldRef}
      id={id}
      disabled={disabled}
      aria-label={t('criteria.label')}
      aria-invalid={problem ? true : undefined}
      aria-describedby={problem ? error : undefined}
      placeholder={t('criteria.placeholder')}
      value={value}
      rows={3}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <div className="flex flex-col gap-1">
      {labelHidden ? (
        field
      ) : (
        <label htmlFor={id} className="flex flex-col gap-1 text-caption text-muted-foreground">
          <span className="pl-2.5">{t('criteria.label')}</span>
          {field}
        </label>
      )}
      {problem ? (
        <p id={error} role="alert" className="pl-2.5 text-caption text-destructive">
          {problem.kind === 'tooMany'
            ? t('criteria.tooMany', { max: SESSION_CRITERIA_MAX })
            : t('criteria.tooLong', { line: problem.line, max: SESSION_CRITERION_MAX })}
        </p>
      ) : null}
    </div>
  );
}
