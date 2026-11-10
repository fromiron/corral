import type { RunProjection, RunSummary } from '@corral/core';
import { turnSummary } from '@corral/react';
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { sessionStats } from './selectors.ts';

/**
 * turns · steps · tokens · cache hit for the session, under the composer (DSH-style),
 * read from each turn's Coordinator snapshot. An unreported cache figure is named, never 0.
 */
export function ComposerStats({ runs }: { runs: readonly RunSummary[] }) {
  const t = useTranslations('Turn');
  const format = useFormatter();
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
  // Least needed last: a narrow composer gives up the cache share, then the tokens.
  const parts = [
    { text: t('statTurns', { count: stats.turns }), keep: '' },
    { text: t('statSteps', { count: stats.steps }), keep: '' },
    {
      text: t('statTokens', {
        tokens: format.number(stats.tokens, { notation: 'compact', maximumFractionDigits: 1 }),
      }),
      keep: '@max-2xs/composer-surface:hidden',
    },
    {
      text:
        stats.cacheShare === null
          ? t('statCacheUnreported')
          : t('statCache', { share: format.number(stats.cacheShare, { style: 'percent' }) }),
      keep: '@max-md/composer-surface:hidden',
    },
  ];
  return (
    <details data-testid="composer-stats" className="min-w-0 tabular-nums">
      <summary className="cursor-pointer whitespace-nowrap">
        {t('statSession')}
        {parts.map((part) => (
          <span key={part.text} className={part.keep}>
            {' · '}
            {part.text}
          </span>
        ))}
      </summary>
      <p className="mt-1 max-w-prose text-muted-foreground">{t('statDefinition')}</p>
    </details>
  );
}
