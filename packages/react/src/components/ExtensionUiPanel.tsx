import {
  type EventOf,
  ExtensionUiNotice,
  ExtensionUiRequest,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { Button } from '../ui/button.tsx';

export function ExtensionUiPanel({ session }: { session: RunSessionStore }) {
  const events = useStore(session, (s) => s.events);
  const projection = useStore(session, (s) => s.projection);
  const bodies = useStore(session, (s) => s.artifactTexts);
  const [failedRefs, setFailedRefs] = useState<Set<string>>(new Set());
  const [retry, setRetry] = useState(0);
  const t = useTranslations('Harness');
  const closed = new Set(
    events
      .filter(
        (event) => event.type === 'extension.ui_answered' || event.type === 'extension.ui_expired',
      )
      .map((event) => event.payload.requestId),
  );
  const pending = events
    .filter((event) => event.type === 'extension.ui_requested')
    .filter((event) => {
      const execution = projection?.executions[event.payload.executionId];
      return (
        !closed.has(event.payload.requestId) &&
        execution?.status === 'waiting_approval' &&
        execution.attemptNo === event.payload.attemptNo &&
        projection &&
        !TERMINAL_RUN_STATUSES.has(projection.status) &&
        projection.status !== 'cancelling'
      );
    });
  const notices = [
    ...new Map(
      events
        .filter((event) => event.type === 'extension.ui_notified')
        .map((event) => [
          event.payload.kind === 'status'
            ? `${event.payload.executionId}:${event.payload.key}`
            : event.eventId,
          event,
        ]),
    ).values(),
  ].slice(-8);
  const refs = [...pending, ...notices].map((event) => event.payload.bodyRef).join(',');
  useEffect(() => {
    void retry;
    let active = true;
    for (const ref of refs.split(',').filter(Boolean))
      void (async () => {
        try {
          await session.getState().loadArtifact(ref);
          if (!session.getState().artifactTexts[ref]) throw new Error('missing prompt');
        } catch {
          if (active) setFailedRefs((current) => new Set([...current, ref]));
        }
      })();
    return () => {
      active = false;
    };
  }, [session, refs, retry]);
  if (!pending.length && !notices.length) return null;
  return (
    <section aria-label={t('extensionUi')} className="flex flex-col gap-2">
      {pending.map((event) => (
        <ExtensionPrompt
          key={event.payload.requestId}
          session={session}
          event={event}
          text={bodies[event.payload.bodyRef]}
          loadFailed={failedRefs.has(event.payload.bodyRef)}
          retry={() => {
            setFailedRefs((current) => {
              const next = new Set(current);
              next.delete(event.payload.bodyRef);
              return next;
            });
            setRetry((current) => current + 1);
          }}
        />
      ))}
      {notices.map((event) => {
        const text = bodies[event.payload.bodyRef];
        if (!text) return null;
        let notice: ExtensionUiNotice;
        try {
          notice = ExtensionUiNotice.parse(JSON.parse(text));
        } catch {
          return null;
        }
        return notice.text ? (
          <p
            key={event.eventId}
            role="status"
            className={`text-xs ${notice.level === 'info' ? 'text-muted' : 'text-warning'}`}
          >
            {t('extensionNotice')} · {notice.text}
          </p>
        ) : null;
      })}
    </section>
  );
}

function ExtensionPrompt({
  session,
  event,
  text,
  loadFailed,
  retry,
}: {
  session: RunSessionStore;
  event: EventOf<'extension.ui_requested'>;
  text: string | undefined;
  loadFailed: boolean;
  retry(): void;
}) {
  const t = useTranslations('Harness');
  const format = useFormatter();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let request: ExtensionUiRequest | null = null;
  try {
    request = text ? ExtensionUiRequest.parse(JSON.parse(text)) : null;
  } catch {
    /* Invalid private records are never executable UI. */
  }
  async function answer(value: string | boolean | null) {
    const state = session.getState();
    if (!state.projection || state.runId !== event.runId) return;
    setBusy(true);
    setError('');
    try {
      const receipt = await state.sendCommand({
        type: 'answer_extension_ui',
        expectedControlRevision: state.projection.controlRevision,
        payload: {
          requestId: event.payload.requestId,
          executionId: event.payload.executionId,
          attemptNo: event.payload.attemptNo,
          value,
        },
      });
      if (receipt.error) setError(receipt.error.message);
    } catch {
      setError(t('answerUnconfirmed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm"
      data-testid={`extension-ui-${event.payload.requestId}`}
    >
      <p className="text-xs font-medium text-muted">{t('extensionUi')}</p>
      <h3 className="font-medium">
        {request?.title ??
          t(loadFailed || text !== undefined ? 'promptUnavailable' : 'loadingPrompt')}
      </h3>
      {!request && loadFailed ? (
        <Button size="sm" variant="outline" onClick={retry}>
          {t('retryPrompt')}
        </Button>
      ) : null}
      <p className="text-2xs text-muted">
        {event.payload.executionId} · {t('attempt', { attempt: event.payload.attemptNo })} ·{' '}
        {event.payload.requestId}
      </p>
      <p className="text-xs text-muted">
        {t('expires', {
          time: format.dateTime(new Date(event.payload.deadline), {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
        })}
      </p>
      {request?.kind === 'confirm' ? (
        <p className="whitespace-pre-wrap break-words">{request.message}</p>
      ) : null}
      {request?.kind === 'select' ? (
        <select
          aria-label={request.title}
          disabled={busy}
          className="rounded border border-line bg-surface p-2"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">{t('chooseOption')}</option>
          {request.options.map((option, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: This request's options are immutable and may repeat labels.
            <option key={`${index}:${option}`} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : null}
      {request?.kind === 'input' ? (
        <input
          aria-label={request.title}
          disabled={busy}
          className="rounded border border-line bg-surface p-2"
          value={value}
          maxLength={12000}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {request?.kind === 'confirm' ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
              {t('confirmYes')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer(false)}>
              {t('confirmNo')}
            </Button>
          </>
        ) : request ? (
          <Button
            size="sm"
            disabled={busy || (request.kind === 'select' && !value)}
            onClick={() => void answer(value)}
          >
            {t('sendAnswer')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(null)}>
          {t('dismissPrompt')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </article>
  );
}
