import { fontWeights } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useId } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from './navigation.ts';

type Step = 'personal' | 'project' | 'role' | 'run';
const STEPS: Step[] = ['personal', 'project', 'role', 'run'];

/**
 * Where a run's work style comes from, in order (#88). The row being edited holds its own
 * control, so each default screen names every layer once and neither explains part of the chain.
 */
export function ScopeLadder({
  current,
  children,
}: {
  current: 'personal' | 'project';
  children?: ReactNode;
}) {
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
      <h3
        id={title}
        className="text-subtitle"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {t('ladderTitle')}
      </h3>
      <ol aria-labelledby={title} className="settings-list divide-y divide-line">
        {STEPS.map((step, index) => {
          const here = step === current;
          const target = here ? null : link(step);
          return (
            <li
              key={step}
              aria-current={here ? 'step' : undefined}
              className="grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[1rem_minmax(0,1fr)_auto]"
            >
              <span className="self-start text-caption text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <h4 style={here ? { fontVariationSettings: fontWeights.semibold } : undefined}>
                  {target ? (
                    <Link {...target} className="text-primary underline">
                      {t(`ladder.${step}`)}
                    </Link>
                  ) : (
                    t(`ladder.${step}`)
                  )}
                </h4>
                <p className="text-caption text-muted-foreground">{t(`ladder.${step}Hint`)}</p>
              </div>
              {here && children ? (
                <div className="col-start-2 min-w-0 sm:col-start-3">{children}</div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="text-caption text-muted-foreground">{t('ladderRule')}</p>
    </section>
  );
}
