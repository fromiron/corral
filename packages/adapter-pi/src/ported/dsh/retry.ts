// Adapted from deepseek-harness 22ddee3, llm/retry-policy.ts and llm-retry/src/index.ts (MIT).
import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai';
export interface ProviderFailure {
  code:
    | 'AUTH'
    | 'QUOTA'
    | 'RATE_LIMIT'
    | 'CONTEXT_OVERFLOW'
    | 'SERVER'
    | 'TRANSPORT'
    | 'CANCELLED'
    | 'UNKNOWN';
  status: number | null;
  retryAfterMs: number | null;
  requestId: string | null;
}
export function providerFailure(
  error: unknown,
  response?: { status: number; headers: Headers },
  now = Date.now(),
): ProviderFailure {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  try {
    const value = (
      typeof error === 'object' && !(error instanceof Error) ? error : JSON.parse(text)
    ) as ProviderFailure;
    if (
      value &&
      [
        'AUTH',
        'QUOTA',
        'RATE_LIMIT',
        'CONTEXT_OVERFLOW',
        'SERVER',
        'TRANSPORT',
        'CANCELLED',
        'UNKNOWN',
      ].includes(value.code) &&
      (value.status === null ||
        (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)) &&
      (value.retryAfterMs === null ||
        (Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0)) &&
      (value.requestId === null ||
        (typeof value.requestId === 'string' && /^[\w:.-]{1,200}$/.test(value.requestId)))
    )
      return {
        code: value.code,
        status: value.status,
        retryAfterMs: value.retryAfterMs,
        requestId: value.requestId,
      };
  } catch {
    /* Raw provider errors are classified without retaining their text. */
  }
  const status =
    response?.status ?? (Number(text.match(/\b(401|403|408|429|500|502|503|504)\b/)?.[1]) || null);
  const after = response?.headers.get('retry-after');
  const retryAfterMs =
    after == null
      ? null
      : Number.isFinite(Number(after))
        ? Math.max(0, Number(after) * 1000)
        : Math.max(0, Date.parse(after) - now);
  const code = /insufficient_quota|quota.exceed|credit|billing|account.balance/i.test(text)
    ? 'QUOTA'
    : status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : isContextOverflow({ stopReason: 'error', errorMessage: text } as AssistantMessage)
          ? 'CONTEXT_OVERFLOW'
          : status !== null && status >= 500
            ? 'SERVER'
            : /abort|cancel/i.test(text)
              ? 'CANCELLED'
              : /ECONNREFUSED|ENOTFOUND|connect timeout/i.test(text)
                ? 'TRANSPORT'
                : 'UNKNOWN';
  const requestId = response?.headers.get('x-request-id') ?? response?.headers.get('request-id');
  return {
    code,
    status,
    retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
    requestId: requestId && /^[\w:.-]{1,200}$/.test(requestId) ? requestId : null,
  };
}
export function retryDelay(
  failure: ProviderFailure,
  retry: number,
  random: () => number,
): number | null {
  if (retry >= 2 || !['RATE_LIMIT', 'SERVER', 'TRANSPORT'].includes(failure.code)) return null;
  return (
    failure.retryAfterMs ??
    Math.round(Math.min(10_000, 500 * 2 ** retry) * (1 + (random() * 2 - 1) * 0.1))
  );
}
export function cancellableDelay(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(completed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), Math.min(delay, 2_147_483_647));
    signal.addEventListener('abort', abort, { once: true });
  });
}
