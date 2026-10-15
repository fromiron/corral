import type { RunSessionStore } from '@corral/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { type GuideStepState, guideSteps } from './guide.ts';

const MARK: Record<GuideStepState, string> = {
  done: '✓',
  current: '→',
  pending: '○',
  missed: '–',
};

const TONE: Record<GuideStepState, string> = {
  done: 'text-success',
  current: 'font-medium text-text',
  pending: 'text-muted',
  missed: 'text-muted line-through decoration-muted/60',
};

/**
 * What to look for in the demo team's run (C-064). Steps follow the committed projection of
 * the run of this Corral; a run of another Corral in the same session does not count.
 */
export function DemoGuide({
  session,
  corralId,
  onSteer,
}: {
  session: RunSessionStore;
  corralId: string;
  onSteer: (executionId: string) => void;
}) {
  const t = useTranslations('Demo.guide');
  const projection = useStore(session, (s) =>
    s.definition?.id === corralId ? s.projection : null,
  );
  const steps = useMemo(() => guideSteps(projection), [projection]);
  const target = steps.find((s) => s.id === 'steer')?.steerTarget ?? null;
  const status = projection?.status ?? null;
  // Opt-in: pause through the normal run command once the round 2 Writer starts, so there is
  // time to write an instruction before its next request. The pause is the visitor's choice.
  const [armed, setArmed] = useState(false);
  const pausedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!armed || !target || status !== 'running' || pausedFor.current === target) return;
    pausedFor.current = target;
    setArmed(false);
    onSteer(target);
    void session
      .getState()
      .sendCommand({ type: 'pause', payload: { scope: 'run' } })
      .catch(() => undefined);
  }, [armed, target, status, session, onSteer]);
  return (
    <section
      aria-labelledby="demo-guide-heading"
      className="rounded-md border border-line bg-raised p-3 text-xs"
    >
      <details open>
        <summary className="cursor-pointer">
          <h2 id="demo-guide-heading" className="inline text-sm font-semibold">
            {t('heading')}
          </h2>
        </summary>
        <p className="mt-1 text-muted">{t('intro')}</p>
        <ol className="mt-2 flex flex-col gap-1.5">
          {steps.map((step) => (
            <li
              key={step.id}
              data-step={step.id}
              data-state={step.state}
              aria-current={step.state === 'current' ? 'step' : undefined}
              className="flex gap-2"
            >
              <span aria-hidden="true" className={`w-3 shrink-0 ${TONE[step.state]}`}>
                {MARK[step.state]}
              </span>
              <span className="flex flex-col gap-1">
                <span className={TONE[step.state]}>{t(`steps.${step.id}`)}</span>
                <span className="text-muted">{t(`state.${step.state}`)}</span>
                {step.id === 'steer' &&
                (step.state === 'pending' ||
                  (step.state === 'current' && pausedFor.current !== target)) ? (
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={armed}
                      onChange={(event) => setArmed(event.target.checked)}
                    />
                    {t('pauseAtRound2')}
                  </label>
                ) : null}
                {step.steerTarget ? (
                  <button
                    type="button"
                    onClick={() => onSteer(step.steerTarget as string)}
                    className="self-start rounded border border-accent px-2 py-0.5 text-accent"
                  >
                    {t('steerAction')}
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
