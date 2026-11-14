import {
  type EventOf,
  ExtensionUiNotice,
  ExtensionUiRequest,
  type RunEvent,
  UserAnswers,
  UserInputRequest,
  validUserAnswers,
} from '@corral/contracts';
import { pendingInteractions, type RunProjection } from '@corral/core';
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Check, Copy } from '../design-kit/icons.ts';
import {
  AgentCard,
  AgentStatusIcon,
  Banner,
  BannerTitle,
  Button,
  fontWeights,
  Input,
  Select,
  Tooltip,
} from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { FirstRow } from './FirstRow.tsx';
import { useFreshDecisions } from './freshDecisions.ts';
import {
  RequestAreaContext,
  RequestCardFoot,
  RequestCardHead,
  RequestRunContext,
  requestCard,
  useRequestOwner,
} from './RequestCard.tsx';
import { nextResponseTarget } from './responseFocus.ts';

/** Whether the panel shows: a question or extension prompt waits, or an extension said something. */
export const interactionShown = (events: readonly RunEvent[], projection: RunProjection | null) =>
  pendingInteractions(events, projection).some((item) => item.kind !== 'approval') ||
  events.some((event) => event.type === 'extension.ui_notified');

/** What an answer said, in one line: the options picked and the words written, per question. */
function answerSummary(requestText: string | undefined, answerText: string | undefined) {
  if (!requestText || !answerText) return null;
  try {
    const request = UserInputRequest.parse(JSON.parse(requestText));
    const answers = UserAnswers.parse(JSON.parse(answerText)?.answers);
    const words = answers
      .map((answer) => {
        const question = request.questions.find((q) => q.id === answer.questionId);
        return [
          ...(question?.options ?? [])
            .filter((option) => answer.optionIds?.includes(option.id))
            .map((option) => option.label),
          ...(answer.text ? [answer.text] : []),
        ].join(', ');
      })
      .filter(Boolean)
      .join(' · ');
    // The line cuts the rest on screen; this only keeps a long answer out of the page.
    // By code point, so a character outside the basic plane is never cut in half.
    return (
      Array.from(words.trim().split('\n')[0] ?? '')
        .slice(0, 200)
        .join('') || null
    );
  } catch {
    return null;
  }
}

/** What an expansion request was answered with, in one line: the choice or words, or yes or no. */
function extensionAnswerSummary(
  answerText: string | undefined,
  words: { yes: string; no: string },
) {
  if (!answerText) return null;
  try {
    const value: unknown = JSON.parse(answerText);
    if (typeof value === 'boolean') return value ? words.yes : words.no;
    if (typeof value !== 'string') return null;
    // As a question's answer line: its first line, kept out of the page past 200 code points.
    return (
      Array.from(value.trim().split('\n')[0] ?? '')
        .slice(0, 200)
        .join('') || null
    );
  } catch {
    return null;
  }
}

export function InteractionPanel({
  session,
  action,
  readOnly = false,
}: {
  session: RunSessionStore;
  /** A control of the host's frame, at the end of the first row (see ApprovalPanel). */
  action?: ReactNode;
  /** The prompts to read only; another place on the same screen answers them (ApprovalPanel). */
  readOnly?: boolean;
}) {
  const events = useStore(session, (s) => s.events);
  const projection = useStore(session, (s) => s.projection);
  const bodies = useStore(session, (s) => s.artifactTexts);
  const [failedRefs, setFailedRefs] = useState<Set<string>>(new Set());
  const [retry, setRetry] = useState(0);
  const t = useTranslations('Harness');
  const inArea = useContext(RequestAreaContext);
  const waiting = pendingInteractions(events, projection);
  const pendingIds = new Set(
    waiting.flatMap((item) => (item.kind === 'approval' ? [] : [item.event.payload.requestId])),
  );
  // A question or an expansion request answered in this run folds into one line in its place
  // while the run still waits on something, as a decided approval does; once nothing waits, it
  // leaves with the area. Only answers of the current wait fold into a line; earlier waits' never
  // come back.
  const fresh = useFreshDecisions(session, 'answer');
  const answers = new Map(
    (waiting.length ? events : []).flatMap((event) =>
      (event.type === 'user_input.answered' || event.type === 'extension.ui_answered') &&
      fresh(event.payload.requestId)
        ? [[event.payload.requestId, event] as const]
        : [],
    ),
  );
  const requests = [
    ...new Map(
      events.flatMap((event) =>
        (event.type === 'user_input.requested' || event.type === 'extension.ui_requested') &&
        (pendingIds.has(event.payload.requestId) || answers.has(event.payload.requestId))
          ? [[event.payload.requestId, event] as const]
          : [],
      ),
    ).values(),
  ];
  const pending = requests.filter((event) => pendingIds.has(event.payload.requestId));
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
  const refs = [
    ...requests.map((event) => event.payload.bodyRef),
    ...[...answers.values()].map((event) => event.payload.answerRef),
    ...notices.map((event) => event.payload.bodyRef),
  ].join(',');
  useEffect(() => {
    void retry;
    let active = true;
    for (const ref of refs.split(',').filter(Boolean))
      void (async () => {
        try {
          if (session.getState().artifactTexts[ref] === undefined)
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
  if (!requests.length && !notices.length) return null;
  const shownNotices = notices.flatMap((event) => {
    const text = bodies[event.payload.bodyRef];
    if (!text) return [];
    try {
      const notice = ExtensionUiNotice.parse(JSON.parse(text));
      return notice.text ? [{ event, notice }] : [];
    } catch {
      return [];
    }
  });
  // The host's control sits in the first waiting prompt's head, else in the first notice's row.
  const lead = pending[0]?.payload.requestId;
  return (
    <section
      {...(inArea
        ? {}
        : { 'aria-label': pending.length ? t('extensionUi') : t('extensionNotice') })}
      className="flex flex-col gap-2"
    >
      {requests.map((event) => {
        const answered = answers.get(event.payload.requestId);
        if (answered) {
          const summary =
            event.type === 'user_input.requested'
              ? answerSummary(bodies[event.payload.bodyRef], bodies[answered.payload.answerRef])
              : extensionAnswerSummary(bodies[answered.payload.answerRef], {
                  yes: t('confirmYes'),
                  no: t('confirmNo'),
                });
          return (
            <p
              key={event.payload.requestId}
              data-testid={`answered-${event.payload.requestId}`}
              className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground"
            >
              <AgentStatusIcon status="done" size={12} className="shrink-0" />
              <span className="min-w-0 truncate">
                {summary ? t('answeredLine', { answer: summary }) : t('answered')}
              </span>
            </p>
          );
        }
        const own = event.payload.requestId === lead ? action : undefined;
        return event.type === 'user_input.requested' ? (
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
            action={own}
            readOnly={readOnly}
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
            action={own}
            readOnly={readOnly}
          />
        );
      })}
      {shownNotices.map(({ event, notice }, index) => (
        <FirstRow key={event.eventId} action={!pending.length && index === 0 ? action : undefined}>
          <p
            role="status"
            className={`text-caption ${notice.level === 'info' ? 'text-muted-foreground' : 'text-warning'}`}
          >
            {t('extensionNotice')} · {notice.text}
          </p>
        </FirstRow>
      ))}
      {/* Notices whose text is not kept show nothing; the host's control still has its place. */}
      {!pending.length && !shownNotices.length && action ? (
        <FirstRow action={action}>{null}</FirstRow>
      ) : null}
    </section>
  );
}

/**
 * Who asks, under a request card's title: the role and run where the place names them
 * (`useRequestOwner`), the Loop round, and the attempt once it is not the first.
 */
function useAskedBy(session: RunSessionStore, executionId: string, attemptNo: number) {
  const t = useTranslations('Harness');
  const owner = useRequestOwner(session);
  const round = useStore(session, (s) => {
    const iterationId = s.projection?.executions[executionId]?.iterationId;
    return iterationId ? s.projection?.iterations[iterationId]?.no : undefined;
  });
  return (extra?: string | null) =>
    [
      owner({ executionId }),
      round ? t('round', { round }) : null,
      attemptNo > 1 ? t('attempt', { attempt: attemptNo }) : null,
      extra ?? null,
    ]
      .filter(Boolean)
      .join(' · ') || null;
}

/**
 * The exact execution id for a report, one copy away: a diagnostic, so it stays in the card's
 * folded details (chat-widgets-contract.md), where the id it copies is written beside it.
 */
function ExecutionDetails({ executionId }: { executionId: string }) {
  const tf = useTranslations('Failure');
  return (
    <details className="text-muted-foreground">
      <summary className="w-fit cursor-pointer">{tf('diagnostics')}</summary>
      <span className="mt-1 flex min-w-0 items-center gap-1">
        <code className="min-w-0 truncate">{executionId}</code>
        <CopyExecutionId executionId={executionId} />
      </span>
    </details>
  );
}

function CopyExecutionId({ executionId }: { executionId: string }) {
  const t = useTranslations('Harness');
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Tooltip content={copied ? t('executionIdCopied') : t('copyExecutionId')}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('copyExecutionId')}
          onClick={() =>
            void navigator.clipboard?.writeText(executionId).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </Tooltip>
      <span role="status" className="sr-only">
        {copied ? t('executionIdCopied') : ''}
      </span>
    </>
  );
}

/** A refused or unconfirmed answer, in its card, as a refused decision is. */
function CardAlert({ message }: { message: string }) {
  return message ? (
    <Banner role="alert" status="error" className="mx-3 mb-3">
      <BannerTitle>{message}</BannerTitle>
    </Banner>
  ) : null;
}

function ExtensionPrompt({
  session,
  event,
  text,
  loadFailed,
  retry,
  action,
  readOnly,
}: {
  session: RunSessionStore;
  event: EventOf<'extension.ui_requested'>;
  text: string | undefined;
  loadFailed: boolean;
  retry(): void;
  action?: ReactNode;
  readOnly: boolean;
}) {
  const t = useTranslations('Harness');
  const format = useFormatter();
  const askedBy = useAskedBy(session, event.payload.executionId, event.payload.attemptNo);
  const titleId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const card = useRef<HTMLDivElement>(null);
  let request: ExtensionUiRequest | null = null;
  try {
    request = text ? ExtensionUiRequest.parse(JSON.parse(text)) : null;
  } catch {
    /* Invalid private records are never executable UI. */
  }
  async function answer(value: string | boolean | null) {
    const state = session.getState();
    if (!state.projection || state.runId !== event.runId) return;
    // As an answered question does: the response place this card stands in, the chat view around
    // it, and whether focus was in the card when it was answered.
    const container = card.current?.closest('[data-chat-view]');
    const place =
      card.current?.closest('[data-pending-tray]') ?? card.current?.closest('[data-run-response]');
    const answered = card.current;
    const ownedFocus = card.current?.contains(document.activeElement);
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
      else if (ownedFocus)
        // The next waiting card's main action, else the request box.
        requestAnimationFrame(() => {
          if (
            (container?.isConnected || place?.isConnected) &&
            document.activeElement === document.body
          )
            nextResponseTarget(place?.isConnected ? place : null, container, answered)?.focus({
              preventScroll: true,
            });
        });
    } catch {
      setError(t('answerUnconfirmed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AgentCard
      ref={card}
      role="article"
      aria-labelledby={titleId}
      className="text-caption"
      data-testid={`extension-ui-${event.payload.requestId}`}
      data-extension={event.payload.requestId}
    >
      <RequestCardHead
        titleId={titleId}
        title={
          request?.title ??
          t(loadFailed || text !== undefined ? 'promptUnavailable' : 'loadingPrompt')
        }
        owner={[t('extensionUi'), askedBy()].filter(Boolean).join(' · ')}
        action={action}
      />
      <div className={requestCard.body}>
        {!request && loadFailed ? (
          <span>
            <Button variant="tertiary" onClick={retry}>
              {t('retryPrompt')}
            </Button>
          </span>
        ) : null}
        {request?.kind === 'confirm' ? (
          <p className="whitespace-pre-wrap break-words text-foreground">{request.message}</p>
        ) : null}
        {readOnly ? null : request?.kind === 'select' ? (
          <Select
            label={request.title}
            disabled={busy}
            value={value}
            onValueChange={setValue}
            options={[
              { value: '', label: t('chooseOption') },
              ...request.options.map((option) => ({ value: option, label: option })),
            ]}
          />
        ) : null}
        {!readOnly && request?.kind === 'input' ? (
          <Input
            aria-label={request.title}
            disabled={busy}
            value={value}
            maxLength={12000}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : null}
        <p className="text-muted-foreground">
          {t('expires', {
            time: format.dateTime(new Date(event.payload.deadline), {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }),
          })}
        </p>
        <ExecutionDetails executionId={event.payload.executionId} />
      </div>
      {readOnly ? null : (
        <RequestCardFoot>
          <Button variant="tertiary" disabled={busy} onClick={() => void answer(null)}>
            {t('dismissPrompt')}
          </Button>
          {request?.kind === 'confirm' ? (
            <>
              <Button variant="tertiary" disabled={busy} onClick={() => void answer(false)}>
                {t('confirmNo')}
              </Button>
              <Button
                data-extension-action="primary"
                disabled={busy}
                onClick={() => void answer(true)}
              >
                {t('confirmYes')}
              </Button>
            </>
          ) : request ? (
            <Button
              data-extension-action="primary"
              disabled={busy || (request.kind === 'select' && !value)}
              onClick={() => void answer(value)}
            >
              {t('sendAnswer')}
            </Button>
          ) : null}
        </RequestCardFoot>
      )}
      <CardAlert message={error} />
    </AgentCard>
  );
}

function UserQuestionPrompt({
  session,
  event,
  text,
  loadFailed,
  retry,
  action,
  readOnly,
}: {
  session: RunSessionStore;
  event: EventOf<'user_input.requested'>;
  text?: string;
  loadFailed: boolean;
  retry(): void;
  action?: ReactNode;
  readOnly: boolean;
}) {
  const t = useTranslations('Harness');
  const askedBy = useAskedBy(session, event.payload.executionId, event.payload.attemptNo);
  const run = useContext(RequestRunContext);
  const form = useRef<HTMLFormElement>(null);
  const stepHeading = useRef<HTMLParagraphElement>(null);
  const headingId = useId();
  const [values, setValues] = useState<Record<string, UserAnswers[number]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // With two or more questions, one question per step and then a review step (index = count).
  const [step, setStep] = useState(0);
  const moved = useRef(false);
  let request: UserInputRequest | null = null;
  try {
    request = text ? UserInputRequest.parse(JSON.parse(text)) : null;
  } catch {
    /* Invalid records are not answerable. */
  }
  const answers = request?.questions.map((q) => values[q.id] ?? { questionId: q.id }) ?? [];
  const count = request?.questions.length ?? 0;
  const stepped = count >= 2;
  const reviewing = stepped && step >= count;
  useEffect(() => {
    void step;
    // Only a step change moves focus; the first render leaves it where the person is.
    if (moved.current) stepHeading.current?.focus();
  }, [step]);
  const goTo = (index: number) => {
    moved.current = true;
    setStep(Math.max(0, Math.min(count, index)));
  };
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
    // The response place: a conversation's needed-now tray, else the run's whole response area
    // (Needs you, the Run page), so the card beside this one is next.
    const place =
      form.current?.closest('[data-pending-tray]') ?? form.current?.closest('[data-run-response]');
    const card = form.current?.closest('[data-question]');
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
        // As a decided approval does: the next waiting card's main action, else the request box.
        requestAnimationFrame(() => {
          if (
            (container?.isConnected || place?.isConnected) &&
            document.activeElement === document.body
          )
            nextResponseTarget(place?.isConnected ? place : null, container, card)?.focus({
              preventScroll: true,
            });
        });
    } catch {
      setError(t('answerUnconfirmed'));
    } finally {
      setBusy(false);
    }
  }
  // The card's title is the question itself (the step's, in a stepped request), so the asked
  // sentence reads first; the step count joins who asks under it.
  const unavailable = t(loadFailed || text !== undefined ? 'questionUnavailable' : 'loadingPrompt');
  const title = !request
    ? unavailable
    : reviewing
      ? t('reviewAnswers')
      : (request.questions[stepped ? step : 0]?.prompt ?? '');
  const owner = askedBy(
    stepped && !reviewing ? t('questionStep', { current: step + 1, total: count }) : null,
  );
  const head = (
    <RequestCardHead
      title={title}
      titleId={headingId}
      {...(readOnly ? {} : { titleRef: stepHeading })}
      owner={owner}
      action={action}
    />
  );
  const questionFieldset = (q: UserInputRequest['questions'][number], hidden = false) => {
    const value = values[q.id] ?? { questionId: q.id };
    return (
      <fieldset
        key={q.id}
        disabled={busy}
        hidden={hidden}
        aria-label={q.prompt}
        className="flex min-w-0 flex-col gap-2"
      >
        {q.description ? (
          <p className="whitespace-pre-wrap break-words text-muted-foreground">{q.description}</p>
        ) : null}
        {q.options?.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-start gap-2 rounded text-foreground"
          >
            <input
              type={q.kind === 'multiple' ? 'checkbox' : 'radio'}
              name={`${event.payload.requestId}_${q.id}`}
              value={option.id}
              className="mt-0.5"
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
              {option.recommended ? (
                <span className="text-muted-foreground"> ({t('recommended')})</span>
              ) : null}
              {option.description ? (
                <span className="block text-muted-foreground">{option.description}</span>
              ) : null}
            </span>
          </label>
        ))}
        {q.kind === 'text' || q.allowFreeText ? (
          <label
            className="flex flex-col gap-1"
            htmlFor={`${event.payload.requestId}-${q.id}-text`}
          >
            {/* A lone text field sits right under its question; beside options it names itself. */}
            <span className={q.options?.length ? 'text-muted-foreground' : 'sr-only'}>
              {t('yourAnswer')}
            </span>
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
  };
  if (readOnly)
    return (
      <AgentCard
        role="article"
        aria-labelledby={headingId}
        data-question={event.payload.requestId}
        className="text-caption"
      >
        {head}
        {request ? (
          <div className={requestCard.body}>
            {request.questions.map((q, index) => (
              <div key={q.id} className="flex flex-col gap-1">
                {/* The first question is the title; the others read in turn below it. */}
                {index > 0 ? (
                  <p
                    className="text-foreground"
                    style={{ fontVariationSettings: fontWeights.semibold }}
                  >
                    {q.prompt}
                  </p>
                ) : null}
                {q.description ? (
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">
                    {q.description}
                  </p>
                ) : null}
              </div>
            ))}
            <ExecutionDetails executionId={event.payload.executionId} />
          </div>
        ) : null}
      </AgentCard>
    );
  return (
    <AgentCard data-question={event.payload.requestId} className="text-caption">
      <form
        ref={form}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229))
            event.preventDefault();
        }}
        className="flex min-w-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          // A question step's submit (Next, or Enter in a text answer) only moves on.
          if (stepped && !reviewing) goTo(step + 1);
          else void submit();
        }}
        // Each question's form is its own landmark, told apart by its first question, and by its
        // run where several runs' requests stand together.
        aria-label={[
          run,
          request?.questions[0]
            ? t('userQuestionsNamed', { question: request.questions[0].prompt })
            : t('userQuestions'),
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        {head}
        <div className={requestCard.body}>
          {!request ? (
            <span>
              <Button type="button" variant="tertiary" onClick={retry}>
                {t('retryPrompt')}
              </Button>
            </span>
          ) : stepped ? (
            <>
              {/* Every question keeps its native fieldset; only the current step is shown. */}
              {request.questions.map((q, index) => questionFieldset(q, index !== step))}
              {reviewing ? (
                <ul aria-labelledby={headingId} className="flex flex-col divide-y divide-border">
                  {request.questions.map((q, index) => (
                    <ReviewRow
                      key={q.id}
                      question={q}
                      answer={values[q.id]}
                      busy={busy}
                      onEdit={() => goTo(index)}
                    />
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            request.questions.map((q) => questionFieldset(q))
          )}
          <ExecutionDetails executionId={event.payload.executionId} />
        </div>
        {request ? (
          <RequestCardFoot>
            {stepped && step > 0 ? (
              <Button
                type="button"
                variant="tertiary"
                disabled={busy}
                onClick={() => goTo(step - 1)}
              >
                {t('previousQuestion')}
              </Button>
            ) : null}
            {stepped && !reviewing ? (
              <Button type="submit">{t('nextQuestion')}</Button>
            ) : (
              <Button type="submit" disabled={busy || !validUserAnswers(request, answers)}>
                {t('sendAnswer')}
              </Button>
            )}
          </RequestCardFoot>
        ) : null}
        <CardAlert message={error} />
      </form>
    </AgentCard>
  );
}

/** One question on the review step: its answer, or that an answer is still required. */
function ReviewRow({
  question,
  answer,
  busy,
  onEdit,
}: {
  question: UserInputRequest['questions'][number];
  answer: UserAnswers[number] | undefined;
  busy: boolean;
  onEdit(): void;
}) {
  const t = useTranslations('Harness');
  const given = answer ?? { questionId: question.id };
  // Every question needs an answer; this is the shared rule, asked about this one question.
  const missing = !validUserAnswers({ key: question.id, questions: [question] }, [given]);
  const summary = [
    ...(question.options ?? [])
      .filter((option) => given.optionIds?.includes(option.id))
      .map((option) => option.label),
    ...(given.text ? [given.text] : []),
  ].join(', ');
  return (
    <li className="flex items-start gap-2 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="break-words text-foreground"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {question.prompt}
        </span>
        {missing ? (
          <span className="text-warning">{t('answerMissing')}</span>
        ) : (
          <span className="whitespace-pre-wrap break-words text-muted-foreground">{summary}</span>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        aria-label={t('editAnswerFor', { question: question.prompt })}
        onClick={onEdit}
      >
        {t('editAnswer')}
      </Button>
    </li>
  );
}
