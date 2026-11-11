import { KitBadge } from '@corral/react/design-kit';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { SAMPLE_SESSIONS, type SampleRun } from './fixture.ts';
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
