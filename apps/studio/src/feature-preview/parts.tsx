import { KitBadge, useNow } from '@corral/react/design-kit';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { PREVIEW_NOW, SAMPLE_SESSIONS, type SampleRun } from './fixture.ts';
import { useSample } from './labels.ts';

/** The mark on every result a person's action produced in a preview. */
export function Simulated({ children }: { children?: ReactNode }) {
  const t = useTranslations('FeaturePreview');
  return (
    <KitBadge variant="dot" color="blue" size="compact" data-simulated="">
      {children ?? t('simulated')}
    </KitBadge>
  );
}

/** One action's result, marked as simulated. */
export function SimulatedResult({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-2 text-body text-foreground">
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      <Simulated />
    </p>
  );
}

/** "Fix the checkout total · Run 3": the sample session and run behind a piece of work. */
export function useRunName() {
  const t = useTranslations('FeaturePreview.pull');
  const say = useSample();
  return (linked: SampleRun) =>
    t('session', { title: say(SAMPLE_SESSIONS[linked.session].title), run: linked.run });
}

/**
 * Places a sample instant on the clock kit parts count from (useNow, epoch ms): the flow opens at
 * the fixed reference time and runs on from there, so a live sample run reads as it did at that
 * moment and keeps counting. It never ticks itself; Reset remounts the flow and starts it again.
 */
export function usePreviewClock() {
  const opened = useNow(1000, false);
  return (sampleAt: number) => opened + (sampleAt - PREVIEW_NOW);
}
