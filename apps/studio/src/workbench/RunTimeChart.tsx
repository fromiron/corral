import type { CorralDefinition, RunEvent } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { executionAgentStatus, executionIntervals } from '@corral/react';
import {
  AgentLanes,
  type AgentLanesLabels,
  formatClock,
  type LaneAgent,
  type LaneHandoff,
} from '@corral/react/design-kit';
import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'use-intl';

/**
 * The run's observed time as the kit's swimlanes: one lane per agent node, every execution
 * (each retry and Loop round) its own span on it, waits tinted inside the span, and observed
 * delegations linked. The window runs from the first to the last record, so an unfinished span
 * stops at the last observation and a past view never runs to the present.
 */
export function RunTimeChart({
  events,
  projection,
  definition,
  selected,
  onSelect,
}: {
  events: RunEvent[];
  projection: RunProjection | null;
  definition: CorralDefinition;
  selected: string | undefined;
  onSelect: (executionId: string) => void;
}) {
  const t = useTranslations('RunMonitor');
  const lanesText = useTranslations('RunMonitor.lanes');
  const status = useTranslations('Status');
  const format = useFormatter();
  const rows = useMemo(() => executionIntervals(events), [events]);
  const labels = useMemo<Partial<AgentLanesLabels>>(
    () => ({
      running: (count) => lanesText('running', { count }),
      needsYou: (count) => lanesText('needsYou', { count }),
      needsYouChip: lanesText('needsYouChip'),
      idle: lanesText('idle'),
      window: formatClock,
      tick: (ms) => lanesText('tick', { time: formatClock(ms) }),
      lane: (name) => name,
      timing: (task, now) => formatClock((task.endedAt ?? now) - task.startedAt),
      needsYouLine: (what) => lanesText('needsYouLine', { what }),
      review: lanesText('review'),
      announce: (count) => lanesText('announce', { count }),
    }),
    [lanesText],
  );
  const board = useMemo(() => {
    if (!rows.length) return null;
    const start = Math.min(...rows.map((row) => Date.parse(row.startedAt)));
    const end = Math.max(...rows.map((row) => Date.parse(row.endedAt)));
    const order = [
      ...definition.nodes.map((node) => node.id),
      ...rows.map((row) => row.nodeId),
    ].filter((id, i, all) => all.indexOf(id) === i && rows.some((row) => row.nodeId === id));
    const agents: LaneAgent[] = order.map((nodeId) => {
      const lane = rows.filter((row) => row.nodeId === nodeId);
      const profile = projection?.executions[lane[0]?.executionId ?? '']?.modelProfile;
      const model = profile ? projection?.modelProfiles[profile]?.modelId : undefined;
      return {
        id: nodeId,
        name: definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId,
        ...(model ? { model } : {}),
        tasks: lane.map((row) => {
          const round = row.iterationId ? projection?.iterations[row.iterationId]?.no : null;
          return {
            id: row.executionId,
            label: [
              round ? t('iteration', { number: round }) : null,
              t('attempt', { number: row.attemptNo }),
            ]
              .filter(Boolean)
              .join(' · '),
            status: executionAgentStatus(row.status),
            statusLabel: status.has(row.status) ? status(row.status) : row.status,
            startedAt: Date.parse(row.startedAt),
            endedAt: Date.parse(row.endedAt),
            waits: row.segments
              .filter((segment) => segment.status.startsWith('waiting_'))
              .map((segment) => ({
                startedAt: Date.parse(segment.startedAt),
                endedAt: Date.parse(segment.endedAt),
              })),
            buttonProps: { 'data-execution-id': row.executionId },
          };
        }),
      };
    });
    const known = new Set(rows.map((row) => row.executionId));
    const handoffs: LaneHandoff[] = rows.flatMap((row) => {
      const parent = projection?.executions[row.executionId]?.parentExecutionId;
      return parent && known.has(parent)
        ? [{ from: parent, to: row.executionId, fromAt: Date.parse(row.startedAt) }]
        : [];
    });
    return { start, end, agents, handoffs };
  }, [rows, projection, definition, t, status]);
  if (!board) return <p className="p-3 text-sm text-muted-foreground">{t('noIntervals')}</p>;
  const calls = rows.find((row) => row.executionId === selected)?.calls ?? [];
  const milliseconds = (value: number) =>
    t('milliseconds', { value: format.number(value, { maximumFractionDigits: 0 }) });
  return (
    <section aria-label={t('time')} className="flex h-full flex-col gap-3 overflow-auto p-3">
      <p className="text-caption text-muted-foreground">{t('lifespanNote')}</p>
      <AgentLanes
        agents={board.agents}
        handoffs={board.handoffs}
        startAt={board.start}
        now={board.end}
        title={t('time')}
        selectedTaskId={selected ?? null}
        onSelectTask={onSelect}
        labels={labels}
        size="compact"
      />
      {calls.length ? (
        <ul className="flex min-w-0 flex-wrap gap-x-4 text-caption text-muted-foreground">
          {calls.map((call) => (
            <li key={`${call.kind}:${call.callId}`} className="min-w-0 break-all">
              {t(call.kind)} · {call.callId} · {milliseconds(call.durationMs)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
