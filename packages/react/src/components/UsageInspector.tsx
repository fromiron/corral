import { usageTotals } from '@corral/core';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../design-kit/index.ts';
import { estimateRunCost, type ModelPrices } from '../run/cost.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore } from '../run/session.ts';
import { usageByAgent } from '../run/usage-by-agent.ts';

// Runs have no usage budget (product contract §9): this shows what was used, never a limit.

/** `prices`: list prices per model (the local server's catalog); without them, no estimate. */
export function UsageInspector({
  session,
  prices,
  headed = true,
}: {
  session: RunSessionStore;
  prices?: ModelPrices | undefined;
  /** Show the heading. Inside a tab whose label already says Usage, the region keeps the name. */
  headed?: boolean;
}) {
  const t = useTranslations('Usage');
  const format = useFormatter();
  const headingId = useId();
  const projection = useRunDisplay(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  if (!projection || !definition) return null;
  const totals = usageTotals(projection);
  const limits = projection.limits ?? definition.limits;
  const usd = (micros: number) =>
    format.number(micros / 1_000_000, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
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
  const roleOf = (executionId: string) =>
    definition.nodes.find((node) => node.id === projection.executions[executionId]?.nodeId)
      ?.label ?? t('unknownRole');
  const labelOf = (nodeId: string) =>
    definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  // Each agent's share, counted as the totals above are, so the rows add up to them.
  const agents = usageByAgent(projection);
  const calls = Object.values(projection.modelCalls);
  const others = Object.values(projection.usage);
  const imageNo = new Map(
    others.filter((r) => r.kind === 'image').map((r, index) => [r.usageId, index + 1]),
  );
  const spawns = projection.executionOrder.filter(
    (id) => projection.executions[id]?.parentExecutionId,
  ).length;
  return (
    <KitCard
      role="region"
      {...(headed ? { 'aria-labelledby': headingId } : { 'aria-label': t('heading') })}
    >
      {headed ? (
        <KitCardHeader>
          <h3 id={headingId}>
            <KitCardTitle>{t('heading')}</KitCardTitle>
          </h3>
        </KitCardHeader>
      ) : null}
      <KitCardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
          <dt>{t('outputTokens')}</dt>
          <dd>{t('tokens', { count: totals.outputTokens })}</dd>
          <dt>{t('requests')}</dt>
          <dd>{totals.requests}</dd>
          {totals.inFlight > 0 ? (
            <>
              <dt>{t('inFlight')}</dt>
              <dd>{totals.inFlight}</dd>
            </>
          ) : null}
          {totals.unknown > 0 ? (
            <>
              <dt>{t('unknown')}</dt>
              <dd>{totals.unknown}</dd>
            </>
          ) : null}
          {totals.imageCalls > 0 ? (
            <>
              <dt>{t('imageCost')}</dt>
              <dd>{usd(totals.imageCostMicros)}</dd>
              {totals.imageCostUnknown > 0 ? (
                <>
                  <dt>{t('imageCostUnknown')}</dt>
                  <dd>{totals.imageCostUnknown}</dd>
                </>
              ) : null}
            </>
          ) : null}
          <dt>{t('spawns')}</dt>
          <dd>
            {spawns} / {limits.maxSpawns}
          </dd>
        </dl>
        {prices ? (
          <p data-testid="cost-estimate" className="text-muted-foreground">
            {costText()}
          </p>
        ) : null}
        {agents.length ? (
          <Table aria-label={t('byAgent')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('agent')}</TableHead>
                <TableHead className="text-right">{t('reportedOutput')}</TableHead>
                <TableHead className="text-right">{t('requestCount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((row, index) => (
                <TableRow
                  key={row.nodeId ?? ''}
                  index={index}
                  data-usage-agent={row.nodeId ?? undefined}
                >
                  <TableCell className="text-foreground">
                    {row.nodeId === null ? t('outsideAgents') : labelOf(row.nodeId)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.reported
                      ? t('tokens', { count: row.totals.outputTokens })
                      : row.totals.inFlight > 0
                        ? t('running')
                        : t('noInformation')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.totals.requests}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {calls.length + others.length > 0 ? (
          <KitAccordion type="multiple" className="w-full">
            <KitAccordionItem value="requests">
              <KitAccordionTrigger>{t('byRequest')}</KitAccordionTrigger>
              <KitAccordionContent>
                <ul className="mt-1 flex flex-col gap-1">
                  {calls.map((call, index) => {
                    const output = call.usage?.outputTokens ?? null;
                    const running =
                      output === null &&
                      !call.finished &&
                      !['succeeded', 'failed', 'cancelled'].includes(
                        projection.executions[call.executionId]?.status ?? '',
                      );
                    return (
                      <li key={call.modelCallId} data-testid={`usage-call-${call.modelCallId}`}>
                        <span>
                          {t('requestName', { role: roleOf(call.executionId), number: index + 1 })}
                        </span>{' '}
                        ·{' '}
                        {output !== null
                          ? t('tokens', { count: output })
                          : t(running ? 'running' : 'usageUnknown')}
                        <Diagnostics label={t('diagnostics')} ids={[call.modelCallId]} />
                      </li>
                    );
                  })}
                  {others.map((record) => (
                    <li key={record.usageId} data-testid={`usage-record-${record.usageId}`}>
                      <span>
                        {record.kind === 'image'
                          ? t('imageRequestName', { number: imageNo.get(record.usageId) ?? 0 })
                          : t('teamChoice')}
                      </span>{' '}
                      ·{' '}
                      {record.kind === 'image'
                        ? record.costMicros === null
                          ? t('imageCostNotReported')
                          : usd(record.costMicros)
                        : record.outputTokens === null
                          ? t('usageUnknown')
                          : t('tokens', { count: record.outputTokens })}
                      <Diagnostics label={t('diagnostics')} ids={[record.usageId]} />
                    </li>
                  ))}
                </ul>
              </KitAccordionContent>
            </KitAccordionItem>
          </KitAccordion>
        ) : null}
      </KitCardContent>
    </KitCard>
  );
}

function Diagnostics({ label, ids }: { label: string; ids: string[] }) {
  return (
    <details className="text-muted-foreground">
      <summary className="cursor-pointer">{label}</summary>
      <code className="select-text break-all">{ids.join(' · ')}</code>
    </details>
  );
}
