import { useId } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { estimateRunCost, type ModelPrices } from '../run/cost.ts';
import type { RunSessionStore } from '../run/session.ts';

/** `prices`: list prices per model (the local server's catalog); without them, no estimate. */
export function BudgetInspector({
  session,
  prices,
}: {
  session: RunSessionStore;
  prices?: ModelPrices | undefined;
}) {
  const t = useTranslations('Budget');
  const format = useFormatter();
  const headingId = useId();
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  if (!projection || !definition) return null;
  const { budget } = projection;
  const limits = projection.limits ?? definition.limits;
  const remaining = Math.max(
    0,
    limits.maxOutputTokens - budget.spent - budget.reserved - budget.unknownOutstanding,
  );
  // Roadmap 15: list prices for API-key calls; a subscription or unknown usage is said so.
  const costText = () => {
    if (!prices) return '';
    const estimate = estimateRunCost(projection, prices);
    const parts: string[] = [];
    if (estimate.pricedCalls > 0) {
      parts.push(
        t('costEstimate', {
          usd: format.number(estimate.usd, {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: estimate.usd < 1 ? 4 : 2,
          }),
        }),
      );
    }
    if (estimate.subscriptionCalls > 0) parts.push(t('costSubscription'));
    if (estimate.unknownCalls > 0) parts.push(t('costUnknown', { count: estimate.unknownCalls }));
    if (parts.length === 0) parts.push(estimate.simulated ? t('costSimulated') : t('costNone'));
    return parts.join(' · ');
  };
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded fill-group p-2 text-xs"
    >
      <h3 id={headingId} className="font-semibold">
        {t('heading')}
      </h3>
      <Meter
        label={t('meterTokens')}
        value={budget.spent + budget.reserved + budget.unknownOutstanding}
        max={limits.maxOutputTokens}
        text={t('meterTokensText', {
          used: budget.spent,
          held: budget.reserved + budget.unknownOutstanding,
          max: limits.maxOutputTokens,
        })}
        now={budget.spent}
      />
      <Meter
        label={t('meterCalls')}
        value={budget.modelCalls}
        max={limits.maxModelCalls}
        text={t('meterCallsText', { used: budget.modelCalls, max: limits.maxModelCalls })}
        now={budget.modelCalls}
      />
      {prices ? <CostLine text={costText()} /> : null}
      <details>
        <summary className="cursor-pointer">{t('allFigures')}</summary>
        <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt>{t('confirmed')}</dt>
          <dd>{t('tokens', { count: budget.spent })}</dd>
          <dt>{t('reserved')}</dt>
          <dd>{t('tokens', { count: budget.reserved })}</dd>
          <dt>{t('unknownHeld')}</dt>
          <dd>{t('tokens', { count: budget.unknownOutstanding })}</dd>
          <dt>{t('remaining')}</dt>
          <dd>{t('tokens', { count: remaining })}</dd>
          <dt>{t('limit')}</dt>
          <dd>{t('tokens', { count: limits.maxOutputTokens })}</dd>
          <dt>{t('modelCalls')}</dt>
          <dd>
            {budget.modelCalls} / {limits.maxModelCalls}
          </dd>
          <dt>{t('spawns')}</dt>
          <dd>
            {
              projection.executionOrder.filter((id) => projection.executions[id]?.parentExecutionId)
                .length
            }{' '}
            / {limits.maxSpawns}
          </dd>
          <dt>{t('cost')}</dt>
          <dd className="break-words">{prices ? costText() : t('costUnavailable')}</dd>
        </dl>
        <p className="text-muted">{t('unknownNote')}</p>
        <p className="text-muted">{t('capNote')}</p>
      </details>
      {Object.keys(budget.reservations).length > 0 ? (
        <details>
          <summary className="cursor-pointer">{t('requests')}</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {Object.entries(budget.reservations).map(([id, row]) => (
              <li
                key={id}
                data-testid={`budget-call-${row.modelCallId ?? id}`}
                className="rounded fill-group p-1"
              >
                <span className="font-mono">{row.modelCallId ?? id}</span> ·{' '}
                <span>{t(`state.${row.status}`)}</span> ·{' '}
                {row.actual === null ? t('usageUnknown') : t('tokens', { count: row.actual })}
                {row.status !== 'settled' ? (
                  <span> · {t('held', { count: row.reserved })}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** A labelled native meter of the confirmed amount; the text also states what is held. */
function Meter({
  label,
  now,
  max,
  text,
}: {
  label: string;
  value?: number;
  now: number;
  max: number;
  text: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between gap-2">
        <span id={id}>{label}</span>
        <span className="text-muted">{text}</span>
      </div>
      <meter
        aria-labelledby={id}
        aria-valuetext={text}
        min={0}
        max={max}
        value={now}
        className="h-1.5 w-full"
      />
    </div>
  );
}

function CostLine({ text }: { text: string }) {
  return (
    <p data-testid="cost-estimate" className="text-muted">
      {text}
    </p>
  );
}
