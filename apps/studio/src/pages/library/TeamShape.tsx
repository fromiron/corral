import { cn, useShape } from '@corral/react/design-kit';
import { ArrowRight, Repeat2 } from '@corral/react/icons';
import { useTranslations } from 'use-intl';
import type { TeamShapeRole, TeamShapeStep } from '../../templates.ts';

const NODE = 'flex h-6 items-center border border-border px-2 whitespace-nowrap';
const RAILS =
  "before:absolute before:top-4 before:bottom-4 before:left-0 before:w-px before:bg-border before:content-[''] after:absolute after:top-4 after:right-0 after:bottom-4 after:w-px after:bg-border after:content-['']";
const TICKS =
  "before:absolute before:top-3 before:-left-2.5 before:h-px before:w-2.5 before:bg-border before:content-[''] after:absolute after:top-3 after:-right-2.5 after:h-px after:w-2.5 after:bg-border after:content-['']";

const keyOf = (step: TeamShapeStep): string =>
  step.kind === 'role'
    ? step.name
    : step.kind === 'together'
      ? step.roles.map((role) => role.name).join()
      : `loop:${step.steps.map(keyOf).join()}`;

function Role({ role }: { role: TeamShapeRole }) {
  const t = useTranslations('Workspace');
  const shape = useShape();
  return (
    <div className="grid">
      <span data-shape="role" className={cn(NODE, shape.item, 'bg-card text-foreground')}>
        {role.name}
      </span>
      {role.calls.length ? (
        <ul aria-label={t('templateCalls')} className="grid">
          {role.calls.map((name) => (
            <li key={name} className="grid">
              <span aria-hidden className="ml-3 h-2 w-0 border-l border-dashed border-border" />
              <span
                data-shape="called"
                className={cn(NODE, shape.item, 'border-dashed text-muted-foreground')}
              >
                {name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Steps({ steps }: { steps: TeamShapeStep[] }) {
  const t = useTranslations('Workspace');
  const shape = useShape();
  return steps.map((step, index) => (
    <li key={keyOf(step)} className="flex items-start">
      {index ? (
        <span
          aria-hidden
          className="flex h-8 w-5 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ArrowRight className="size-3" />
        </span>
      ) : null}
      {step.kind === 'role' ? (
        <div className="py-1">
          <Role role={step} />
        </div>
      ) : step.kind === 'together' ? (
        <ul
          aria-label={t('templateTogether')}
          className={cn('relative grid gap-1 px-2.5 py-1', RAILS)}
        >
          {step.roles.map((role) => (
            <li key={role.name} className={cn('relative grid', TICKS)}>
              <Role role={role} />
            </li>
          ))}
        </ul>
      ) : (
        <div
          data-shape="loop"
          className={cn(
            shape.container,
            'flex items-start bg-muted px-1.5 ring-1 ring-border ring-inset',
          )}
        >
          <ol
            aria-label={
              step.rounds === null
                ? t('templateLoopUnlimited')
                : t('templateLoop', { rounds: step.rounds })
            }
            className="flex flex-wrap items-start"
          >
            <Steps steps={step.steps} />
          </ol>
          <span aria-hidden className="flex h-8 items-center gap-0.5 pl-1.5 text-muted-foreground">
            <Repeat2 className="size-3" />
            {step.rounds}
          </span>
        </div>
      )}
    </li>
  ));
}

export function TeamShape({ steps, label }: { steps: TeamShapeStep[]; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-wrap items-start gap-y-1 text-caption">
      <Steps steps={steps} />
    </ol>
  );
}
