import { type RunEvent, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunProjection } from '@corral/core';
import {
  buildTurnProcess,
  ExecutionToolGroup,
  type ProcessRow,
  ReasoningSummary,
  type RunSessionState,
  type TurnProcess as TurnProcessModel,
  turnSummary,
} from '@corral/react';
import {
  ThinkingStep,
  ThinkingStepDetails,
  ThinkingStepSource,
  ThinkingStepSources,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
} from '@corral/react/design-kit';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';

type IconName = 'brain' | 'search' | 'pencil' | 'play' | 'users' | 'message-circle' | 'dot' | 'x';
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
const ASKS = new Set(['ask_user', 'ask']);
function useElapsed(from: string | null, to: string | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || to || !from) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [from, to, active]);
  if (!from) return null;
  return Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000));
}
function Sources({ sources }: { sources: ProcessRow['sources'] }) {
  return sources.length ? (
    <ThinkingStepSources>
      {sources.map((source) => (
        <ThinkingStepSource key={source.id}>{source.label}</ThinkingStepSource>
      ))}
    </ThinkingStepSources>
  ) : null;
}

/**
 * The one quiet line above an answer. Its controls hang into the gutter by their own padding,
 * so their text, not their hover fill, starts on the answer's left edge.
 */
export function TurnLine({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="turn-line"
      className="-ml-2.5 flex min-w-0 flex-wrap items-center text-caption text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** The source kit's progressive work log, composed from observed requests and tools. */
export function TurnProcess({
  events,
  projection,
  process: given,
  label,
  open,
  onOpenChange,
  trailing,
}: {
  events: readonly RunEvent[];
  projection: RunProjection;
  /** The process the host already built from these events, so it is not built twice. */
  process?: TurnProcessModel;
  streams: RunSessionState['streams'];
  label: (nodeId: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What follows the toggle on the same line: the run's number, which opens its record. */
  trailing?: ReactNode;
}) {
  const t = useTranslations('Turn');
  const ts = useTranslations('Status');
  const tt = useTranslations('Transcript');
  const process = useMemo(
    () => given ?? buildTurnProcess(events, projection, {}, label),
    [given, events, projection, label],
  );
  const summary = events.length ? process : { ...process, ...turnSummary(projection) };
  // The lead's open ask waits on the person, not on the tool: its row says so.
  const lead = projection.executionOrder[0];
  const asking = useMemo(
    () =>
      pendingInteractions(events, projection).some(
        (item) => item.kind !== 'approval' && item.event.payload.executionId === lead,
      ),
    [events, projection, lead],
  );
  const seconds = useElapsed(summary.startedAt, summary.endedAt, summary.active);
  const time =
    seconds === null
      ? null
      : seconds < 60
        ? t('seconds', { s: seconds })
        : t('minutes', { m: Math.floor(seconds / 60), s: seconds % 60 });
  const terminal = TERMINAL_RUN_STATUSES.has(projection.status);
  // An ended turn reads as the time it took and its steps, whatever its end state: the turn
  // says once, below, that it failed or was cancelled. A turn that waits names what it waits on.
  const header =
    summary.active && time
      ? t('working', { time })
      : terminal && time
        ? summary.steps
          ? t('workedSteps', { time, count: summary.steps })
          : t('worked', { time })
        : ts.has(projection.status)
          ? ts(projection.status)
          : projection.status;
  if (
    terminal &&
    summary.steps === 0 &&
    process.rows.length === 0 &&
    Object.keys(projection.modelCalls).length === 0
  )
    return trailing ? <TurnLine>{trailing}</TurnLine> : null;
  const modelDescription = (row: Extract<ProcessRow, { kind: 'model' }>) => {
    const phase =
      row.phase === 'preparing'
        ? t('requestPreparing')
        : row.phase === 'generating'
          ? t('requestGenerating')
          : row.phase === 'finished'
            ? t('requestFinished')
            : row.phase === 'unconfirmed'
              ? t('requestUnconfirmed')
              : row.phase === 'waiting'
                ? ts.has(row.state)
                  ? ts(row.state)
                  : row.state
                : ts(row.phase);
    return [row.model, phase].filter(Boolean).join(' · ');
  };
  const activityState = (active: boolean, executionState?: string) => {
    if (active) return undefined;
    const state =
      projection.status === 'running'
        ? (executionState ??
          projection.executions[projection.executionOrder[0] ?? '']?.status ??
          projection.status)
        : projection.status;
    return {
      status: (terminal || state === 'cancelled' || state === 'failed' ? 'stopped' : 'waiting') as
        | 'waiting'
        | 'stopped',
      label: ts.has(state) ? ts(state) : state,
    };
  };
  return (
    <ThinkingSteps
      data-testid="turn-process"
      className="turn-process w-full"
      size="compact"
      open={open}
      onOpenChange={onOpenChange}
    >
      <TurnLine>
        <ThinkingStepsHeader>
          <span
            data-testid="turn-process-header"
            className={summary.active ? 'shimmer-text tabular-nums' : 'tabular-nums'}
          >
            {header}
          </span>
        </ThinkingStepsHeader>
        {trailing}
      </TurnLine>
      <ThinkingStepsContent>
        {process.rows.map((row, index) => {
          const last = index === process.rows.length - 1;
          if (row.kind === 'model')
            return (
              <ThinkingStep
                key={`model:${row.id}`}
                icon="brain"
                label={t('request', { no: row.no })}
                description={modelDescription(row)}
                status={row.active ? 'active' : 'complete'}
                isLast={last}
                className="turn-process-row"
              >
                {row.call.reasoning?.route ? (
                  // Aligns the button's text with the description, like ThinkingStepDetails.
                  <div className="-ml-3 self-start">
                    <ReasoningSummary call={row.call} open={row.open} />
                  </div>
                ) : null}
                <Sources sources={row.sources} />
                {row.call.reasoning?.route ? null : (
                  <ThinkingStepDetails summary={t('requestDetails')}>
                    <ReasoningSummary call={row.call} open={row.open} />
                  </ThinkingStepDetails>
                )}
              </ThinkingStep>
            );
          if (row.kind === 'tool')
            return (
              <ThinkingStep
                key={`tool:${row.id}`}
                icon={
                  row.status === 'blocked' || row.status === 'failed'
                    ? 'x'
                    : (ICONS[row.name] ?? 'dot')
                }
                label={t.has(`tool.${row.name}`) ? t(`tool.${row.name}`) : row.name}
                description={[
                  row.artifact ? t('artifactTarget', row.artifact) : row.target,
                  asking &&
                  ASKS.has(row.name) &&
                  (row.status === 'requested' || row.status === 'allowed')
                    ? t('waitingForAnswer')
                    : tt(`tool.${row.status}`),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                status={row.active ? 'active' : 'complete'}
                isLast={last}
                className="turn-process-row"
              >
                <Sources sources={row.sources} />
                <ThinkingStepDetails summary={t('toolDetails')}>
                  <ExecutionToolGroup tools={[row]} activityState={activityState(row.active)} />
                </ThinkingStepDetails>
              </ThinkingStep>
            );
          return (
            <ThinkingStep
              key={`agent:${row.id}`}
              icon={row.status === 'failed' || row.status === 'cancelled' ? 'x' : 'users'}
              label={row.label}
              description={ts.has(row.status) ? ts(row.status) : row.status}
              status={row.active ? 'active' : 'complete'}
              isLast={last}
              className="turn-process-row"
            >
              <Sources sources={row.sources} />
              {row.tools.length ? (
                <ThinkingStepDetails summary={t('agentDetails')}>
                  <ExecutionToolGroup
                    tools={row.tools}
                    activityState={activityState(row.active, row.status)}
                  />
                </ThinkingStepDetails>
              ) : null}
            </ThinkingStep>
          );
        })}
      </ThinkingStepsContent>
    </ThinkingSteps>
  );
}
