import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '../design-kit/index.ts';

export function CopyTextButton({ text, code = false }: { text: string; code?: boolean }) {
  const t = useTranslations('MessageBody');
  const [feedback, setFeedback] = useState<{ text: string; status: 'copied' | 'failed' } | null>(
    null,
  );
  const status = feedback?.text === text ? feedback.status : 'idle';
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <Button
        size="compact"
        variant="ghost"
        aria-label={t(code ? 'copyCode' : 'copyMessage')}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setFeedback({ text, status: 'copied' });
          } catch {
            setFeedback({ text, status: 'failed' });
          }
        }}
      >
        {t(status === 'copied' ? 'copied' : code ? 'copyCode' : 'copyMessage')}
      </Button>
      <span role="status" className={status === 'failed' ? 'text-danger' : 'sr-only'}>
        {status === 'failed' ? t('copyFailed') : status === 'copied' ? t('copied') : ''}
      </span>
    </span>
  );
}
