import type { RunProjection, RunSummary } from '@corral/core';
import { turnSummary } from '@corral/react';
import { useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { formatCount } from './numbers.ts';
import { sessionStats } from './selectors.ts';

/**
 * runs · tool and agent steps · reported in/out tokens · cache hit for the session, under the
 * composer (DSH-style), read from each run's Coordinator snapshot. Each figure is named so it
 * needs no definition. An unreported cache figure is named, never 0.
 */
export function ComposerStats({ runs }: { runs: readonly RunSummary[] }) {
  const t = useTranslations('Turn');
  const format = useFormatter();
  const locale = useLocale();
  const { transport } = useServices();
  const [projections, setProjections] = useState<RunProjection[]>([]);
  // A turn's status change is when its usage settles; nothing polls in between.
  const key = runs.map((run) => `${run.runId}:${run.status}`).join(',');
  useEffect(() => {
    let live = true;
    const ids = key ? key.split(',').map((entry) => entry.split(':')[0] ?? '') : [];
    void Promise.all(
      ids.map((runId) =>
        transport.getSnapshot(runId).then(
          ({ projection }) => projection,
          () => null,
        ),
      ),
    ).then((read) => {
      if (live) setProjections(read.filter((p): p is RunProjection => p !== null));
    });
    return () => {
      live = false;
    };
  }, [transport, key]);
  const stats = sessionStats(projections, (projection) => turnSummary(projection).steps);
  if (!stats) return null;
  const parts = [
    t('statSession'),
    t('statRuns', { count: stats.turns }),
    t('statSteps', { count: stats.steps }),
    t('statTokens', {
      tokens: formatCount(stats.tokens, locale, (value) =>
        format.number(value, { notation: 'compact', maximumFractionDigits: 1 }),
      ),
    }),
    stats.cacheShare === null
      ? t('statCacheUnreported')
      : t('statCache', { share: format.number(stats.cacheShare, { style: 'percent' }) }),
  ];
  // Every figure stays, each kept whole: a narrow composer breaks the line between figures,
  // never inside one. Each figure carries the separator before it in a fixed slot; the row is
  // pulled left by that slot and clipped, so a wrapped line starts with a figure, not a "·".
  return (
    <p data-testid="composer-stats" className="min-w-0 overflow-hidden tabular-nums">
      <span className="-ml-2.5 flex flex-wrap">
        {parts.map((part, index) => (
          <span key={part} data-stat className="whitespace-nowrap">
            <span className="inline-block w-2.5 text-center">{index ? ' · ' : ''}</span>
            {part}
          </span>
        ))}
      </span>
    </p>
  );
}
