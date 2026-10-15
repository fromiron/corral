import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
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
  const outputText = useStore(session, (s) => s.outputText);
  const startError = useStore(session, (s) => s.startError);
  const streamError = useStore(session, (s) => s.streamError);
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
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">{t('status')}</span>
            <span aria-live="polite" data-testid="run-status">
              <StatusBadge status={projection.status} />
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold">{t('executions')}</h3>
            {projection.executionOrder.length === 0 ? (
              <p className="text-xs text-muted">{t('noExecutions')}</p>
            ) : (
              <ExecutionTree projection={projection} labelOf={labelOf} onSteer={onSteer} />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold">{t('output')}</h3>
            {outputText === null ? (
              <p className="text-xs text-muted">{t('outputPending')}</p>
            ) : (
              <pre
                data-testid="run-output"
                className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-2 text-xs"
              >
                {outputText}
              </pre>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Executions as a call tree: children under the execution that started them, each Loop round
 * and attempt as its own row (a node is not one execution, C-016). A waiting execution names
 * what it waits for and links to those rows.
 */
function ExecutionTree({
  projection,
  labelOf,
  onSteer,
}: {
  projection: RunProjection;
  labelOf: (nodeId: string) => string;
  onSteer: (executionId: string) => void;
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
          labelOf={labelOf}
          onSteer={onSteer}
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
  labelOf,
  onSteer,
  nested,
}: {
  id: string;
  projection: RunProjection;
  labelOf: (nodeId: string) => string;
  onSteer: (executionId: string) => void;
  nested: ReactNode;
}) {
  const t = useTranslations('Run');
  const execution = projection.executions[id];
  if (!execution) return null;
  const done = TERMINAL_EXECUTION_STATUSES.has(execution.status);
  const round = execution.iterationId ? projection.iterations[execution.iterationId]?.no : null;
  const waiting = execution.waitingOn;
  return (
    <li
      id={`execution-${id}`}
      data-testid={`execution-${id}`}
      data-execution-id={id}
      className="rounded-md border border-line p-2 text-xs"
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
          {!done ? (
            <button
              type="button"
              onClick={() => onSteer(id)}
              className="rounded border border-line px-1.5 py-0.5"
            >
              {t('steerThis')}
            </button>
          ) : null}
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
      {nested}
    </li>
  );
}
