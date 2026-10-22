import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from './navigation.ts';

type Step = 'personal' | 'project' | 'role' | 'run';
const STEPS: Step[] = ['personal', 'project', 'role', 'run'];

/**
 * Where a run's work style comes from, in order, with the step being edited marked (#88).
 * Each default screen names every layer so neither has to explain only part of the chain.
 */
export function ScopeLadder({ current }: { current: 'personal' | 'project' }) {
  const t = useTranslations('Harness');
  const navigation = useSettingsNavigation();
  const title = useId();
  const link = (step: Step) =>
    step === 'personal'
      ? navigation.link('defaults')
      : step === 'project' && navigation.projectId
        ? navigation.link('project-defaults', navigation.projectId)
        : null;
  return (
    <section className="flex flex-col gap-2">
      <h3 id={title} className="text-sm font-semibold">
        {t('ladderTitle')}
      </h3>
      <ol aria-labelledby={title} className="grid gap-2 sm:grid-cols-4">
        {STEPS.map((step, index) => {
          const here = step === current;
          const target = here ? null : link(step);
          return (
            <li
              key={step}
              aria-current={here ? 'step' : undefined}
              className={`flex flex-col gap-1 rounded-lg p-3 text-xs ${here ? 'bg-raised shadow-sm' : 'fill-group'}`}
            >
              <span className="text-2xs text-muted">{index + 1}</span>
              <h4 className="text-sm font-medium">
                {target ? (
                  <Link {...target} className="text-accent underline">
                    {t(`ladder.${step}`)}
                  </Link>
                ) : (
                  t(`ladder.${step}`)
                )}
              </h4>
              <p className="text-muted">{t(`ladder.${step}Hint`)}</p>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">{t('ladderRule')}</p>
    </section>
  );
}
