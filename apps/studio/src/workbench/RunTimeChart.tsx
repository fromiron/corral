import {
  type CorralDefinition,
  type RunEvent,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { executionAgentStatus, executionIntervals, executionToolEntries } from '@corral/react';
import {
  AgentLanes,
  type AgentLanesLabels,
  Button,
  formatClock,
  type LaneAgent,
  type LaneHandoff,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  useNow,
} from '@corral/react/design-kit';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { RunTaskTimeline } from './RunTaskTimeline.tsx';
import { toolMarks } from './toolMarks.ts';

/** A replay draws the whole record in this long, however long the run took. */
const REPLAY_MS = 4000;

const REDUCED = '(prefers-reduced-motion: reduce)';
/** Whether the person asked for less motion; a host without media queries counts as no. */
function useReducedMotion() {
  return useSyncExternalStore(
    (change) => {
      const query = window.matchMedia?.(REDUCED);
      query?.addEventListener('change', change);
      return () => query?.removeEventListener('change', change);
    },
    () => window.matchMedia?.(REDUCED).matches ?? false,
    () => false,
  );
}

interface TimeChartProps {
  events: RunEvent[];
  projection: RunProjection | null;
  definition: CorralDefinition;
  selected: string | undefined;
  onSelect: (executionId: string) => void;
}

/** The run's observed time, by agent (swimlanes of executions) or by task (actual intervals). */
export function RunTimeChart(props: TimeChartProps) {
  const t = useTranslations('RunMonitor');
  const [view, setView] = useState('agents');
  return (
    <Tabs value={view} onValueChange={setView}>
      <div className="px-3 pt-3">
        <TabsList aria-label={t('timeViews')}>
          <TabItem value="agents" label={t('byAgent')} />
          <TabItem value="tasks" label={t('byTask')} />
        </TabsList>
      </div>
      <TabPanel value="agents">
        <AgentTimeline {...props} />
      </TabPanel>
      <TabPanel value="tasks">
        <RunTaskTimeline
          events={props.events}
          projection={props.projection}
          definition={props.definition}
        />
      </TabPanel>
    </Tabs>
  );
}

/**
 * The run's observed time as the kit's swimlanes: one lane per agent node, every execution
 * (each retry and Loop round) its own span named by what it created and marked with the tools
 * it used, waits tinted inside the span, and observed delegations linked. While the run is live
 * the open spans grow to the present; once it ended the window stops at the last record, and a
 * replay draws the record again from its start over the same window.
 */
function AgentTimeline({ events, projection, definition, selected, onSelect }: TimeChartProps) {
  const t = useTranslations('RunMonitor');
  const lanesText = useTranslations('RunMonitor.lanes');
  const status = useTranslations('Status');
  const format = useFormatter();
  const reduce = useReducedMotion();
  const live = projection ? !TERMINAL_RUN_STATUSES.has(projection.status) : false;
  const clock = useNow(1000, live);
  const rows = useMemo(() => executionIntervals(events), [events]);
  const tools = useMemo(() => executionToolEntries(events), [events]);
  const { created, authors } = useMemo(() => {
    const names = new Map<string, string[]>();
    const authors = new Map<string, { executionId: string; at: number }>();
    for (const event of events) {
      if (event.type !== 'artifact.version_created') continue;
      const own = names.get(event.payload.authorExecutionId) ?? [];
      if (!own.includes(event.payload.name)) own.push(event.payload.name);
      names.set(event.payload.authorExecutionId, own);
      authors.set(event.payload.artifactVersionId, {
        executionId: event.payload.authorExecutionId,
        at: Date.parse(event.recordedAt),
      });
    }
    return { created: names, authors };
  }, [events]);
  const labels = useMemo<Partial<AgentLanesLabels>>(
    () => ({
      running: (count) => lanesText('running', { count }),
      needsYou: (count) => lanesText('needsYou', { count }),
      needsYouChip: lanesText('needsYouChip'),
      // Every lane of an ended run is idle; saying so on each would be noise.
      idle: live ? lanesText('idle') : '',
      now: lanesText('now'),
      window: formatClock,
      tick: (ms) => lanesText('tick', { time: formatClock(ms) }),
      lane: (name) => name,
      timing: (task, now) => formatClock((task.endedAt ?? now) - task.startedAt),
      needsYouLine: (what) => lanesText('needsYouLine', { what }),
      review: lanesText('review'),
      announce: (count) => lanesText('announce', { count }),
    }),
    [lanesText, live],
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
      const name = definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
      const profile = projection?.executions[lane[0]?.executionId ?? '']?.modelProfile;
      const model = profile ? (projection?.modelProfiles[profile]?.modelId ?? profile) : undefined;
      return {
        id: nodeId,
        name,
        ...(model ? { model } : {}),
        tasks: lane.map((row) => {
          const round = row.iterationId ? projection?.iterations[row.iterationId]?.no : null;
          const used = [...new Set((tools.get(row.executionId) ?? []).map((tool) => tool.name))];
          const marks = toolMarks(used).slice(0, 3);
          const state = executionAgentStatus(row.status);
          const statusLabel = status.has(row.status) ? status(row.status) : row.status;
          const open = live && !TERMINAL_EXECUTION_STATUSES.has(row.status);
          return {
            id: row.executionId,
            label: [
              round ? t('iteration', { number: round }) : null,
              created.get(row.executionId)?.join(', ') || name,
              row.attemptNo > 1 ? t('attempt', { number: row.attemptNo }) : null,
            ]
              .filter(Boolean)
              .join(' · '),
            status: state,
            statusLabel,
            startedAt: Date.parse(row.startedAt),
            ...(open ? {} : { endedAt: Date.parse(row.endedAt) }),
            ...(marks.length ? { tools: marks } : {}),
            ...(used.length ? { details: used } : {}),
            ...(state === 'waiting' ? { ask: { title: statusLabel } } : {}),
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
    // Work handed over: an artifact runs from its creation on the author's span to the moment
    // another execution read it or put it in its model input, once per pair of executions.
    const linked = new Set(handoffs.map((link) => `${link.from}>${link.to}`));
    for (const use of artifactUses(events)) {
      const source = authors.get(use.versionId);
      if (!source || source.executionId === use.executionId) continue;
      if (!known.has(source.executionId) || !known.has(use.executionId)) continue;
      const key = `${source.executionId}>${use.executionId}`;
      if (linked.has(key)) continue;
      linked.add(key);
      handoffs.push({
        from: source.executionId,
        to: use.executionId,
        fromAt: source.at,
        toAt: use.at,
      });
    }
    return { start, end, agents, handoffs };
  }, [rows, tools, created, authors, events, projection, definition, live, t, status]);

  // The replay position, 0..1 of the record, or null when the board shows the record as is.
  const [replay, setReplay] = useState<number | null>(null);
  const replaying = replay !== null;
  useEffect(() => {
    if (!replaying) return;
    let frame = 0;
    let first: number | null = null;
    const step = (at: number) => {
      first ??= at;
      const progress = (at - first) / REPLAY_MS;
      if (progress >= 1) return setReplay(null);
      setReplay(progress);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [replaying]);
  useEffect(() => {
    if (live || reduce) setReplay(null);
  }, [live, reduce]);

  const shown = useMemo(() => {
    if (!board || replay === null) return board;
    const cutoff = board.start + (board.end - board.start) * replay;
    const agents = board.agents.map((agent) => ({
      ...agent,
      tasks: agent.tasks.flatMap((task) => {
        if (task.startedAt > cutoff) return [];
        if ((task.endedAt ?? board.end) <= cutoff) return [task];
        const { endedAt: _ended, ask: _ask, ...growing } = task;
        return [
          {
            ...growing,
            status: 'running' as const,
            waits: (task.waits ?? [])
              .filter((wait) => wait.startedAt < cutoff)
              .map((wait) => ({ ...wait, endedAt: Math.min(wait.endedAt, cutoff) })),
          },
        ];
      }),
    }));
    const visible = new Set(agents.flatMap((agent) => agent.tasks.map((task) => task.id)));
    return {
      ...board,
      agents,
      handoffs: board.handoffs.filter((link) => visible.has(link.from) && visible.has(link.to)),
      cutoff,
    };
  }, [board, replay]);

  if (!board || !shown)
    return <p className="p-3 text-sm text-muted-foreground">{t('noIntervals')}</p>;
  const calls = rows.find((row) => row.executionId === selected)?.calls ?? [];
  const longest = Math.max(1, ...calls.map((call) => call.durationMs));
  // Model calls go by their order in the execution, tools by name; identifiers stay out.
  const modelOrder = calls.filter((call) => call.kind === 'model').map((call) => call.callId);
  const callName = (call: (typeof calls)[number]) =>
    call.kind === 'model'
      ? t('modelCall', { no: modelOrder.indexOf(call.callId) + 1 })
      : (projection?.toolCalls[call.callId]?.name ?? t('tool'));
  const milliseconds = (value: number) =>
    t('milliseconds', { value: format.number(value, { maximumFractionDigits: 0 }) });
  const now = 'cutoff' in shown ? shown.cutoff : live ? Math.max(clock, board.end) : board.end;
  return (
    <section aria-label={t('time')} className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div className="flex items-center justify-end gap-3">
        {live || reduce ? null : (
          <Button
            data-replay
            variant="ghost"
            size="compact"
            aria-pressed={replaying}
            onClick={() => setReplay(replaying ? null : 0)}
          >
            {replaying ? t('stopReplay') : t('replay')}
          </Button>
        )}
      </div>
      <AgentLanes
        agents={shown.agents}
        handoffs={shown.handoffs}
        startAt={board.start}
        now={now}
        {...(live ? {} : { endAt: board.end })}
        title={t('time')}
        selectedTaskId={selected ?? null}
        onSelectTask={onSelect}
        labels={labels}
        size="compact"
      />
      {calls.length ? (
        <ul
          data-call-breakdown
          aria-label={t('callBreakdown')}
          className="grid min-w-0 grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-x-3 gap-y-1.5 text-caption text-muted-foreground"
        >
          {calls.map((call) => (
            <li key={`${call.kind}:${call.callId}`} className="contents">
              <span className="truncate text-foreground">{callName(call)}</span>
              <span className="h-1.5 min-w-0 rounded-full bg-muted" aria-hidden>
                <span
                  data-call-bar
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(2, (call.durationMs / longest) * 100)}%`,
                    background: call.kind === 'model' ? 'var(--emphasis)' : 'var(--success)',
                  }}
                />
              </span>
              <span className="text-right tabular-nums">{milliseconds(call.durationMs)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Every observed use of an artifact version by an execution, in record order. */
function artifactUses(events: readonly RunEvent[]) {
  return events.flatMap((event) => {
    const at = Date.parse(event.recordedAt);
    if (event.type === 'artifact.read')
      return [
        {
          versionId: event.payload.resolvedVersionId,
          executionId: event.payload.consumerExecutionId,
          at,
        },
      ];
    if (event.type === 'model.request_prepared')
      return event.payload.inputArtifactVersionIds.map((versionId) => ({
        versionId,
        executionId: event.payload.executionId,
        at,
      }));
    return [];
  });
}
