import { Link } from '@tanstack/react-router';
import { type ReactNode, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { useModelProfiles } from '../workbench/useModels.ts';

// Roadmap 17: the first steps, checked off from what has actually happened. Kept in browser
// storage only for the viewer's conveniences: "hidden" and "a run page was read".

const HIDDEN = 'corral.gettingStarted.hidden';
const REVIEWED = 'corral.gettingStarted.reviewed';

function stored(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}
function store(key: string) {
  try {
    globalThis.localStorage?.setItem(key, '1');
  } catch {
    // Without storage the list just shows again next time.
  }
}

/** Called by the Run page: reading a run's result is the last step. */
export function markRunReviewed() {
  store(REVIEWED);
}

export function GettingStarted({ runs, projectId }: { runs: number; projectId: string }) {
  const t = useTranslations('GettingStarted');
  const navigation = useSettingsNavigation();
  const headingId = useId();
  const { mode, live, models } = useServices();
  const [hidden, setHidden] = useState(() => stored(HIDDEN));
  const profiles = useModelProfiles();
  const needsModel = mode === 'server' && live && models !== null;

  const steps: { id: string; done: boolean; title: string; action: ReactNode }[] = [
    ...(needsModel
      ? [
          {
            id: 'model',
            done: Boolean(profiles?.some((profile) => profile.available)),
            title: t('model'),
            action: (
              <Link to="/settings/models" search={navigation.search} className="underline">
                {t('modelAction')}
              </Link>
            ),
          },
        ]
      : []),
    { id: 'run', done: runs > 0, title: t('run'), action: t('runAction') },
    { id: 'review', done: stored(REVIEWED), title: t('review'), action: t('reviewAction') },
  ];
  if (hidden || steps.every((s) => s.done)) return null;
  const current = steps.find((s) => !s.done)?.id;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-md fill-group p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold">
          {t('heading')}
        </h2>
        <button
          type="button"
          onClick={() => {
            store(HIDDEN);
            setHidden(true);
          }}
          className="rounded fill-control px-2 py-0.5 text-xs"
        >
          {t('hide')}
        </button>
      </div>
      <ol className="flex flex-col gap-1 text-sm">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-testid={`step-${step.id}`}
            data-done={step.done}
            aria-current={step.id === current ? 'step' : undefined}
            className={`flex flex-wrap items-baseline gap-x-2 ${step.done ? 'text-muted' : ''}`}
          >
            <span aria-hidden="true" className={step.done ? 'text-success' : 'text-muted'}>
              {step.done ? '✓' : `${index + 1}.`}
            </span>
            <span className={step.id === current ? 'font-medium' : ''}>
              {step.title}
              <span className="sr-only">{step.done ? ` (${t('done')})` : ''}</span>
            </span>
            {step.done ? null : <span className="text-xs text-muted">{step.action}</span>}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">
        {t('optionalCorral')}{' '}
        <Link to="/projects/$projectId" params={{ projectId }} hash="corrals" className="underline">
          {t('customizeCorral')}
        </Link>
      </p>
    </section>
  );
}
