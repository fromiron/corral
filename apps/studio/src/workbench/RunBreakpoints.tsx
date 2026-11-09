import type { CorralNode } from '@corral/contracts';
import { Switch } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';

/** The steps a breakpoint can hold: scheduled Agents and Decisions. */
export const breakpointSteps = (nodes: readonly CorralNode[]) =>
  nodes.filter(
    (node) =>
      node.type === 'decision' || (node.type === 'agent' && node.invocation === 'scheduled'),
  );

/** Steps the next run pauses before; this run only, never saved with the team. */
export function RunBreakpoints({
  nodes,
  value,
  onChange,
}: {
  nodes: readonly CorralNode[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const t = useTranslations('Run');
  const steps = breakpointSteps(nodes);
  if (!steps.length) return null;
  const chosen = value.filter((id) => steps.some((step) => step.id === id));
  return (
    <details className="rounded fill-group p-2 text-xs" data-testid="run-breakpoints">
      <summary className="cursor-pointer font-medium">
        {chosen.length ? t('breakpointsCount', { count: chosen.length }) : t('breakpoints')}
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        {steps.map((step) => (
          <Switch
            key={step.id}
            size="compact"
            label={step.label}
            checked={chosen.includes(step.id)}
            onToggle={() =>
              onChange(
                chosen.includes(step.id)
                  ? chosen.filter((id) => id !== step.id)
                  : [...chosen, step.id],
              )
            }
          />
        ))}
      </div>
    </details>
  );
}
