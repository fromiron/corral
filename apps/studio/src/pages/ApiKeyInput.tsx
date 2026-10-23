import { Button, Input } from '@corral/react/design-kit';
import { Eye, EyeOff } from '@corral/react/icons';
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';

/** Only reveals the value being entered; stored credentials are never loaded into this field. */
export function ApiKeyInput({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Models');
  const id = useId();
  const [visible, setVisible] = useState(false);
  const empty = value.length === 0;
  useEffect(() => {
    if (empty) setVisible(false);
  }, [empty]);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {t('apiKeyLabel')}
      </label>
      <div className="flex items-stretch gap-2">
        <Input
          nativeInput
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={1000}
          font="mono"
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-auto sm:h-auto"
          disabled={disabled}
          aria-label={t(visible ? 'hideKey' : 'showKey')}
          title={t(visible ? 'hideKey' : 'showKey')}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}
