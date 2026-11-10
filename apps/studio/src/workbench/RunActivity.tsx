import {
  type CorralDefinition,
  type ExecutionStatus,
  type RunEvent,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import {
  ExecutionToolRows,
  executionAgentStatus,
  executionIntervals,
  executionToolEntries,
  runAgentStatus,
} from '@corral/react';
import {
  AgentCard,
  AgentStatusIcon,
  AgentStatusLabel,
  AgentSteeringPlan,
  cn,
  fontWeights,
  formatClock,
} from '@corral/react/design-kit';
import { ChevronRight } from '@corral/react/icons';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';

type PlanItem = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' };

/** Observed start and end of every execution, from the record (never the wall clock). */
function useIntervals(events: readonly RunEvent[]) {
  return useMemo(
    () =>
      new Map(
        executionIntervals(events as RunEvent[]).map((row) => [
          row.executionId,
          Date.parse(row.endedAt) - Date.parse(row.startedAt),
        ]),
      ),
    [events],
  );
}

function useStatusText() {
  const status = useTranslations('Status');
  return (value: string) => (status.has(value) ? status(value) : value);
}

/**
 * The kit's AgentRun plan card, shown only when the planning tool recorded a work plan. Without
 * one there is no card: the activity heads already give each execution's state.
 */
export function RunPlanCard({
  projection,
  plan,
}: {
  projection: RunProjection;
  plan: { items: readonly PlanItem[] } | null;
}) {
  const tw = useTranslations('Widgets');
  if (!plan?.items.length) return null;
  const live = !TERMINAL_RUN_STATUSES.has(projection.status);
  const done = plan.items.filter((item) => item.status === 'completed').length;
  return (
    <AgentCard data-testid="run-plan-card" className="grid gap-2 p-4">
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <AgentStatusIcon status={runAgentStatus(projection.status)} size={12} />
        <span>{tw('planHeading')}</span>
        <span className="ml-auto tabular-nums">
          {tw('planCount', { done, total: plan.items.length })}
        </span>
      </p>
      <AgentSteeringPlan
        steps={plan.items.map((item) => ({
          id: item.id,
          title: item.title,
          status:
            item.status === 'completed'
              ? 'done'
              : item.status === 'in_progress'
                ? 'active'
                : 'pending',
        }))}
        status={live ? 'running' : 'waiting'}
        labels={{ plan: tw('planHeading') }}
        statusLabel={(state) =>
          tw(state === 'done' ? 'completed' : state === 'active' ? 'in_progress' : 'pending')
        }
        wrapTitles
      />
    </AgentCard>
  );
}

/**
 * The work plan as one folded line above the work flow: progress and the step in hand. Opening it
 * shows the full plan, or every plan when several were recorded. Without a plan there is no line.
 */
export function RunPlanStrip({
  projection,
  plan,
  planCount,
  allPlans,
}: {
  projection: RunProjection;
  plan: { items: readonly PlanItem[] } | null;
  planCount: number;
  allPlans: ReactNode;
}) {
  const tw = useTranslations('Widgets');
  const tm = useTranslations('RunMonitor');
  const [open, setOpen] = useState(false);
  const items = plan?.items ?? [];
  if (!items.length && planCount < 2) return null;
  const several = planCount > 1;
  const done = items.filter((item) => item.status === 'completed').length;
  const current =
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending');
  return (
    <div className="grid gap-2" data-testid="run-plan-strip">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-hover"
      >
        <ChevronRight
          aria-hidden
          size={14}
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <AgentStatusIcon status={runAgentStatus(projection.status)} size={12} />
        <span className="shrink-0 text-foreground">
          {several ? tm('planCount', { count: planCount }) : tw('planHeading')}
        </span>
        {items.length ? (
          <span className="shrink-0 tabular-nums">
            {tw('planCount', { done, total: items.length })}
          </span>
        ) : null}
        {current ? <span className="min-w-0 truncate">· {current.title}</span> : null}
      </button>
      {open ? several ? allPlans : <RunPlanCard projection={projection} plan={plan} /> : null}
    </div>
  );
}

/**
 * Every execution in start order, as the kit's AgentRun activity: a head naming the node, its
 * attempt and round, state and observed time (selecting it opens its details), then the
 * execution's own tool calls as a kit tool-call group.
 */
export function RunActivity({
  events,
  projection,
  definition,
  selected,
  onSelect,
  onOpenArtifact,
}: {
  events: readonly RunEvent[];
  projection: RunProjection;
  definition: CorralDefinition;
  selected: string | undefined;
  onSelect: (executionId: string) => void;
  onOpenArtifact?: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('RunMonitor');
  const statusText = useStatusText();
  const tools = useMemo(() => executionToolEntries(events as RunEvent[]), [events]);
  const durations = useIntervals(events);
  const runEnded = TERMINAL_RUN_STATUSES.has(projection.status);
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  return (
    <section data-testid="run-activity" aria-label={t('activity')} className="grid gap-4">
      {executions.map((execution, index) => {
        const label =
          definition.nodes.find((node) => node.id === execution.nodeId)?.label ?? execution.nodeId;
        const round = execution.iterationId
          ? projection.iterations[execution.iterationId]?.no
          : null;
        const own = tools.get(execution.executionId) ?? [];
        const elapsed = durations.get(execution.executionId);
        const active = selected === execution.executionId;
        return (
          <div key={execution.executionId} data-activity-entry className="grid gap-1.5">
            <button
              type="button"
              data-execution-id={execution.executionId}
              aria-pressed={active}
              onClick={() => onSelect(execution.executionId)}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-body transition-colors duration-(--duration-fast) hover:bg-hover',
                'focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:outline-offset-2',
                active && 'bg-active',
              )}
            >
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-full border border-border text-micro tabular-nums text-muted-foreground"
              >
                {index + 1}
              </span>
              <span
                className="min-w-0 truncate"
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {label}
              </span>
              <span className="shrink-0 text-caption text-muted-foreground">
                {[
                  round ? t('iteration', { number: round }) : null,
                  t('attempt', { number: execution.attemptNo }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-2">
                <AgentStatusLabel
                  status={executionAgentStatus(execution.status)}
                  label={statusText(execution.status)}
                />
                {elapsed !== undefined ? (
                  <span className="text-caption text-muted-foreground tabular-nums">
                    {formatClock(elapsed)}
                  </span>
                ) : null}
              </span>
            </button>
            {own.length ? (
              <div className="pl-8">
                <ExecutionToolRows
                  tools={own}
                  {...(onOpenArtifact ? { onOpenArtifact } : {})}
                  {...toolState(execution.status, runEnded, statusText)}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/**
 * Unfinished calls of an execution that is not working any more are not animated as running:
 * they wait while the execution waits, and are stopped once it or the run has ended.
 */
function toolState(
  status: ExecutionStatus,
  runEnded: boolean,
  statusText: (value: string) => string,
): { activityState?: { status: 'waiting' | 'stopped'; label: string } } {
  if (status === 'active' && !runEnded) return {};
  return {
    activityState: {
      status: runEnded || TERMINAL_EXECUTION_STATUSES.has(status) ? 'stopped' : 'waiting',
      label: statusText(status),
    },
  };
}
