import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore, StreamText } from '../run/session.ts';
import { BudgetInspector } from './BudgetInspector.tsx';
import { RunActions } from './RunActions.tsx';
import { RunReason } from './RunText.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/** Run status, executions and output, from committed events only. Needs no editor. */
export function RunView({
  session,
  onSteer,
}: {
  session: RunSessionStore;
  onSteer: (executionId: string) => void;
}) {
  const t = useTranslations('Run');
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const startError = useStore(session, (s) => s.startError);
  const streamError = useStore(session, (s) => s.streamError);
  const streams = useStore(session, (s) => s.streams);
  const labelOf = (nodeId: string) =>
    definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

  return (
    <div className="flex flex-col gap-3">
      {startError ? (
        <p role="alert" className="text-xs text-danger">
          {t('rejected', { message: startError.message })}
        </p>
      ) : null}
      {streamError ? (
        <p role="alert" className="text-xs text-danger">
          {t('streamError', { message: streamError })}
        </p>
      ) : null}
      {projection ? (
        <>
          <RunActions key={projection.runId} session={session} />
          <BudgetInspector session={session} />
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">{t('status')}</span>
            <span aria-live="polite" data-testid="run-status">
              <StatusBadge status={projection.status} />
            </span>
          </div>
          {projection.statusReason ? (
            <p className="text-xs text-muted">
              {t('reasonPrefix')}{' '}
              <RunReason
                code={projection.statusReason}
                nodeLabel={(id) => definition?.nodes.find((n) => n.id === id)?.label ?? id}
              />
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold">{t('executions')}</h3>
            {projection.executionOrder.length === 0 ? (
              <p className="text-xs text-muted">{t('noExecutions')}</p>
            ) : (
              <ExecutionRows
                projection={projection}
                streams={streams}
                labelOf={labelOf}
                onSteer={onSteer}
              />
            )}
          </div>
          <RunOutput session={session} />
        </>
      ) : null}
    </div>
  );
}

/** The run's final output, once the Output node has it (Markdown, rendered safely). */
export function RunOutput({
  session,
  heading = true,
}: {
  session: RunSessionStore;
  heading?: boolean;
}) {
  const t = useTranslations('Run');
  const outputText = useStore(session, (s) => s.outputText);
  return (
    <div className="flex flex-col gap-1">
      {heading ? <h3 className="text-xs font-semibold">{t('output')}</h3> : null}
      {outputText === null ? (
        <p className="text-xs text-muted">{t('outputPending')}</p>
      ) : (
        <div
          data-testid="run-output"
          className={`overflow-auto rounded-md border border-line bg-surface p-2 ${heading ? 'max-h-64' : ''}`}
        >
          <SafeMarkdown text={outputText} />
        </div>
      )}
    </div>
  );
}

/** The call tree of one run, for pages that lay out the run's parts themselves (Run page). */
export function ExecutionTree({
  session,
  onSteer,
  selectedExecutionId = null,
}: {
  session: RunSessionStore;
  onSteer: (executionId: string) => void;
  selectedExecutionId?: string | null;
}) {
  const t = useTranslations('Run');
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const streams = useStore(session, (s) => s.streams);
  if (!projection) return null;
  if (projection.executionOrder.length === 0)
    return <p className="text-xs text-muted">{t('noExecutions')}</p>;
  return (
    <ExecutionRows
      projection={projection}
      streams={streams}
      labelOf={(nodeId) => definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId}
      onSteer={onSteer}
      selectedExecutionId={selectedExecutionId}
    />
  );
}

/**
 * Executions as a call tree: children under the execution that started them, each Loop round
 * and attempt as its own row (a node is not one execution, C-016). A waiting execution names
 * what it waits for and links to those rows.
 */
function ExecutionRows({
  projection,
  streams,
  labelOf,
  onSteer,
  selectedExecutionId = null,
}: {
  projection: RunProjection;
  streams: Record<string, StreamText>;
  labelOf: (nodeId: string) => string;
  onSteer: (executionId: string) => void;
  selectedExecutionId?: string | null;
}) {
  const childrenOf = new Map<string | null, string[]>();
  for (const id of projection.executionOrder) {
    const parent = projection.executions[id]?.parentExecutionId ?? null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id]);
  }
  const rows = (parent: string | null) => (
    <ul className={`flex flex-col gap-1 ${parent ? 'mt-1 border-l border-line pl-2' : ''}`}>
      {(childrenOf.get(parent) ?? []).map((id) => (
        <ExecutionRow
          key={id}
          id={id}
          projection={projection}
          streams={streams}
          labelOf={labelOf}
          onSteer={onSteer}
          selected={id === selectedExecutionId}
          nested={childrenOf.has(id) ? rows(id) : null}
        />
      ))}
    </ul>
  );
  return rows(null);
}

function ExecutionRow({
  id,
  projection,
  streams,
  labelOf,
  onSteer,
  selected,
  nested,
}: {
  id: string;
  projection: RunProjection;
  streams: Record<string, StreamText>;
  labelOf: (nodeId: string) => string;
  onSteer: (executionId: string) => void;
  selected: boolean;
  nested: ReactNode;
}) {
  const t = useTranslations('Run');
  const execution = projection.executions[id];
  if (!execution) return null;
  const done = TERMINAL_EXECUTION_STATUSES.has(execution.status);
  const round = execution.iterationId ? projection.iterations[execution.iterationId]?.no : null;
  const waiting = execution.waitingOn;
  // While a request streams, its text so far; it is replaced by the submitted output.
  const openCall = execution.modelCallIds.at(-1);
  const lastResponse = openCall ? streams[openCall] : undefined;
  const live =
    lastResponse?.completed || (!done && openCall && !projection.modelCalls[openCall]?.finished)
      ? lastResponse
      : undefined;
  return (
    <li
      id={`execution-${id}`}
      data-testid={`execution-${id}`}
      data-execution-id={id}
      aria-current={selected ? 'true' : undefined}
      className={`rounded-md border p-2 text-xs ${selected ? 'border-accent ring-1 ring-accent/40' : 'border-line'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-col">
          <span className="font-medium">
            {labelOf(execution.nodeId)} · {id}
          </span>
          <span className="text-muted">
            {round ? `${t('round', { no: round })} · ` : ''}
            {execution.attemptNo > 1 ? `${t('attempt', { no: execution.attemptNo })} · ` : ''}
            {t('requests', { count: execution.modelCallIds.length })}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge status={execution.status} />
          <button
            type="button"
            onClick={() => onSteer(id)}
            className="rounded border border-line px-1.5 py-0.5"
          >
            {t('steerThis')}
          </button>
        </span>
      </div>
      {waiting ? (
        <p className="mt-1 text-muted" data-testid="waiting-on">
          {t(`waiting.${waiting.kind}`, { count: waiting.targetIds.length })}:{' '}
          {waiting.targetIds.map((target, i) => (
            <span key={target}>
              {i > 0 ? ', ' : ''}
              {projection.executions[target] ? (
                <a href={`#execution-${target}`} className="font-mono underline">
                  {target}
                </a>
              ) : (
                <span className="font-mono">{target}</span>
              )}
            </span>
          ))}
        </p>
      ) : null}
      {execution.error ? <p className="mt-1 text-danger">{execution.error}</p> : null}
      {live?.completed ? <p className="mt-1 font-medium">{t('completedResponse')}</p> : null}
      {live?.text ? (
        <p
          data-testid="live-text"
          aria-live="off"
          className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface p-1 text-muted"
        >
          {live.text}
          {live.broken ? ` ${t('streamGap')}` : ''}
        </p>
      ) : null}
      {nested}
    </li>
  );
}
