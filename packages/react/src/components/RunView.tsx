import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
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
            <span aria-live="polite">
              <StatusBadge status={projection.status} />
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold">{t('executions')}</h3>
            {projection.executionOrder.length === 0 ? (
              <p className="text-xs text-muted">{t('noExecutions')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {projection.executionOrder.map((id) => {
                  const execution = projection.executions[id];
                  if (!execution) return null;
                  const done = TERMINAL_EXECUTION_STATUSES.has(execution.status);
                  return (
                    <li
                      key={id}
                      className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-xs"
                      data-execution-id={id}
                    >
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {labelOf(execution.nodeId)} · {id}
                        </span>
                        <span className="text-muted">
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
                    </li>
                  );
                })}
              </ul>
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
