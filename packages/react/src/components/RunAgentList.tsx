import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { ExecutionView, RunProjection } from '@corral/core';
import { type ReactElement, type ReactNode, useMemo } from 'react';
import { useTranslations } from 'use-intl';
import {
  type AgentStatus,
  AgentStatusBadge,
  Button,
  formatClock,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useNow,
} from '../design-kit/index.ts';
import type { RunAgentGraphNode } from '../run/agent-graph.ts';
import { useRunDisplay } from '../run/display.tsx';
import { executionIntervals } from '../run/history.ts';
import { currentAttempts } from '../run/selectors.ts';
import type { RunSessionStore } from '../run/session.ts';

/** What the map's node shows of an agent; the list repeats it, not a second derivation. */
export interface AgentPresentation {
  model?: string;
  status: AgentStatus;
  statusLabel: string;
}

/**
 * The execution a row reports: the latest unfinished current attempt, otherwise the latest
 * current attempt. Superseded attempts stay in the agent's execution list.
 */
function currentExecution(projection: RunProjection, ids: readonly string[]) {
  const executions = ids.flatMap((id) => projection.executions[id] ?? []);
  if (!executions.length) return null;
  const order = new Map(projection.executionOrder.map((id, index) => [id, index]));
  const latest = (list: ExecutionView[]) =>
    [...list].sort(
      (a, b) => (order.get(b.executionId) ?? -1) - (order.get(a.executionId) ?? -1),
    )[0] ?? null;
  const current = currentAttempts(projection, executions);
  return (
    latest(current.filter((execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status))) ??
    latest(current)
  );
}

/**
 * The graph view's list display: one row per agent node of the map, with the same name, model
 * and status, the current round and attempt, and the observed elapsed time of that attempt.
 * Choosing a row is choosing the node: `trigger` gives each row the map's quick-view trigger.
 */
export function RunAgentList({
  session,
  nodes,
  present,
  selectedNodeId,
  onSelectNode,
  trigger,
}: {
  session: RunSessionStore;
  nodes: RunAgentGraphNode[];
  present: (node: RunAgentGraphNode) => AgentPresentation;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string, trigger: HTMLElement | null) => void;
  trigger?: (nodeId: string, button: ReactElement) => ReactNode;
}) {
  const t = useTranslations('RunMonitor.agentList');
  const run = useTranslations('Run');
  const projection = useRunDisplay(session, (s) => s.projection);
  const events = useRunDisplay(session, (s) => s.events);
  const intervals = useMemo(
    () => new Map(executionIntervals(events).map((row) => [row.executionId, row])),
    [events],
  );
  const live = !!projection && !TERMINAL_RUN_STATUSES.has(projection.status);
  const rows = nodes.map((node) => {
    const execution = projection ? currentExecution(projection, node.executionIds) : null;
    const interval = execution ? intervals.get(execution.executionId) : undefined;
    const round =
      execution?.iterationId && projection
        ? projection.iterations[execution.iterationId]?.no
        : undefined;
    return { node, execution, interval, round };
  });
  const ticking = live && rows.some((row) => row.interval && !row.interval.finished);
  const now = useNow(1000, ticking);
  // A narrow list keeps a row to two lines: the model and the current attempt leave their
  // columns and stack under the agent's name, as the kit's narrow tables do.
  const wide = '@max-xl/agent-list:hidden';
  return (
    <div className="@container/agent-list min-w-0">
      <Table aria-label={t('label')}>
        <TableHeader>
          <TableRow>
            <TableHead>{t('agent')}</TableHead>
            <TableHead className={wide}>{t('model')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            <TableHead className={wide}>{t('current')}</TableHead>
            <TableHead className="text-right">{t('elapsed')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ node, execution, interval, round }, index) => {
            const shown = present(node);
            const selected = selectedNodeId === node.id;
            const button = (
              <Button
                variant={selected ? 'secondary' : 'ghost'}
                size="compact"
                aria-pressed={selected}
                className="max-w-full justify-start text-foreground"
                onClick={(event) => onSelectNode(node.id, event.currentTarget)}
              >
                <span className="truncate">{node.label}</span>
              </Button>
            );
            const end = interval
              ? interval.finished || !live
                ? Date.parse(interval.endedAt)
                : Math.max(now, Date.parse(interval.endedAt))
              : null;
            const current = execution
              ? [
                  ...(round ? [run('round', { no: round })] : []),
                  run('attempt', { no: execution.attemptNo }),
                ].join(' · ')
              : null;
            const stacked = [shown.model, current].filter(Boolean).join(' · ');
            return (
              <TableRow key={node.id} index={index} data-agent-row={node.id}>
                {/* Narrow, the name column takes what the others leave and cuts its lines short. */}
                <TableCell className="py-1 @max-xl/agent-list:w-full @max-xl/agent-list:max-w-0">
                  {trigger ? trigger(node.id, button) : button}
                  {stacked ? (
                    <span
                      title={stacked}
                      className="block truncate px-3 pb-1 text-caption @xl/agent-list:hidden"
                    >
                      {stacked}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className={wide}>{shown.model ?? null}</TableCell>
                <TableCell>
                  <AgentStatusBadge status={shown.status} label={shown.statusLabel} />
                </TableCell>
                <TableCell className={wide}>{current}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {interval && end !== null
                    ? formatClock(end - Date.parse(interval.startedAt))
                    : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
