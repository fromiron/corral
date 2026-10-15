import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { StatusBadge } from './StatusBadge.tsx';

/** Receipt state comes from the command record, never the HTTP status or a local click. */
export function CommandReceipts({ session, target }: { session: RunSessionStore; target: string }) {
  const t = useTranslations('Reins');
  const receipts = useStore(session, (s) => s.receipts);
  const error = useStore(session, (s) => s.commandError);
  const unknown = useStore(session, (s) => s.unconfirmedCommands);
  const pending = useStore(session, (s) => s.pendingCommandIds);
  const matching = Object.values(receipts).filter((receipt) => receipt.target === target);
  return (
    <div className="flex flex-col gap-1 text-xs" aria-live="polite">
      {error ? (
        <p role="alert" className="text-danger">
          {t('connectionUnknown', { message: error })}
        </p>
      ) : null}
      {matching.length > 0 ? <h3 className="font-semibold">{t('receipts')}</h3> : null}
      {Object.values(unknown)
        .filter(({ command }) => target === `run:${command.runId}`)
        .map(({ command, error }) => (
          <div key={command.commandId} className="rounded border border-warning p-2">
            <p className="font-mono">
              {command.commandId} · {command.type}
            </p>
            <p role="alert">{t('connectionUnknown', { message: error })}</p>
            <button
              type="button"
              disabled={pending.includes(command.commandId)}
              className="rounded border border-line px-2 py-1 disabled:opacity-50"
              onClick={() =>
                void session
                  .getState()
                  .retryCommand(command.commandId)
                  .catch(() => undefined)
              }
            >
              {t('retrySameCommand')}
            </button>
          </div>
        ))}
      {matching.map((receipt) => (
        <div
          key={receipt.commandId}
          className="rounded border border-line p-2"
          data-testid={`receipt-${receipt.commandId}`}
        >
          <p>
            <span className="font-mono">{receipt.commandId}</span> ·{' '}
            <StatusBadge status={receipt.status} />
          </p>
          <p className="text-muted">{t(`boundary.${receipt.requestedBoundary}`)}</p>
          {receipt.error ? (
            <p role="alert" className="text-danger">
              {receipt.error.code}: {receipt.error.message}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
