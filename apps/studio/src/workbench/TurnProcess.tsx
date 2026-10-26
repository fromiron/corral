import type { RunEvent } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import {
  buildTurnProcess,
  type ProcessRow,
  type RunSessionState,
  turnSummary,
} from '@corral/react';
import {
  ThinkingStep,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
} from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

type IconName = 'brain' | 'search' | 'pencil' | 'play' | 'users' | 'message-circle' | 'dot';

const ICONS: Record<string, IconName> = {
  read_file: 'search',
  list_files: 'search',
  read_hashline: 'search',
  read_document: 'search',
  read_artifact: 'search',
  search: 'search',
  write_file: 'pencil',
  edit: 'pencil',
  edit_hashline: 'pencil',
  delete_file: 'pencil',
  move_file: 'pencil',
  run_command: 'play',
  preview_app: 'play',
  preview_action: 'play',
  ask_user: 'message-circle',
  ask: 'message-circle',
  spawn_subagents: 'users',
  await_tasks: 'users',
};

/** Seconds elapsed since `from`, ticking once a second while the turn runs. */
function useElapsed(from: string | null, to: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (to || !from) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [from, to]);
  if (!from) return 0;
  const end = to ? Date.parse(to) : now;
  return Math.max(0, Math.round((end - Date.parse(from)) / 1000));
}

/**
 * a chat turn's process as flat one-line rows (DSH-style). While the turn runs, rows
 * stream in above a working line; a finished turn folds under its duration and step count.
 */
export function TurnProcess({
  events,
  projection,
  streams,
  label,
  open,
  onOpenChange,
}: {
  events: readonly RunEvent[];
  projection: RunProjection;
  streams: RunSessionState['streams'];
  label: (nodeId: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('Turn');
  const ts = useTranslations('Status');
  const process = buildTurnProcess(events, projection, streams, label);
  // Finished turns load their events only when opened; the header reads the projection.
  const summary = events.length ? process : { ...process, ...turnSummary(projection) };
  const seconds = useElapsed(summary.startedAt, summary.endedAt);
  const time =
    seconds < 60
      ? t('seconds', { s: seconds })
      : t('minutes', { m: Math.floor(seconds / 60), s: seconds % 60 });
  if (!summary.running && summary.steps === 0 && process.rows.length === 0) return null;
  const header = summary.running
    ? t('working', { time })
    : summary.steps > 0
      ? t('workedSteps', { time, count: summary.steps })
      : t('worked', { time });
  const rowLabel = (row: ProcessRow) => {
    switch (row.kind) {
      case 'think':
        return `${t('think')} · ${row.text}`;
      case 'tool': {
        const name = t.has(`tool.${row.name}`) ? t(`tool.${row.name}`) : row.name;
        const state =
          row.status === 'blocked' ? t('blocked') : row.status === 'failed' ? t('failed') : null;
        return [name, row.target, state].filter(Boolean).join(' · ');
      }
      case 'agent':
        return t('agentStatus', {
          label: row.label,
          status: ts.has(row.status) ? ts(row.status) : row.status,
        });
    }
  };
  const icon = (row: ProcessRow): IconName =>
    row.kind === 'think' ? 'brain' : row.kind === 'agent' ? 'users' : (ICONS[row.name] ?? 'dot');
  const active = (row: ProcessRow) =>
    summary.running &&
    ((row.kind === 'think' && row.live) ||
      (row.kind === 'tool' && (row.status === 'requested' || row.status === 'allowed')) ||
      (row.kind === 'agent' && !['succeeded', 'failed', 'cancelled'].includes(row.status)));
  return (
    <ThinkingSteps
      data-testid="turn-process"
      className="turn-process w-full"
      size="compact"
      open={open}
      onOpenChange={onOpenChange}
    >
      <ThinkingStepsHeader>
        <span
          data-testid="turn-process-header"
          className={summary.running ? 'shimmer-text tabular-nums' : 'tabular-nums'}
        >
          {header}
        </span>
      </ThinkingStepsHeader>
      <ThinkingStepsContent>
        {process.rows.map((row, index) => (
          <ThinkingStep
            key={`${row.kind}:${row.id}`}
            icon={icon(row)}
            label={rowLabel(row)}
            status={active(row) ? 'active' : 'complete'}
            isLast={index === process.rows.length - 1}
            className="turn-process-row"
          />
        ))}
      </ThinkingStepsContent>
    </ThinkingSteps>
  );
}
