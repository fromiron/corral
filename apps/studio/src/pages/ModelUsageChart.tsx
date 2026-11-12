import type { ModelAttempt } from '@corral/contracts';
import { cn, fontWeights, useSize } from '@corral/react/design-kit';
import { useId } from 'react';
import { useFormatter, useTranslations } from 'use-intl';

const SERIES = ['input', 'output', 'cache'] as const;
type SeriesName = (typeof SERIES)[number];

interface SeriesStat {
  sum: number;
  known: number;
  unknown: number;
}

interface ModelStat {
  name: string;
  requests: number;
  series: Record<SeriesName, SeriesStat>;
}

function prefersReducedMotion() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function token(row: ModelAttempt, series: SeriesName): number | null {
  if (series === 'input') return row.usage.inputTokens;
  if (series === 'output') return row.usage.outputTokens;
  return row.usage.cacheReadTokens;
}

function emptySeries(): SeriesStat {
  return { sum: 0, known: 0, unknown: 0 };
}

function group(items: ModelAttempt[]): ModelStat[] {
  const models = new Map<string, ModelStat>();
  for (const row of items) {
    const name = `${row.provider} · ${row.modelId}`;
    let stat = models.get(name);
    if (!stat) {
      stat = {
        name,
        requests: 0,
        series: { input: emptySeries(), output: emptySeries(), cache: emptySeries() },
      };
      models.set(name, stat);
    }
    stat.requests += 1;
    for (const series of SERIES) {
      const value = token(row, series);
      const slot = stat.series[series];
      if (value === null) slot.unknown += 1;
      else {
        slot.known += 1;
        slot.sum += value;
      }
    }
  }
  return [...models.values()];
}

function diamond(x: number, y: number, size: number) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const radius = size / 2;
  return `M${cx} ${cy - radius} L${cx + radius} ${cy} L${cx} ${cy + radius} L${cx - radius} ${cy} Z`;
}

/**
 * Token bars and a request timeline for the pages Settings has loaded. The kit
 * Sparkline plots every value as a number and hides itself from assistive tech,
 * so it cannot keep an unknown count beside its text. Marks are drawn at their
 * final size; nothing animates.
 */
export function ModelUsageChart({ items }: { items: ModelAttempt[] }) {
  const t = useTranslations('ModelUsage');
  const format = useFormatter();
  const size = useSize();
  const uid = useId().replace(/:/g, '');
  const models = group(items);
  const excluded = items.filter(
    (row) =>
      row.usage.inputTokens === null ||
      row.usage.outputTokens === null ||
      row.usage.cacheReadTokens === null,
  ).length;
  const max = Math.max(
    0,
    ...models.flatMap((model) => SERIES.map((series) => model.series[series].sum)),
  );
  const money = (value: number) =>
    format.number(value, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
  let subscription = 0;
  let unknownCost = 0;
  let reportedZero = 0;
  let estimatedZero = 0;
  for (const row of items) {
    const usage = row.usage;
    if (usage.costStatus === 'subscription') subscription += 1;
    else if (usage.costStatus === 'unknown' || usage.costUsd === null) unknownCost += 1;
    else if (usage.costUsd === 0 && usage.costStatus === 'reported') reportedZero += 1;
    else if (usage.costUsd === 0 && usage.costStatus === 'estimated') estimatedZero += 1;
  }
  const costs = [
    subscription ? t('chart.subscription', { count: subscription }) : null,
    unknownCost ? t('chart.unknownCost', { count: unknownCost }) : null,
    reportedZero ? t('chart.reportedZero', { count: reportedZero, value: money(0) }) : null,
    estimatedZero ? t('chart.estimatedZero', { count: estimatedZero, value: money(0) }) : null,
  ].filter((part): part is string => part !== null);
  const times = items.map((row) => Date.parse(row.startedAt)).filter((ms) => Number.isFinite(ms));
  const earliest = times.length ? Math.min(...times) : null;
  const latest = times.length ? Math.max(...times) : null;
  const span = earliest === null || latest === null ? 0 : latest - earliest;
  const origin = earliest ?? 0;
  const xOf = (iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms) || span === 0) return 50;
    return 2 + ((ms - origin) / span) * 96;
  };
  const seriesText = (stat: SeriesStat) => {
    if (stat.known === 0) return t('unknown');
    const value = format.number(stat.sum);
    return stat.unknown === 0 ? value : t('chart.partial', { value, count: stat.unknown });
  };
  const seriesLabel: Record<SeriesName, string> = {
    input: t('chart.input'),
    output: t('chart.output'),
    cache: t('chart.cache'),
  };

  return (
    <figure
      data-usage-chart=""
      data-motion={prefersReducedMotion() ? 'reduced' : 'static'}
      data-density={size.variant}
      className={cn('space-y-2', size.type.caption)}
    >
      <figcaption>
        {t('chart.caption', { requests: items.length, models: models.length })}
      </figcaption>
      {excluded > 0 ? <p>{t('chart.excluded', { count: excluded })}</p> : null}
      <ul className="space-y-3" aria-label={t('chart.legend')}>
        {models.map((model, index) => (
          <li
            key={model.name}
            data-model-summary={model.name}
            className="flex flex-wrap items-center gap-3"
          >
            <div className="min-w-40 flex-1">
              <p style={{ fontVariationSettings: fontWeights.semibold }}>{model.name}</p>
              {SERIES.map((series) => {
                const stat = model.series[series];
                const name = stat.known > 0 ? seriesLabel[series] : t(series);
                return (
                  <p key={series}>
                    {name} {seriesText(stat)}
                    {stat.unknown > 0 ? ` · ${t('chart.unknownMark')}` : null}
                  </p>
                );
              })}
              <p>
                {t('request')} {format.number(model.requests)}
              </p>
            </div>
            <svg
              data-chart="tokens"
              aria-hidden="true"
              viewBox="0 0 100 22"
              className="h-12 w-full min-w-32 flex-1 text-foreground"
            >
              <defs>
                <pattern
                  id={`${uid}-${index}-hatch`}
                  width="4"
                  height="4"
                  patternUnits="userSpaceOnUse"
                >
                  <path d="M0 4 L4 0" stroke="currentColor" strokeWidth="0.7" />
                </pattern>
                <pattern
                  id={`${uid}-${index}-dots`}
                  width="4"
                  height="4"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="1" cy="1" r="0.7" fill="currentColor" />
                </pattern>
              </defs>
              {SERIES.map((series, seriesIndex) => {
                const stat = model.series[series];
                const y = seriesIndex * 7;
                const painted =
                  series === 'input'
                    ? 'currentColor'
                    : `url(#${uid}-${index}-${series === 'output' ? 'hatch' : 'dots'})`;
                const marks = [];
                let x = 0;
                if (stat.known > 0 && stat.sum > 0 && max > 0) {
                  const width = Math.max(1.5, (stat.sum / max) * 88);
                  marks.push(
                    <rect
                      key="bar"
                      data-series={series}
                      data-model={model.name}
                      data-tokens={String(stat.sum)}
                      x={0}
                      y={y}
                      width={width}
                      height={5}
                      fill={painted}
                      stroke={series === 'input' ? 'none' : 'currentColor'}
                    />,
                  );
                  x = width + 1.5;
                } else if (stat.known > 0) {
                  marks.push(
                    <rect
                      key="zero"
                      data-series={series}
                      data-model={model.name}
                      data-mark="zero"
                      data-tokens="0"
                      x={0}
                      y={y}
                      width={1.5}
                      height={5}
                      fill="currentColor"
                    />,
                  );
                  x = 3;
                }
                if (stat.unknown > 0)
                  marks.push(
                    <path
                      key="unknown"
                      data-series={series}
                      data-model={model.name}
                      data-mark="unknown"
                      data-excluded={String(stat.unknown)}
                      d={diamond(x, y, 5)}
                      fill="none"
                      stroke="currentColor"
                    />,
                  );
                return marks;
              })}
            </svg>
          </li>
        ))}
      </ul>
      {costs.length ? <p data-cost-summary="">{costs.join(' · ')}</p> : null}
      <div className="space-y-1">
        <p>{t('chart.time')}</p>
        <ul className="space-y-1">
          {models.map((model) => (
            <li key={model.name} className="flex flex-wrap items-center gap-2">
              <span className="min-w-32 flex-1">{model.name}</span>
              <svg
                data-chart="time"
                aria-hidden="true"
                viewBox="0 0 100 8"
                className="h-3 min-w-32 flex-1 text-foreground"
              >
                {items
                  .filter((row) => `${row.provider} · ${row.modelId}` === model.name)
                  .map((row) => (
                    <circle
                      key={row.attemptId}
                      data-request={row.attemptId}
                      data-model={model.name}
                      data-at={row.startedAt}
                      cx={xOf(row.startedAt)}
                      cy={4}
                      r={1.6}
                      fill="currentColor"
                    />
                  ))}
              </svg>
            </li>
          ))}
        </ul>
        {earliest !== null && latest !== null ? (
          <p>
            {format.dateTime(new Date(earliest), { dateStyle: 'short', timeStyle: 'short' })}
            {span > 0
              ? ` – ${format.dateTime(new Date(latest), { dateStyle: 'short', timeStyle: 'short' })}`
              : null}
          </p>
        ) : null}
      </div>
    </figure>
  );
}
