import { type RunEvent, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunProjection } from '@corral/core';
import {
  buildTurnProcess,
  ExecutionToolGroup,
  FailureNotice,
  type ProcessRow,
  ReasoningLevelLabel,
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
  fontWeights,
  RollNumber,
  ThinkingStep,
  ThinkingStepSource,
  ThinkingStepSources,
  ThinkingSteps,
  ThinkingStepsContent,
  useSize,
} from '@corral/react/design-kit';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { MetaLine, RunHead } from './RunRow.tsx';

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
/** The states in which a turn is working: its time runs. */
const WORKING = new Set(['created', 'validating', 'running']);
function useElapsed(from: string | null, to: string | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || to || !from) return;
    setNow(Date.now());
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
  target,
  children,
}: {
  step: string;
  description: string;
  /** What the description's state words speak of, when they name a state. */
  target?: `execution:${string}`;
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
        {description ? (
          <span className="min-w-0" data-presence-label={target}>
            {description}
          </span>
        ) : null}
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
 * The run row's head and the work log it opens: the source kit's progressive work log, composed
 * from observed requests and tools. The head is the log's toggle; the log opens right under it.
 */
export function TurnProcess({
  events,
  projection,
  process: given,
  label,
  open,
  onOpenChange,
  trailing,
  role,
  status,
  failed = 0,
  toggle = true,
  children,
}: {
  events: readonly RunEvent[];
  projection: RunProjection;
  /** The process the host already built from these events, so it is not built twice. */
  process?: TurnProcessModel;
  streams: RunSessionState['streams'];
  label: (nodeId: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What ends the head line: the run's number, which opens its record. */
  trailing?: ReactNode;
  /** The name of the role that answers in the conversation. */
  role?: string | null;
  /** The run's state in words. */
  status?: ReactNode;
  /** Failed and cancelled steps, counted at the end of the head's values. */
  failed?: number;
  /** Whether the log can be opened here; without it the head keeps its line and its state. */
  toggle?: boolean;
  /** What the log holds after its steps: what went wrong in them, why the run stands still. */
  children?: ReactNode;
}) {
  const t = useTranslations('Turn');
  const ts = useTranslations('Status');
  const tt = useTranslations('Transcript');
  const size = useSize();
  const panel = useId();
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
  const seconds = useElapsed(summary.startedAt, until, WORKING.has(projection.status));
  const clock = (value: number) =>
    value < 60
      ? t('seconds', { s: value })
      : t('minutes', { m: Math.floor(value / 60), s: value % 60 });
  const terminal = TERMINAL_RUN_STATUSES.has(projection.status);
  // The head opens the log only when it holds something; its mark keeps its place either way.
  // A past turn's steps load when its log first opens, so the record's counts also say so.
  const canOpen =
    toggle &&
    (process.rows.length > 0 ||
      Boolean(children) ||
      summary.steps > 0 ||
      Object.keys(projection.modelCalls).length > 0);
  const shown = canOpen && open;
  const values = [
    role
      ? {
          key: 'role',
          node: (
            <span
              className="min-w-0 truncate text-foreground"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {role}
            </span>
          ),
        }
      : null,
    status ? { key: 'status', node: <span className="shrink-0">{status}</span> } : null,
    seconds !== null
      ? {
          key: 'time',
          node: (
            <span data-testid="turn-process-header" className="shrink-0 tabular-nums">
              <RollNumber value={seconds} format={clock} />
            </span>
          ),
        }
      : null,
    toggle && summary.steps
      ? {
          key: 'steps',
          node: <span className="min-w-0 truncate">{t('steps', { count: summary.steps })}</span>,
        }
      : null,
    failed
      ? {
          key: 'failed',
          node: <span className="shrink-0 text-danger">{t('failedCount', { count: failed })}</span>,
        }
      : null,
  ].filter((value) => value !== null);
  const line = (
    <>
      <span className="inline-flex size-3 shrink-0 items-center justify-center">
        {canOpen ? <DisclosureChevron open={shown} size={12} className="text-current" /> : null}
      </span>
      <MetaLine values={values} />
    </>
  );
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
      open={shown}
      onOpenChange={onOpenChange}
    >
      <RunHead trailing={trailing}>
        {canOpen ? (
          <button
            type="button"
            aria-expanded={shown}
            aria-controls={panel}
            onClick={() => onOpenChange(!shown)}
            className={cn(
              'flex h-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-sm text-left hover:text-foreground',
              focusRing,
            )}
          >
            {line}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">{line}</span>
        )}
      </RunHead>
      {canOpen ? (
        <ThinkingStepsContent id={panel}>
          {process.rows.map((row, index) => {
            const last = index === process.rows.length - 1;
            if (row.kind === 'model') {
              const label = t('request', { no: row.no });
              // The applied level stays on the row. A judged request also shows its judgement;
              // any other keeps the rest of the record in the details.
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
                  <ReasoningLevelLabel call={row.call} open={row.open} />
                  {judged ? (
                    // Aligns the button's text with the description.
                    <div className="-ml-3 self-start">
                      <ReasoningSummary call={row.call} open={row.open} />
                    </div>
                  ) : (
                    <StepDetails step={label} description={modelDescription(row)}>
                      {/* With no reasoning record there is no rest to show; the row says so. */}
                      {row.call.reasoning ? (
                        <div className="-ml-3">
                          <ReasoningSummary call={row.call} open={row.open} />
                        </div>
                      ) : null}
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
                        row.allowedForRun ? t('allowedForRun') : null,
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
            // A team role's row says its own state once, by its execution, and keeps its failure.
            const state = ts.has(row.status) ? ts(row.status) : row.status;
            const target = `execution:${row.id}` as const;
            const error = projection.executions[row.id]?.error;
            return (
              <div key={`agent:${row.id}`} data-chat-part={`role:${row.id}`}>
                <ThinkingStep
                  icon={row.status === 'failed' || row.status === 'cancelled' ? 'x' : 'users'}
                  label={row.label}
                  status={row.active ? 'active' : 'complete'}
                  isLast={last}
                  className="turn-process-row"
                >
                  {row.tools.length ? (
                    <StepDetails step={row.label} description={state} target={target}>
                      <ExecutionToolGroup
                        tools={row.tools}
                        activityState={activityState(row.active, row.status)}
                      />
                    </StepDetails>
                  ) : (
                    <span
                      data-presence-label={target}
                      className={cn(size.type.body, 'text-muted-foreground')}
                    >
                      {state}
                    </span>
                  )}
                  {error ? (
                    <FailureNotice message={error} cancelled={row.status === 'cancelled'} />
                  ) : null}
                  <Sources sources={row.sources} />
                </ThinkingStep>
              </div>
            );
          })}
          {children ? (
            <div className="flex flex-col gap-2 px-2 pt-1 text-caption">{children}</div>
          ) : null}
        </ThinkingStepsContent>
      ) : null}
    </ThinkingSteps>
  );
}
