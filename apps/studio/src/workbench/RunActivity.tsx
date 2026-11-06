import {
  type CorralDefinition,
  type ExecutionStatus,
  type RunEvent,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import {
  ExecutionToolGroup,
  executionAgentStatus,
  executionIntervals,
  executionToolEntries,
  runAgentStatus,
} from '@corral/react';
import {
  AgentCard,
  AgentIdentity,
  AgentStatusIcon,
  AgentStatusLabel,
  AgentSteeringPlan,
  cn,
  formatClock,
} from '@corral/react/design-kit';
import { useMemo } from 'react';
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
 * The top of the run column (the kit's AgentRun plan card): the work plan when the planning tool
 * recorded one, otherwise one line per agent node with its latest execution's state and time.
 */
export function RunSummaryCard({
  events,
  projection,
  definition,
  plan,
}: {
  events: readonly RunEvent[];
  projection: RunProjection;
  definition: CorralDefinition;
  plan: { items: readonly PlanItem[] } | null;
}) {
  const t = useTranslations('RunMonitor');
  const tw = useTranslations('Widgets');
  const statusText = useStatusText();
  const durations = useIntervals(events);
  const live = !TERMINAL_RUN_STATUSES.has(projection.status);
  if (plan?.items.length) {
    const done = plan.items.filter((item) => item.status === 'completed').length;
    return (
      <AgentCard data-testid="run-summary-card" className="grid gap-2 p-4">
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
  const latest = new Map<string, RunProjection['executions'][string]>();
  for (const id of projection.executionOrder) {
    const execution = projection.executions[id];
    if (execution) latest.set(execution.nodeId, execution);
  }
  const nodes = [
    ...definition.nodes.map((node) => node.id).filter((id) => latest.has(id)),
    ...[...latest.keys()].filter((id) => !definition.nodes.some((node) => node.id === id)),
  ];
  if (!nodes.length) return null;
  return (
    <AgentCard data-testid="run-summary-card" className="grid gap-3 p-4">
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <AgentStatusIcon status={runAgentStatus(projection.status)} size={12} />
        <span>{t('agentsSummary', { count: nodes.length })}</span>
      </p>
      <ul className="m-0 grid list-none gap-2 p-0">
        {nodes.map((nodeId) => {
          const execution = latest.get(nodeId);
          if (!execution) return null;
          const profile = projection.modelProfiles?.[execution.modelProfile];
          const elapsed = durations.get(execution.executionId);
          return (
            <li key={nodeId} data-summary-node={nodeId}>
              <AgentIdentity
                name={definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId}
                model={profile?.modelId ?? execution.modelProfile}
                trailing={
                  <span className="ml-auto inline-flex items-center gap-2">
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
                }
              />
            </li>
          );
        })}
      </ul>
    </AgentCard>
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
                'flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-body transition-colors duration-80 hover:bg-hover',
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
              <span className="min-w-0 truncate font-medium">{label}</span>
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
                <ExecutionToolGroup
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
