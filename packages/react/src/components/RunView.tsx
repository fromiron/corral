import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button } from '../design-kit/index.ts';
import type { ModelPrices } from '../run/cost.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore, StreamText } from '../run/session.ts';
import { BudgetInspector } from './BudgetInspector.tsx';
import { HarnessDetails } from './HarnessDetails.tsx';
import { ReasoningSummary } from './ReasoningSummary.tsx';
import { RunActions } from './RunActions.tsx';
import { RunReason } from './RunText.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/** Run status, executions and output, from committed events only. Needs no editor. */
export function RunView({
  session,
  onSteer,
  onStartFrom,
  prices,
}: {
  session: RunSessionStore;
  onSteer: (executionId: string) => void;
  onStartFrom?: Parameters<typeof RunOutput>[0]['onStartFrom'];
  /** List prices for the cost estimate. */
  prices?: ModelPrices | undefined;
}) {
  const t = useTranslations('Run');
  const projection = useRunDisplay(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const startError = useStore(session, (s) => s.startError);
  const definitionError = useStore(session, (s) => s.definitionError);
  const streamError = useStore(session, (s) => s.streamError);
  const streams = useRunDisplay(session, (s) => s.streams);
  const simulatedHarness = useRunDisplay(session, (s) =>
    s.events.some((event) => event.type === 'harness.simulated'),
  );
  const labelOf = (nodeId: string) =>
    definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

  return (
    <div className="flex flex-col gap-3">
      {startError ? (
        <p role="alert" className="text-xs text-danger">
          {t('rejected', { message: startError.message })}
        </p>
      ) : null}
      {definitionError ? (
        <p role="alert" className="text-xs text-warning">
          {t('definitionUnavailable')}{' '}
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={() => {
              const runId = session.getState().runId;
              if (runId) void session.getState().open(runId);
            }}
          >
            {t('retryDefinition')}
          </Button>
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
          {simulatedHarness ? (
            <p className="text-xs text-muted-foreground">{t('harnessSimulation')}</p>
          ) : null}
          <BudgetInspector session={session} prices={prices} />
          <HarnessDetails session={session} />
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('status')}</span>
            <span aria-live="polite" data-testid="run-status">
              <StatusBadge status={projection.status} />
            </span>
          </div>
          {projection.statusReason ? (
            <p className="text-xs text-muted-foreground">
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
              <p className="text-xs text-muted-foreground">{t('noExecutions')}</p>
            ) : (
              <ExecutionRows
                projection={projection}
                streams={streams}
                labelOf={labelOf}
                onSteer={onSteer}
              />
            )}
          </div>
          <RunOutput session={session} {...(onStartFrom ? { onStartFrom } : {})} />
        </>
      ) : null}
    </div>
  );
}

/** The run's final output, once the Output node has it (Markdown, rendered safely). */
export function RunOutput({
  session,
  heading = true,
  onStartFrom,
  onOpenResults,
}: {
  session: RunSessionStore;
  heading?: boolean;
  /** Offers "New run from this result" for the final output. */
  onStartFrom?: (from: { runId: string; artifactVersionId: string; label: string }) => void;
  /** Opens one final result in the Results view. */
  onOpenResults?: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Run');
  const tr = useTranslations('Results');
  const projection = useRunDisplay(session, (s) => s.projection);
  const finals = (projection?.output?.artifactVersionIds ?? []).flatMap(
    (id) => projection?.artifacts[id] ?? [],
  );
  const loadedOutputText = useStore(session, (s) => s.outputText);
  const runId = useStore(session, (s) => s.runId);
  const resultId = useRunDisplay(
    session,
    (s) => s.projection?.output?.artifactVersionIds[0] ?? null,
  );
  const outputText = resultId ? loadedOutputText : null;
  const result = useRunDisplay(session, (s) =>
    resultId ? s.projection?.artifacts[resultId] : undefined,
  );
  return (
    <div className="flex flex-col gap-1">
      {heading ? <h3 className="text-xs font-semibold">{t('output')}</h3> : null}
      {onOpenResults && finals.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {finals.length > 1 ? (
            <span className="text-muted-foreground">
              {tr('finalCount', { count: finals.length })}
            </span>
          ) : null}
          {finals.map((artifact) => {
            const label = tr('itemName', { name: artifact.name, version: artifact.version });
            return (
              <Button
                key={artifact.artifactVersionId}
                type="button"
                onClick={() => onOpenResults(artifact.artifactVersionId)}
                aria-label={label}
                variant="tertiary"
                size="compact"
              >
                {label} ↗
              </Button>
            );
          })}
        </div>
      ) : null}
      {outputText === null ? (
        <p className="text-xs text-muted-foreground">{t('outputPending')}</p>
      ) : (
        <div
          data-testid="run-output"
          className={`overflow-auto rounded-md fill-group p-2 ${heading ? 'max-h-64' : ''}`}
        >
          <SafeMarkdown text={outputText} />
        </div>
      )}
      {onStartFrom && runId && result && outputText !== null ? (
        <Button
          type="button"
          onClick={() =>
            onStartFrom({
              runId,
              artifactVersionId: result.artifactVersionId,
              label: `${result.name} v${result.version}`,
            })
          }
          variant="secondary"
          size="compact"
          className="self-start"
        >
          {t('newRunFromResult')}
        </Button>
      ) : null}
    </div>
  );
}

/** The call tree of one run, for pages that lay out the run's parts themselves (Run page). */
export function ExecutionTree({
  session,
  onSteer,
  selectedExecutionId = null,
  compact = false,
}: {
  session: RunSessionStore;
  onSteer: (executionId: string) => void;
  selectedExecutionId?: string | null;
  compact?: boolean;
}) {
  const t = useTranslations('Run');
  const projection = useRunDisplay(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const streams = useRunDisplay(session, (s) => s.streams);
  if (!projection) return null;
  if (projection.executionOrder.length === 0)
    return <p className="text-xs text-muted-foreground">{t('noExecutions')}</p>;
  return (
    <ExecutionRows
      projection={projection}
      streams={streams}
      labelOf={(nodeId) => definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId}
      onSteer={onSteer}
      selectedExecutionId={selectedExecutionId}
      compact={compact}
    />
  );
}

/**
 * Executions as a call tree: children under the execution that started them, each Loop round
 * and attempt as its own row (a node is not one execution). A waiting execution names
 * what it waits for and links to those rows.
 */
function ExecutionRows({
  projection,
  streams,
  labelOf,
  onSteer,
  selectedExecutionId = null,
  compact = false,
}: {
  projection: RunProjection;
  streams: Record<string, StreamText>;
  labelOf: (nodeId: string) => string;
  onSteer: (executionId: string) => void;
  selectedExecutionId?: string | null;
  compact?: boolean;
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
          compact={compact}
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
  compact,
}: {
  id: string;
  projection: RunProjection;
  streams: Record<string, StreamText>;
  labelOf: (nodeId: string) => string;
  onSteer: (executionId: string) => void;
  selected: boolean;
  nested: ReactNode;
  compact: boolean;
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
      className={`rounded-md border p-2 text-xs ${selected ? 'border-primary bg-raised ring-1 ring-primary/40' : 'border-transparent fill-group'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="break-all font-medium">
            {labelOf(execution.nodeId)}
            {compact ? '' : ` · ${id}`}
          </span>
          <span className="text-muted-foreground">
            {execution.item ? `${t('item', execution.item)} · ` : ''}
            {round ? `${t('round', { no: round })} · ` : ''}
            {execution.attemptNo > 1 ? `${t('attempt', { no: execution.attemptNo })} · ` : ''}
            {t('requests', { count: execution.modelCallIds.length })}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge status={execution.status} />
          <Button type="button" onClick={() => onSteer(id)} variant="tertiary" size="compact">
            {t(compact ? 'openControls' : 'steerThis')}
          </Button>
        </span>
      </div>
      {!compact && openCall && projection.modelCalls[openCall] ? (
        <ReasoningSummary call={projection.modelCalls[openCall]} />
      ) : null}
      {waiting ? (
        <p className="mt-1 text-muted-foreground" data-testid="waiting-on">
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
      {!compact && live?.completed ? (
        <p className="mt-1 font-medium">{t('completedResponse')}</p>
      ) : null}
      {!compact && live?.text ? (
        <p
          data-testid="live-text"
          aria-live="off"
          className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded fill-group p-1 text-muted-foreground"
        >
          {live.text}
          {live.broken ? ` ${t('streamGap')}` : ''}
        </p>
      ) : null}
      {nested}
    </li>
  );
}
