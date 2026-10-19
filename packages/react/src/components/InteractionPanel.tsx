import {
  type EventOf,
  ExtensionUiNotice,
  ExtensionUiRequest,
  type UserAnswers,
  UserInputRequest,
  validUserAnswers,
} from '@corral/contracts';
import { pendingInteractions } from '@corral/core';
import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';

export function InteractionPanel({ session }: { session: RunSessionStore }) {
  const events = useStore(session, (s) => s.events);
  const projection = useStore(session, (s) => s.projection);
  const bodies = useStore(session, (s) => s.artifactTexts);
  const [failedRefs, setFailedRefs] = useState<Set<string>>(new Set());
  const [retry, setRetry] = useState(0);
  const t = useTranslations('Harness');
  const pending = pendingInteractions(events, projection).flatMap((item) =>
    item.kind === 'approval' ? [] : [item.event],
  );
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
      {pending.map((event) =>
        event.type === 'user_input.requested' ? (
          <UserQuestionPrompt
            key={event.payload.requestId}
            session={session}
            event={event}
            text={bodies[event.payload.bodyRef]}
            loadFailed={failedRefs.has(event.payload.bodyRef)}
            retry={() => {
              setFailedRefs(new Set());
              setRetry((n) => n + 1);
            }}
          />
        ) : (
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
        ),
      )}
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
          className="rounded fill-group p-2"
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
          className="rounded fill-group p-2"
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

function UserQuestionPrompt({
  session,
  event,
  text,
  loadFailed,
  retry,
}: {
  session: RunSessionStore;
  event: EventOf<'user_input.requested'>;
  text?: string;
  loadFailed: boolean;
  retry(): void;
}) {
  const t = useTranslations('Harness');
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, UserAnswers[number]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let request: UserInputRequest | null = null;
  try {
    request = text ? UserInputRequest.parse(JSON.parse(text)) : null;
  } catch {
    /* Invalid records are not answerable. */
  }
  const answers = request?.questions.map((q) => values[q.id] ?? { questionId: q.id }) ?? [];
  async function submit() {
    const state = session.getState();
    if (
      busy ||
      !request ||
      !validUserAnswers(request, answers) ||
      !state.projection ||
      state.runId !== event.runId
    )
      return;
    const container = form.current?.closest('[data-chat-view]');
    const ownedFocus = form.current?.contains(document.activeElement);
    setBusy(true);
    setError('');
    try {
      const receipt = await state.sendCommand({
        type: 'answer_user',
        expectedControlRevision: state.projection.controlRevision,
        payload: {
          requestId: event.payload.requestId,
          executionId: event.payload.executionId,
          attemptNo: event.payload.attemptNo,
          schemaHash: event.payload.schemaHash,
          answers,
        },
      });
      if (receipt.error) setError(receipt.error.message);
      else if (ownedFocus)
        requestAnimationFrame(() => {
          if (container?.isConnected && document.activeElement === document.body)
            container
              .querySelector<HTMLTextAreaElement>('[data-testid=chat-composer] textarea')
              ?.focus({ preventScroll: true });
        });
    } catch {
      setError(t('answerUnconfirmed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      ref={form}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229))
          event.preventDefault();
      }}
      className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label={t('userQuestions')}
    >
      <p role="status" className="text-xs font-medium text-muted">
        {t('userQuestions')}
      </p>
      <p className="text-2xs text-muted">
        {event.payload.executionId} · {t('attempt', { attempt: event.payload.attemptNo })}
      </p>
      {!request ? (
        <>
          <p>{t(loadFailed || text !== undefined ? 'questionUnavailable' : 'loadingPrompt')}</p>
          <Button type="button" size="sm" variant="outline" onClick={retry}>
            {t('retryPrompt')}
          </Button>
        </>
      ) : (
        request.questions.map((q) => {
          const value = values[q.id] ?? { questionId: q.id };
          return (
            <fieldset key={q.id} disabled={busy} className="flex flex-col gap-2">
              <legend className="font-medium">{q.prompt}</legend>
              {q.description ? (
                <p className="whitespace-pre-wrap break-words text-muted">{q.description}</p>
              ) : null}
              {q.options?.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-2 rounded p-1"
                >
                  <input
                    type={q.kind === 'multiple' ? 'checkbox' : 'radio'}
                    name={`${event.payload.requestId}_${q.id}`}
                    value={option.id}
                    checked={value.optionIds?.includes(option.id) ?? false}
                    onChange={(e) =>
                      setValues((current) => ({
                        ...current,
                        [q.id]:
                          q.kind === 'single'
                            ? { questionId: q.id, optionIds: [option.id] }
                            : {
                                ...value,
                                optionIds: e.target.checked
                                  ? [...(value.optionIds ?? []), option.id]
                                  : value.optionIds?.filter((id) => id !== option.id),
                              },
                      }))
                    }
                  />
                  <span>
                    {option.label}
                    {option.recommended ? ` (${t('recommended')})` : ''}
                    {option.description ? (
                      <span className="block text-xs text-muted">{option.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
              {q.kind === 'text' || q.allowFreeText ? (
                <label
                  className="flex flex-col gap-1"
                  htmlFor={`${event.payload.requestId}-${q.id}-text`}
                >
                  {t('yourAnswer')}
                  <Input
                    id={`${event.payload.requestId}-${q.id}-text`}
                    nativeInput
                    value={value.text ?? ''}
                    maxLength={12000}
                    onChange={(e) => {
                      const content = e.target.value;
                      setValues((current) => ({
                        ...current,
                        [q.id]: {
                          questionId: q.id,
                          ...(q.kind === 'multiple' && value.optionIds?.length
                            ? { optionIds: value.optionIds }
                            : {}),
                          ...(content.trim() ? { text: content } : {}),
                        },
                      }));
                    }}
                  />
                </label>
              ) : null}
            </fieldset>
          );
        })
      )}
      {request ? (
        <Button type="submit" size="sm" disabled={busy || !validUserAnswers(request, answers)}>
          {t('sendAnswer')}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
