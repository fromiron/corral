import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Check, Copy } from '../design-kit/icons.ts';
import { Button, Tooltip } from '../design-kit/index.ts';

/** An icon button that copies the exact text; its name says what, its status says how it went. */
export function CopyTextButton({ text, code = false }: { text: string; code?: boolean }) {
  const t = useTranslations('MessageBody');
  const [feedback, setFeedback] = useState<{ text: string; status: 'copied' | 'failed' } | null>(
    null,
  );
  const status = feedback?.text === text ? feedback.status : 'idle';
  const label = t(code ? 'copyCode' : 'copyMessage');
  return (
    <span className="inline-flex items-center gap-2">
      <Tooltip content={status === 'copied' ? t('copied') : label}>
        <Button
          size="icon-compact"
          variant="ghost"
          aria-label={label}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setFeedback({ text, status: 'copied' });
            } catch {
              setFeedback({ text, status: 'failed' });
            }
          }}
        >
          {status === 'copied' ? <Check /> : <Copy />}
        </Button>
      </Tooltip>
      <span role="status" className={status === 'failed' ? 'text-caption text-danger' : 'sr-only'}>
        {status === 'failed' ? t('copyFailed') : status === 'copied' ? t('copied') : ''}
      </span>
    </span>
  );
}
