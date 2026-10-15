import { type KeyboardEvent, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { StatusBadge } from './StatusBadge.tsx';

export interface SteerTarget {
  executionId: string;
  nodeLabel: string;
  /** Finished targets stay visible read-only so undelivered instructions are not hidden. */
  finished: boolean;
}

/**
 * Reins for one execution (Spec §4.4). The header always says who receives the instruction,
 * when it takes effect and how far it reaches. Directive badges change only on committed events.
 */
export function ReinsPanel({
  session,
  target,
}: {
  session: RunSessionStore;
  target: SteerTarget | null;
}) {
  const t = useTranslations('Reins');
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState('');
  const steer = useStore(session, (s) => s.steer);
  const pending = useStore(session, (s) => s.pendingCommandIds.length > 0);
  const receipts = useStore(session, (s) => s.receipts);
  const projection = useStore(session, (s) => s.projection);

  if (!target) {
    return (
      <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-2">
        <h2 id={`${inputId}-heading`} className="text-sm font-semibold">
          {t('heading')}
        </h2>
        <p className="text-sm text-muted">{t('noTarget')}</p>
      </section>
    );
  }

  const send = () => {
    const instruction = text.trim();
    if (!instruction || pending) return;
    setText('');
    void steer(target.executionId, instruction);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // IME: the Enter that confirms a Korean/Japanese composition must not send (UX-001).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const directives = (projection?.directiveOrder ?? [])
    .map((id) => projection?.directives[id])
    .filter((d) => d?.targetExecutionId === target.executionId);
  const latestReceipt = Object.values(receipts).at(-1);

  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3">
      <h2 id={`${inputId}-heading`} className="text-sm font-semibold">
        {t('heading')}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-line bg-raised p-2 text-xs">
        <dt className="text-muted">{t('target')}</dt>
        <dd>
          {target.nodeLabel} · execution {target.executionId}
        </dd>
        <dt className="text-muted">{t('delivery')}</dt>
        <dd>{t('deliveryValue')}</dd>
        <dt className="text-muted">{t('scope')}</dt>
        <dd>{t('scopeValue')}</dd>
      </dl>

      {target.finished ? (
        <p className="text-xs text-muted">{t('finished')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-xs font-medium">
            {t('instruction')}
          </label>
          <textarea
            id={inputId}
            aria-describedby={hintId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            className="w-full resize-y rounded-md border border-line bg-surface p-2 text-sm"
          />
          <p id={hintId} className="text-xs text-muted">
            {t('instructionHint')}
          </p>
          <button
            type="button"
            onClick={send}
            disabled={pending || text.trim() === ''}
            className="self-end rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
          >
            {pending ? t('sending') : t('send')}
          </button>
        </div>
      )}

      <p role="status" aria-live="polite" className="min-h-4 text-xs">
        {latestReceipt
          ? t(`receipt.${latestReceipt.status}`, { message: latestReceipt.error?.message ?? '' })
          : null}
      </p>

      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold">{t('history')}</h3>
        {directives.length === 0 ? (
          <p className="text-xs text-muted">{t('noHistory')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {directives.map((d) =>
              d ? (
                <li key={d.directiveId} className="flex items-start justify-between gap-2 text-xs">
                  <span className="break-words">{d.text}</span>
                  <StatusBadge status={d.status} />
                </li>
              ) : null,
            )}
          </ul>
        )}
        <p className="text-xs text-muted">{t('deliveredNote')}</p>
      </div>
    </section>
  );
}
