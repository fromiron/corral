import { Button } from '@corral/react/design-kit';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

export function MeetingDiagnostics({ text }: { text: string }) {
  const t = useTranslations('Meetings');
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <details className="text-xs">
      <summary>{t('diagnostics')}</summary>
      <pre className="select-text whitespace-pre-wrap wrap-anywhere py-2">{text}</pre>
      <Button
        size="compact"
        variant="tertiary"
        onClick={async () => {
          setCopied(false);
          setFailed(false);
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        {t(copied ? 'diagnosticsCopied' : 'copyDiagnostics')}
      </Button>
      {failed ? <p role="status">{t('diagnosticsCopyFailed')}</p> : null}
    </details>
  );
}
