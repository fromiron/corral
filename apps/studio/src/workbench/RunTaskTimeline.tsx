import {
  type CorralDefinition,
  type RunEvent,
  type TaskStatus,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { executionIntervals } from '@corral/react';
import { type AgentStatus, type PlanStep, PlanVsActual } from '@corral/react/design-kit';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';

/** Where a task stands on the board; an unfinished task of an ended run is stopped, not running. */
function taskAgentStatus(status: TaskStatus, live: boolean): AgentStatus {
  if (status === 'queued') return 'queued';
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled' || !live) return 'stopped';
  return status === 'blocked' ? 'waiting' : 'running';
}

/**
 * The run's tasks (the task board's) as the kit's plan-vs-actual board with actuals only: each
 * task runs from its first assigned attempt to its completion. Corral records no planned time,
 * so the board shows no plan bars, ETA, verdict or legend.
 */
export function RunTaskTimeline({
  events,
  projection,
  definition,
  selected,
  onSelect,
}: {
  events: RunEvent[];
  projection: RunProjection | null;
  definition: CorralDefinition;
  /** The selected execution; its task is outlined. */
  selected?: string | undefined;
  /** Opens a task's latest attempt, the one its result came from. */
  onSelect?: (executionId: string) => void;
}) {
  const t = useTranslations('RunMonitor.taskTimeline');
  const status = useTranslations('Status');
  const live = projection ? !TERMINAL_RUN_STATUSES.has(projection.status) : false;
  // Waiting for the person or paused, the axis stops at the last record, as the agent lanes do.
  const held = projection?.status === 'awaiting_user' || projection?.status === 'paused';
  const board = useMemo(() => {
    if (!projection || !events.length) return null;
    const first = events[0];
    const last = events.at(-1);
    if (!first || !last) return null;
    const startedAt = Date.parse(first.recordedAt);
    const lastAt = Date.parse(last.recordedAt);
    const executionEnds = new Map(
      executionIntervals(events).map((row) => [row.executionId, Date.parse(row.endedAt)]),
    );
    const order: string[] = [];
    const started = new Map<string, number>();
    const attempts = new Map<string, string>();
    const completed = new Map<string, number>();
    for (const event of events) {
      const at = Date.parse(event.recordedAt);
      if (event.type === 'task.created') order.push(event.payload.taskId);
      if (event.type === 'task.attempt_assigned') {
        if (!started.has(event.payload.taskId)) started.set(event.payload.taskId, at);
        attempts.set(event.payload.taskId, event.payload.executionId);
      }
      if (event.type === 'task.completed') completed.set(event.payload.taskId, at);
    }
    const steps = order.flatMap((taskId): PlanStep[] => {
      const task = projection.tasks[taskId];
      if (!task) return [];
      const state = taskAgentStatus(task.status, live);
      const begin = started.get(taskId);
      const lastAttempt = attempts.get(taskId);
      const finish =
        completed.get(taskId) ??
        (state === 'failed' || state === 'stopped'
          ? ((lastAttempt ? executionEnds.get(lastAttempt) : undefined) ?? lastAt)
          : undefined);
      const node = definition.nodes.find((entry) => entry.id === task.nodeId)?.label ?? task.nodeId;
      const submitted = [
        ...new Set(
          task.submittedArtifactVersionIds.map((id) => projection.artifacts[id]?.name ?? id),
        ),
      ];
      return [
        {
          id: taskId,
          label: submitted.length ? `${node} · ${submitted.join(', ')}` : node,
          status: state,
          statusLabel: status.has(task.status) ? status(task.status) : task.status,
          ...(begin !== undefined && state !== 'queued' ? { start: begin - startedAt } : {}),
          ...(begin !== undefined && finish !== undefined ? { end: finish - startedAt } : {}),
          rowProps: { 'data-task-id': taskId },
        },
      ];
    });
    return { steps, startedAt, lastAt, attempts };
  }, [events, projection, definition, live, status]);
  if (!board?.steps.length)
    return <p className="p-3 text-body text-muted-foreground">{t('empty')}</p>;
  return (
    <section aria-label={t('title')} className="flex flex-col gap-3 p-3">
      <PlanVsActual
        // The title only names the board's list: the By task tab shows the view's name and the
        // run header the elapsed time, so the kit's header stays hidden, as the lanes' does.
        title={t('title')}
        className="[&>header]:hidden"
        steps={board.steps}
        startedAt={board.startedAt}
        {...(live && !held ? {} : { now: board.lastAt })}
        selectedStepId={selected ? (projection?.executions[selected]?.taskId ?? null) : null}
        {...(onSelect
          ? {
              onSelectStep: (taskId: string) => {
                const attempt = board.attempts.get(taskId);
                if (attempt) onSelect(attempt);
              },
            }
          : {})}
        labels={{
          step: t('step'),
          time: t('time'),
          actualStep: (step, took) =>
            took === null
              ? t('rowWaiting', { label: step.label, status: step.statusLabel ?? step.status })
              : t('row', { label: step.label, status: step.statusLabel ?? step.status, took }),
        }}
      />
    </section>
  );
}
