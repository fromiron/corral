import type { RunProjection } from '@corral/core';
import { useId, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { diffLines } from '../artifacts/diff.ts';
import {
  KitAccordion,
  KitAccordionContent,
  KitAccordionItem,
  KitAccordionTrigger,
  KitButton,
  KitCard,
  KitCardAction,
  KitCardContent,
  KitCardHeader,
  KitCardTitle,
  KitTable,
  KitTableBody,
  KitTableCell,
  KitTableHead,
  KitTableHeader,
  KitTableRow,
} from '../design-kit/index.ts';
import { type CompareKey, compareRuns } from '../run/compare.ts';
import { estimateRunCost, type ModelPrices } from '../run/cost.ts';
import { ReasoningSummary } from './ReasoningSummary.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';

export interface ComparedRun {
  projection: RunProjection;
  /** The Corral's name, when known. */
  name: string | null;
  /** The final output text; null when the run produced none. */
  output: string | null;
}

/** Two runs side by side (roadmap 16): the eval report's figures and the two outputs. */
export function RunComparison({
  a,
  b,
  prices,
}: {
  a: ComparedRun;
  b: ComparedRun;
  prices?: ModelPrices | undefined;
}) {
  const t = useTranslations('Compare');
  const tr = useTranslations('Reasoning');
  const tStatus = useTranslations('Status');
  const format = useFormatter();
  const tableId = useId();
  const outputsId = useId();
  const [showDiff, setShowDiff] = useState(false);
  const rows = compareRuns(a.projection, b.projection);
  const diff = useMemo(
    () =>
      showDiff && a.output !== null && b.output !== null ? diffLines(a.output, b.output) : null,
    [showDiff, a.output, b.output],
  );

  const value = (key: CompareKey, v: string | number | null) => {
    if (v === null) return '—';
    if (key === 'elapsed' && typeof v === 'number')
      return t('seconds', { value: Math.round(v / 100) / 10 });
    if (key === 'status') return tStatus(String(v));
    if (key === 'mode') return t(`mode.${v}`);
    return typeof v === 'number' ? format.number(v) : v;
  };
  const cost = (run: ComparedRun) => {
    if (!prices) return null;
    const e = estimateRunCost(run.projection, prices);
    if (e.pricedCalls > 0)
      return format.number(e.usd, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: e.usd < 1 ? 4 : 2,
      });
    if (e.subscriptionCalls > 0) return t('subscription');
    return e.simulated ? t('simulated') : '—';
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <KitCard>
        <KitCardHeader>
          <h3 id={tableId}>
            <KitCardTitle>{t('figures')}</KitCardTitle>
          </h3>
        </KitCardHeader>
        <KitCardContent className="overflow-x-auto">
          <KitTable aria-labelledby={tableId} className="table-fixed">
            <KitTableHeader>
              <KitTableRow>
                <KitTableHead className="w-1/3" />
                {[a, b].map((run) => (
                  <KitTableHead key={run.projection.runId} scope="col" className="align-top">
                    <div className="break-words">{run.name ?? '—'}</div>
                    <KitAccordion className="w-full">
                      <KitAccordionItem value={run.projection.runId} highlight="trigger">
                        <KitAccordionTrigger className="font-mono">
                          {run.projection.runId.length > 12
                            ? `${run.projection.runId.slice(0, 4)}…${run.projection.runId.slice(-6)}`
                            : run.projection.runId}
                        </KitAccordionTrigger>
                        <KitAccordionContent>
                          <code className="block break-all">{run.projection.runId}</code>
                        </KitAccordionContent>
                      </KitAccordionItem>
                    </KitAccordion>
                  </KitTableHead>
                ))}
              </KitTableRow>
            </KitTableHeader>
            <KitTableBody>
              {rows.map((row, index) => {
                const numeric = !['status', 'mode', 'models'].includes(row.key);
                const cellClass = `break-words align-top ${numeric ? 'text-right tabular-nums' : ''}`;
                return (
                  <KitTableRow
                    key={row.key}
                    index={index}
                    className={row.differs ? 'bg-primary/10' : undefined}
                    data-differs={row.differs}
                  >
                    <KitTableHead scope="row" className="break-keep align-top">
                      {t(`row.${row.key}`)}
                    </KitTableHead>
                    <KitTableCell className={cellClass}>{value(row.key, row.a)}</KitTableCell>
                    <KitTableCell className={cellClass}>{value(row.key, row.b)}</KitTableCell>
                  </KitTableRow>
                );
              })}
              {prices ? (
                <KitTableRow index={rows.length}>
                  <KitTableHead scope="row" className="break-keep align-top">
                    {t('row.cost')}
                  </KitTableHead>
                  <KitTableCell className="break-words text-right align-top tabular-nums">
                    {cost(a)}
                  </KitTableCell>
                  <KitTableCell className="break-words text-right align-top tabular-nums">
                    {cost(b)}
                  </KitTableCell>
                </KitTableRow>
              ) : null}
            </KitTableBody>
          </KitTable>
        </KitCardContent>
      </KitCard>

      <KitAccordion className="w-full">
        <KitAccordionItem value="reasoning">
          <KitAccordionTrigger>{tr('appliedHeading')}</KitAccordionTrigger>
          <KitAccordionContent>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              {[a, b].map((run) => (
                <div key={run.projection.runId}>
                  <h4>
                    <KitCardTitle>{run.name ?? run.projection.runId}</KitCardTitle>
                  </h4>
                  <ul className="flex flex-col gap-2">
                    {Object.values(run.projection.modelCalls).map((call) => (
                      <li key={call.modelCallId}>
                        <span>
                          {run.projection.executions[call.executionId]?.nodeId} · {
                            call.modelCallId
                          }{' '}
                        </span>
                        <ReasoningSummary call={call} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </KitAccordionContent>
        </KitAccordionItem>
      </KitAccordion>
      <KitCard role="region" aria-labelledby={outputsId}>
        <KitCardHeader>
          <h3 id={outputsId}>
            <KitCardTitle>{t('outputs')}</KitCardTitle>
          </h3>
          {a.output !== null && b.output !== null ? (
            <KitCardAction>
              <KitButton
                type="button"
                variant="tertiary"
                aria-pressed={showDiff}
                onClick={() => setShowDiff(!showDiff)}
              >
                {showDiff ? t('sideBySide') : t('showDiff')}
              </KitButton>
            </KitCardAction>
          ) : null}
        </KitCardHeader>
        <KitCardContent>
          {diff ? (
            <pre className="overflow-x-auto font-mono">
              {diff.map((line, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
                  key={i}
                  data-diff={line.kind}
                  className={
                    line.kind === 'added'
                      ? 'bg-success/15'
                      : line.kind === 'removed'
                        ? 'bg-danger/15 line-through'
                        : undefined
                  }
                >
                  {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                  {line.text}
                </div>
              ))}
            </pre>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {[a, b].map((run) => (
                <KitCard key={run.projection.runId}>
                  <KitCardHeader>
                    <h4>
                      <KitCardTitle>{run.name ?? run.projection.runId}</KitCardTitle>
                    </h4>
                  </KitCardHeader>
                  <KitCardContent className="max-h-[60vh] overflow-auto">
                    {run.output === null ? (
                      <p className="text-muted-foreground">{t('noOutput')}</p>
                    ) : (
                      <SafeMarkdown text={run.output} />
                    )}
                  </KitCardContent>
                </KitCard>
              ))}
            </div>
          )}
        </KitCardContent>
      </KitCard>
    </div>
  );
}
