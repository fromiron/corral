import type { ModelAttemptPage } from '@corral/contracts';
import { Button } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

/** Request history is fetched on demand; opening settings does not fetch every Run. */
export function ModelUsagePanel() {
  const { models } = useServices();
  const t = useTranslations('ModelUsage'),
    format = useFormatter();
  const [page, setPage] = useState<ModelAttemptPage | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const load = async (before?: number) => {
    if (!models) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(false);
    try {
      const next = await models.requests(
        { ...(before === undefined ? {} : { before }), limit: 50 },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setPage((previous) => ({
          items: before === undefined ? next.items : [...(previous?.items ?? []), ...next.items],
          nextCursor: next.nextCursor,
        }));
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (request.current === controller) setBusy(false);
    }
  };
  return (
    <section id="models-usage" aria-labelledby="models-usage-heading" className="space-y-3">
      <h3 id="models-usage-heading" className="font-semibold">
        {t('heading')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Button variant="tertiary" size="compact" disabled={busy} onClick={() => void load()}>
        {t(page ? 'refresh' : 'load')}
      </Button>
      {busy ? <p role="status">{t('loading')}</p> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {t('failed')}
        </p>
      ) : null}
      {page?.items.length === 0 ? <p>{t('empty')}</p> : null}
      {page?.items.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {['request', 'status', 'input', 'output', 'cache', 'cost'].map((key) => (
                  <th key={key} scope="col" className="p-2 font-medium">
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.items.map((row) => (
                <tr key={row.attemptId} className="border-t border-border">
                  <th scope="row" className="p-2 font-normal">
                    <div>
                      {row.provider} · {row.modelId}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t(`purpose.${row.intent.purpose}`)} ·{' '}
                      {format.dateTime(new Date(row.startedAt), {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </div>
                  </th>
                  <td className="p-2">{t(`state.${row.status}`)}</td>
                  <td className="p-2">
                    {row.usage.inputTokens === null
                      ? t('unknown')
                      : format.number(row.usage.inputTokens)}
                  </td>
                  <td className="p-2">
                    {row.usage.outputTokens === null
                      ? t('unknown')
                      : format.number(row.usage.outputTokens)}
                  </td>
                  <td className="p-2">
                    {row.usage.cacheReadTokens === null
                      ? t('unknown')
                      : format.number(row.usage.cacheReadTokens)}
                  </td>
                  <td className="p-2">
                    {row.usage.costStatus === 'subscription'
                      ? t('subscription')
                      : row.usage.costUsd === null
                        ? t('unknown')
                        : t(
                            row.usage.costStatus === 'estimated' ? 'estimatedCost' : 'reportedCost',
                            {
                              value: format.number(row.usage.costUsd, {
                                style: 'currency',
                                currency: 'USD',
                                maximumFractionDigits: 6,
                              }),
                            },
                          )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {page?.nextCursor ? (
        <Button
          variant="tertiary"
          size="compact"
          disabled={busy}
          onClick={() => void load(page.nextCursor!)}
        >
          {t('more')}
        </Button>
      ) : null}
    </section>
  );
}
