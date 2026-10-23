import type { RunProjection } from '@corral/core';
import { useId, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { diffLines } from '../artifacts/diff.ts';
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
      <table aria-labelledby={tableId} className="w-full table-fixed text-left text-sm">
        <caption id={tableId} className="pb-2 text-left text-sm font-semibold">
          {t('figures')}
        </caption>
        <thead className="text-xs text-muted">
          <tr>
            <th className="w-1/3" />
            {[a, b].map((run) => (
              <th key={run.projection.runId} scope="col" className="px-2 pb-2 align-top">
                <div className="break-words font-medium text-text">{run.name ?? '—'}</div>
                <details className="mt-1 font-normal">
                  <summary className="cursor-pointer font-mono hover:text-text">
                    {run.projection.runId.length > 12
                      ? `${run.projection.runId.slice(0, 4)}…${run.projection.runId.slice(-6)}`
                      : run.projection.runId}
                  </summary>
                  <code className="mt-1 block break-all">{run.projection.runId}</code>
                </details>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const numeric = !['status', 'mode', 'models'].includes(row.key);
            const cellClass = `break-words px-2 py-2 align-top ${numeric ? 'text-right tabular-nums' : ''}`;
            return (
              <tr
                key={row.key}
                className={`border-t border-line ${row.differs ? 'bg-accent/10' : ''}`}
                data-differs={row.differs}
              >
                <th scope="row" className="break-keep py-2 pr-3 align-top font-normal text-muted">
                  {t(`row.${row.key}`)}
                </th>
                <td className={cellClass}>{value(row.key, row.a)}</td>
                <td className={cellClass}>{value(row.key, row.b)}</td>
              </tr>
            );
          })}
          {prices ? (
            <tr className="border-t border-line">
              <th scope="row" className="break-keep py-2 pr-3 align-top font-normal text-muted">
                {t('row.cost')}
              </th>
              <td className="break-words px-2 py-2 text-right align-top tabular-nums">{cost(a)}</td>
              <td className="break-words px-2 py-2 text-right align-top tabular-nums">{cost(b)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <details className="rounded fill-group p-2 text-xs">
        <summary className="cursor-pointer font-medium">{tr('appliedHeading')}</summary>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          {[a, b].map((run) => (
            <div key={run.projection.runId}>
              <h4 className="mb-2 font-medium">{run.name ?? run.projection.runId}</h4>
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
      </details>
      <section aria-labelledby={outputsId} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id={outputsId} className="text-sm font-semibold">
            {t('outputs')}
          </h3>
          {a.output !== null && b.output !== null ? (
            <button
              type="button"
              aria-pressed={showDiff}
              onClick={() => setShowDiff(!showDiff)}
              className="rounded fill-control px-2 py-1 text-xs"
            >
              {showDiff ? t('sideBySide') : t('showDiff')}
            </button>
          ) : null}
        </div>
        {diff ? (
          <pre className="overflow-x-auto rounded fill-group text-xs">
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
              <div
                key={run.projection.runId}
                className="max-h-[60vh] overflow-auto rounded-md fill-group p-2"
              >
                {run.output === null ? (
                  <p className="text-xs text-muted">{t('noOutput')}</p>
                ) : (
                  <SafeMarkdown text={run.output} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
