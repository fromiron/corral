import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { compileDraft } from '../editor/model.ts';
import { StatusBadge } from './StatusBadge.tsx';

export function RunPanel({ onSteer }: { onSteer: (executionId: string) => void }) {
  const t = useTranslations('Run');
  const { editor, session } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const projection = useStore(session, (s) => s.projection);
  const outputText = useStore(session, (s) => s.outputText);
  const startError = useStore(session, (s) => s.startError);
  const streamError = useStore(session, (s) => s.streamError);
  const [starting, setStarting] = useState(false);
  const compiled = useMemo(() => compileDraft(draft), [draft]);

  const running = projection !== null && !TERMINAL_RUN_STATUSES.has(projection.status);
  const labelOf = (nodeId: string) => draft.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

  const start = async () => {
    if (!compiled.definition) return;
    setStarting(true);
    try {
      await session.getState().start(compiled.definition);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section aria-labelledby="run-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="run-heading" className="text-sm font-semibold">
          {t('heading')}
        </h2>
        <button
          type="button"
          onClick={start}
          disabled={!compiled.definition || running || starting}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
        >
          {starting ? t('starting') : t('start')}
        </button>
      </div>
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
                  const done = ['succeeded', 'failed', 'cancelled'].includes(execution.status);
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
    </section>
  );
}
