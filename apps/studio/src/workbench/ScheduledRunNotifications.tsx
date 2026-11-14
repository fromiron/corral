import { statusPresence, usePresenceWord } from '@corral/react';
import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { automationShownRuns, type ScheduledRunOutcome } from './scheduledRuns.ts';

export function ScheduledRunNotifications({
  results,
  dismiss,
}: {
  results: ScheduledRunOutcome[];
  dismiss(runId: string): void;
}) {
  const t = useTranslations('Schedules');
  const status = usePresenceWord();
  // Automation lists every schedule with its last result, and the chosen one's history: there a
  // banner would say it again. A result the page showed does not come back on the next screen;
  // one it did not show keeps its banner.
  const onAutomation = useRouterState({ select: (s) => s.location.pathname === '/schedules' });
  const shown = useStore(automationShownRuns, (s) => s.runIds);
  useEffect(() => {
    if (!onAutomation) return;
    for (const run of results) if (shown.includes(run.runId)) dismiss(run.runId);
  }, [onAutomation, results, shown, dismiss]);
  if (onAutomation) return null;
  return (
    <div className="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto" aria-live="polite">
      {results.map((run) => (
        <Banner
          key={run.runId}
          status={statusPresence(run.status)?.tone === 'success' ? 'success' : 'warning'}
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
