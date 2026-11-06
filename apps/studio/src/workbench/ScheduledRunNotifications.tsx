import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { ScheduledRunOutcome } from './scheduledRuns.ts';

export function ScheduledRunNotifications({
  results,
  dismiss,
}: {
  results: ScheduledRunOutcome[];
  dismiss(runId: string): void;
}) {
  const t = useTranslations('Schedules');
  const status = useTranslations('Status');
  return (
    <div className="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto" aria-live="polite">
      {results.map((run) => (
        <Banner
          key={run.runId}
          status={run.status === 'succeeded' ? 'success' : 'warning'}
          size="compact"
          role="note"
        >
          <BannerTitle>{t('result', { status: status(run.status) })}</BannerTitle>
          <BannerActions>
            <Button
              variant="ghost"
              size="compact"
              render={
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: run.sessionId }}
                  search={{ panel: 'run', view: 'run', run: run.runId }}
                />
              }
            >
              {t('openRun')}
            </Button>
            <Button variant="ghost" size="compact" onClick={() => dismiss(run.runId)}>
              {t('dismiss')}
            </Button>
          </BannerActions>
        </Banner>
      ))}
    </div>
  );
}
