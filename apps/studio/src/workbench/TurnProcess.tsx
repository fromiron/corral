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
  Collapse,
  cn,
  DisclosureChevron,
  focusRing,
  ThinkingStep,
  ThinkingStepSource,
  ThinkingStepSources,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  useSize,
} from '@corral/react/design-kit';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
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
/**
 * A step row that opens its own details. The row's second line is the disclosure button, with a
 * chevron, and its hit area covers the whole row; its name says which step's details it opens.
 */
function StepDetails({
  step,
  description,
  children,
}: {
  step: string;
  description: string;
  children: ReactNode;
}) {
  const t = useTranslations('Turn');
  const size = useSize();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t('stepDetails', { step: [step, description].filter(Boolean).join(' · ') })}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          size.type.body,
          'flex w-fit max-w-full cursor-pointer items-center gap-1 rounded-sm text-left text-muted-foreground after:absolute after:inset-0 hover:text-foreground',
          focusRing,
        )}
      >
        {description ? <span className="min-w-0">{description}</span> : null}
        <DisclosureChevron open={open} size={12} className="text-current" />
      </button>
      {/* Above the row's hit area, so the details' own controls stay reachable. */}
      <Collapse id={id} open={open} hideWhenClosed className="relative">
        <div className="pt-1">{children}</div>
      </Collapse>
    </>
  );
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
  const inset = useSize().variant === 'compact' ? '-ml-2.5' : '-ml-3';
  return (
    <div
      data-testid="turn-line"
      className={`${inset} flex min-w-0 flex-wrap items-center text-caption text-muted-foreground`}
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
  // The lead's open ask waits on the person, not on the tool. The composer's notice and the top
  // bar's pill say so; its row names no tool state that would read as work going on.
  const lead = projection.executionOrder[0];
  const asking = useMemo(
    () =>
      pendingInteractions(events, projection).some(
        (item) => item.kind !== 'approval' && item.event.payload.executionId === lead,
      ),
    [events, projection, lead],
  );
  // A waiting turn's time stops at its last record, as the run's timeline does.
  const waiting = projection.status === 'awaiting_user';
  const until = summary.endedAt ?? (waiting ? (events.at(-1)?.recordedAt ?? null) : null);
  const seconds = useElapsed(summary.startedAt, until, summary.active);
  const time =
    seconds === null
      ? null
      : seconds < 60
        ? t('seconds', { s: seconds })
        : t('minutes', { m: Math.floor(seconds / 60), s: seconds % 60 });
  const terminal = TERMINAL_RUN_STATUSES.has(projection.status);
  // An ended or waiting turn reads as the time it worked and its steps, whatever its state: the
  // turn says once, below, that it failed or was cancelled, and the composer's notice says it
  // waits for the person.
  const header =
    summary.active && time
      ? t('working', { time })
      : (terminal || waiting) && time
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
          if (row.kind === 'model') {
            const label = t('request', { no: row.no });
            // A judged request shows its judgement on the row; any other opens it as details.
            const judged = Boolean(row.call.reasoning?.route);
            return (
              <ThinkingStep
                key={`model:${row.id}`}
                icon="brain"
                label={label}
                {...(judged ? { description: modelDescription(row) } : {})}
                status={row.active ? 'active' : 'complete'}
                isLast={last}
                className="turn-process-row"
              >
                {judged ? (
                  // Aligns the button's text with the description.
                  <div className="-ml-3 self-start">
                    <ReasoningSummary call={row.call} open={row.open} />
                  </div>
                ) : (
                  <StepDetails step={label} description={modelDescription(row)}>
                    <div className="-ml-3">
                      <ReasoningSummary call={row.call} open={row.open} />
                    </div>
                  </StepDetails>
                )}
                <Sources sources={row.sources} />
              </ThinkingStep>
            );
          }
          if (row.kind === 'tool') {
            const label = t.has(`tool.${row.name}`) ? t(`tool.${row.name}`) : row.name;
            // The open ask's question shows only in the notice above the composer, so its row
            // offers no details until it is answered.
            const pendingAsk =
              asking &&
              ASKS.has(row.name) &&
              (row.status === 'requested' || row.status === 'allowed');
            return (
              <ThinkingStep
                key={`tool:${row.id}`}
                icon={
                  row.status === 'blocked' || row.status === 'failed'
                    ? 'x'
                    : (ICONS[row.name] ?? 'dot')
                }
                label={label}
                status={row.active ? 'active' : 'complete'}
                isLast={last}
                className="turn-process-row"
              >
                {pendingAsk ? null : (
                  <StepDetails
                    step={label}
                    description={[
                      row.artifact ? t('artifactTarget', row.artifact) : row.target,
                      tt(`tool.${row.status}`),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    <ExecutionToolGroup tools={[row]} activityState={activityState(row.active)} />
                  </StepDetails>
                )}
                <Sources sources={row.sources} />
              </ThinkingStep>
            );
          }
          const status = ts.has(row.status) ? ts(row.status) : row.status;
          return (
            <ThinkingStep
              key={`agent:${row.id}`}
              icon={row.status === 'failed' || row.status === 'cancelled' ? 'x' : 'users'}
              label={row.label}
              {...(row.tools.length ? {} : { description: status })}
              status={row.active ? 'active' : 'complete'}
              isLast={last}
              className="turn-process-row"
            >
              {row.tools.length ? (
                <StepDetails step={row.label} description={status}>
                  <ExecutionToolGroup
                    tools={row.tools}
                    activityState={activityState(row.active, row.status)}
                  />
                </StepDetails>
              ) : null}
              <Sources sources={row.sources} />
            </ThinkingStep>
          );
        })}
      </ThinkingStepsContent>
    </ThinkingSteps>
  );
}
