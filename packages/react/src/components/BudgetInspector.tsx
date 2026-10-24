import { useId } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  KitAccordion,
  KitAccordionContent,
  KitAccordionItem,
  KitAccordionTrigger,
  KitCard,
  KitCardContent,
  KitCardHeader,
  KitCardTitle,
} from '../design-kit/index.ts';
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
  const unlimited = (value: number) =>
    projection.usageLimits === 'none' || value === Number.MAX_SAFE_INTEGER;
  const limits = projection.limits ?? definition.limits;
  const remaining = Math.max(
    0,
    limits.maxOutputTokens - budget.spent - budget.reserved - budget.unknownOutstanding,
  );
  const imageUsd = (micros: number) =>
    format.number(micros / 1_000_000, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  const imageFigures = [
    ['imageSpent', budget.imageSpentMicros],
    ['imageReserved', budget.imageReservedMicros],
    ['imageUnknown', budget.imageUnknownOutstandingMicros],
  ] as const;
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
    <KitCard role="region" aria-labelledby={headingId}>
      <KitCardHeader>
        <h3 id={headingId}>
          <KitCardTitle>{t('heading')}</KitCardTitle>
        </h3>
      </KitCardHeader>
      <KitCardContent className="flex flex-col gap-3">
        {projection.usageLimits === 'none' ? <p role="note">{t('noLimits')}</p> : null}
        {projection.usageLimits === 'none' ? (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
            <dt>{t('callsInFlight')}</dt>
            <dd>
              {Object.values(budget.reservations).filter((row) => row.status === 'reserved').length}
            </dd>
            <dt>{t('callsUnknown')}</dt>
            <dd>
              {Object.values(budget.reservations).filter((row) => row.status === 'unknown').length}
            </dd>
          </dl>
        ) : null}
        {!unlimited(limits.maxOutputTokens) ? (
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
        ) : (
          <p>
            {t('confirmed')}: {t('tokens', { count: budget.spent })}
          </p>
        )}
        {!unlimited(limits.maxModelCalls) ? (
          <Meter
            label={t('meterCalls')}
            value={budget.modelCalls}
            max={limits.maxModelCalls}
            text={t('meterCallsText', { used: budget.modelCalls, max: limits.maxModelCalls })}
            now={budget.modelCalls}
          />
        ) : (
          <p>
            {t('callsMade')}: {budget.modelCalls}
          </p>
        )}
        {prices ? <CostLine text={costText()} /> : null}
        {imageFigures.some(([, value]) => value !== undefined) ? (
          <>
            <dl
              aria-label={t('imageBudget')}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1"
            >
              {imageFigures.flatMap(([key, value]) =>
                value === undefined
                  ? []
                  : [
                      <dt key={`${key}-label`}>{t(key)}</dt>,
                      <dd key={`${key}-amount`}>{imageUsd(value)}</dd>,
                    ],
              )}
            </dl>
            {budget.imageUnknownOutstandingMicros !== undefined ? (
              <p className="text-muted-foreground">{t('imageUnknownNote')}</p>
            ) : null}
          </>
        ) : null}
        <KitAccordion type="multiple" className="w-full">
          <KitAccordionItem value="figures">
            <KitAccordionTrigger>{t('allFigures')}</KitAccordionTrigger>
            <KitAccordionContent>
              <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt>{t('confirmed')}</dt>
                <dd>{t('tokens', { count: budget.spent })}</dd>
                {!unlimited(limits.maxOutputTokens) ? (
                  <>
                    <dt>{t('reserved')}</dt>
                    <dd>{t('tokens', { count: budget.reserved })}</dd>
                    <dt>{t('unknownHeld')}</dt>
                    <dd>{t('tokens', { count: budget.unknownOutstanding })}</dd>
                    <dt>{t('remaining')}</dt>
                    <dd>
                      {unlimited(limits.maxOutputTokens)
                        ? t('unlimited')
                        : t('tokens', { count: remaining })}
                    </dd>
                    <dt>{t('limit')}</dt>
                    <dd>{t('tokens', { count: limits.maxOutputTokens })}</dd>
                  </>
                ) : null}
                <dt>{t('modelCalls')}</dt>
                <dd>
                  {budget.modelCalls} /{' '}
                  {unlimited(limits.maxModelCalls) ? t('unlimited') : limits.maxModelCalls}
                </dd>
                <dt>{t('spawns')}</dt>
                <dd>
                  {
                    projection.executionOrder.filter(
                      (id) => projection.executions[id]?.parentExecutionId,
                    ).length
                  }{' '}
                  / {limits.maxSpawns}
                </dd>
                <dt>{t('cost')}</dt>
                <dd className="break-words">{prices ? costText() : t('costUnavailable')}</dd>
              </dl>
              <p className="text-muted-foreground">{t('unknownNote')}</p>
              <p className="text-muted-foreground">
                {t(projection.usageLimits === 'none' ? 'noLimitsNote' : 'capNote')}
              </p>
            </KitAccordionContent>
          </KitAccordionItem>
          {Object.keys(budget.reservations).length > 0 ? (
            <KitAccordionItem value="requests">
              <KitAccordionTrigger>{t('requests')}</KitAccordionTrigger>
              <KitAccordionContent>
                <ul className="mt-1 flex flex-col gap-1">
                  {Object.entries(budget.reservations).map(([id, row]) => (
                    <li key={id} data-testid={`budget-call-${row.modelCallId ?? id}`}>
                      <span className="font-mono">{row.modelCallId ?? id}</span> ·{' '}
                      <span>{t(`state.${row.status}`)}</span> ·{' '}
                      {row.image ? (
                        <>
                          {row.image.actualMicros === null
                            ? t('imageCostUnknown')
                            : imageUsd(row.image.actualMicros)}
                          {row.status !== 'settled' ? (
                            <span>
                              {' '}
                              · {t('imageHeld', { usd: imageUsd(row.image.reservedMicros) })}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {row.actual === null
                            ? t('usageUnknown')
                            : t('tokens', { count: row.actual })}
                          {row.status !== 'settled' && projection.usageLimits !== 'none' ? (
                            <span> · {t('held', { count: row.reserved })}</span>
                          ) : null}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </KitAccordionContent>
            </KitAccordionItem>
          ) : null}
        </KitAccordion>
      </KitCardContent>
    </KitCard>
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
        <span className="text-muted-foreground">{text}</span>
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
    <p data-testid="cost-estimate" className="text-muted-foreground">
      {text}
    </p>
  );
}
