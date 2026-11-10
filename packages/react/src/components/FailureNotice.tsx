import type { ErrorCode } from '@corral/contracts';
import { useTranslations } from 'use-intl';

/** Recorded diagnostics remain available without becoming the primary user explanation. */
export function FailureNotice({
  message,
  code,
  cancelled = false,
}: {
  message: string;
  code?: ErrorCode | null;
  cancelled?: boolean;
}) {
  const t = useTranslations('Failure');
  // Older simulated settlements stored this fixed cancellation diagnostic without a code field.
  const reasonCode =
    code ?? (message === 'TARGET_TERMINAL: scope cancelled' ? 'TARGET_TERMINAL' : null);
  const provider =
    !cancelled &&
    /^the model request failed: (?:HTTP [1-5]\d{2} \()?((?:AUTH|QUOTA|RATE_LIMIT|CONTEXT_OVERFLOW|SERVER|TRANSPORT|CANCELLED))(?:\))?$/.exec(
      message,
    )?.[1];
  // A failure of unknown cause adds no sentence: its Diagnostics hold the recorded reason.
  const known = cancelled
    ? 'cancelled'
    : provider
      ? `provider.${provider}`
      : reasonCode && t.has(`code.${reasonCode}`)
        ? `code.${reasonCode}`
        : null;
  return (
    <div className="w-full text-caption">
      {known ? (
        <p className={cancelled ? 'text-muted-foreground' : 'text-danger'}>{t(known)}</p>
      ) : null}
      {provider ? <p className="mt-1 text-muted-foreground">{t(`recovery.${provider}`)}</p> : null}
      <details className={`text-muted-foreground ${known ? 'mt-1' : ''}`}>
        <summary className="cursor-pointer">{t('diagnostics')}</summary>
        <code className="select-text whitespace-pre-wrap break-words">
          {code ? `${code}: ` : ''}
          {message}
        </code>
      </details>
    </div>
  );
}
