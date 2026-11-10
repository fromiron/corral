import type { ErrorCode } from '@corral/contracts';
import { useTranslations } from 'use-intl';

/**
 * Recorded diagnostics remain available without becoming the primary user explanation. `open`
 * leads with the recorded reason instead: its sentence with the recorded text shown beneath it,
 * or, when the cause has no sentence, the recorded text verbatim under a localized label. The
 * server's own words are never made the headline.
 */
export function FailureNotice({
  message,
  code,
  cancelled = false,
  open = false,
}: {
  message: string;
  code?: ErrorCode | null;
  cancelled?: boolean;
  open?: boolean;
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
  if (open && !known)
    return (
      <div className="w-full text-caption">
        <p className="text-danger">{t('recorded')}</p>
        <p className="mt-1 select-text text-foreground wrap-anywhere">
          {code ? `${code}: ` : ''}
          {message}
        </p>
      </div>
    );
  return (
    <div className="w-full text-caption">
      {known ? (
        <p className={cancelled ? 'text-muted-foreground' : 'text-danger'}>{t(known)}</p>
      ) : null}
      {provider ? <p className="mt-1 text-muted-foreground">{t(`recovery.${provider}`)}</p> : null}
      <details open={open || undefined} className={`text-muted-foreground ${known ? 'mt-1' : ''}`}>
        <summary className="cursor-pointer">{t('diagnostics')}</summary>
        <code className="select-text whitespace-pre-wrap break-words">
          {code ? `${code}: ` : ''}
          {message}
        </code>
      </details>
    </div>
  );
}
