import type { MeetingDecisionContent, MeetingView } from '@corral/contracts';
import { activeMeetingDecision, type WorkSession } from '@corral/core';
import { Button, fontWeights, Textarea } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';
import { MeetingDiagnostics } from './MeetingDiagnostics.tsx';
import { MeetingHandoff } from './MeetingHandoff.tsx';
import { reveal } from './reviewNavigation.ts';

const semibold = { fontVariationSettings: fontWeights.semibold };
const normal = { fontVariationSettings: fontWeights.normal };

const fields = [
  'scope',
  'excludedScope',
  'acceptanceCriteria',
  'remainingDissent',
  'evidence',
  'risks',
  'actions',
  'rejectedAlternatives',
] as const;
type Draft = {
  minutesId: string;
  candidateId: string;
  content: MeetingDecisionContent;
  supersedesVersionId?: string;
};
type Withdrawal = { versionId: string; reason: string };
interface DecisionEdit {
  draft: Draft | null;
  withdrawal: Withdrawal | null;
  /** The command that saves this exact body, reused when its response was lost. */
  command: { key: string; id: string } | null;
}

/**
 * Each meeting's decision draft or withdrawal reason being typed, by meeting ID, for the life of
 * this page. The records remount when the narrow drawer closes or the window crosses 1024px; the
 * text and its pending command stay here until it is saved, cancelled or replaced by another edit.
 */
export const meetingDecisionEdits = createStore<Record<string, DecisionEdit>>(() => ({}));
const noEdit: DecisionEdit = { draft: null, withdrawal: null, command: null };
function changeEdit(sessionId: string, change: Partial<DecisionEdit>) {
  meetingDecisionEdits.setState((all) => {
    const next = { ...(all[sessionId] ?? noEdit), ...change };
    const { [sessionId]: _previous, ...others } = all;
    return next.draft || next.withdrawal || next.command
      ? { ...others, [sessionId]: next }
      : others;
  }, true);
}

/** Candidates stay proposals until the person saves an immutable decision version. */
export function MeetingDecisions({
  session,
  view,
  onChange,
}: {
  session: WorkSession;
  view: MeetingView;
  onChange(): Promise<void>;
}) {
  const t = useTranslations('MeetingsDecisions');
  const format = useFormatter();
  const { meetings } = useServices();
  const sessionId = session.sessionId;
  const draft = useStore(meetingDecisionEdits, (all) => all[sessionId]?.draft ?? null);
  const setDraft = (next: Draft | null) => changeEdit(sessionId, { draft: next });
  const withdrawal = useStore(meetingDecisionEdits, (all) => all[sessionId]?.withdrawal ?? null);
  const setWithdrawal = (next: Withdrawal | null) => changeEdit(sessionId, { withdrawal: next });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A form opened from a button comes into view with focus on its first field; cancelling it
  // returns focus to that button. A draft restored on remount takes no focus.
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const bringForm = useRef(false);
  const openDraft = (next: Draft, origin: HTMLElement) => {
    opener.current = origin;
    bringForm.current = true;
    setDraft(next);
    setWithdrawal(null);
  };
  const closeDraft = () => {
    setDraft(null);
    if (opener.current?.isConnected) opener.current.focus();
  };
  useEffect(() => {
    if (!draft || !bringForm.current) return;
    bringForm.current = false;
    reveal(form.current);
    form.current
      ?.querySelector<HTMLTextAreaElement>('textarea[name="goal"]')
      ?.focus({ preventScroll: true });
  }, [draft]);
  const nameOf = (id: string) =>
    view.config.participants.find((p) => p.participantId === id)?.name ?? id;
  const run = async (kind: 'adopt' | 'withdraw') => {
    const cleanedDraft = draft && {
      ...draft,
      content: {
        ...draft.content,
        goal: draft.content.goal.trim(),
        ...Object.fromEntries(
          fields.map((field) => [
            field,
            draft.content[field].map((line) => line.trim()).filter(Boolean),
          ]),
        ),
      },
    };
    const body = kind === 'adopt' ? cleanedDraft : withdrawal;
    if (!body || busy) return;
    const key = JSON.stringify([kind, body]);
    const pending = meetingDecisionEdits.getState()[sessionId]?.command;
    const commandId = pending?.key === key ? pending.id : newCommandId();
    changeEdit(sessionId, { command: { key, id: commandId } });
    setBusy(true);
    setError('');
    try {
      const result =
        kind === 'adopt' && cleanedDraft
          ? await meetings.adopt(sessionId, { ...cleanedDraft, commandId })
          : withdrawal
            ? await meetings.withdraw(sessionId, { ...withdrawal, commandId })
            : null;
      if (!result) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      changeEdit(sessionId, { draft: null, withdrawal: null, command: null });
      await onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const displayedMinutes = view.minutes?.filter(
    (minutes, index, all) => minutes.document || index === all.length - 1,
  );
  return (
    // The records' own heading names this part; candidates explain themselves on it.
    <section className="flex min-w-0 flex-col gap-4 text-body" aria-label={t('heading')}>
      {!view.minutes?.length ? <p className="text-muted-foreground">{t('empty')}</p> : null}
      {displayedMinutes?.map((minutes) => {
        const doc = minutes.document;
        const index = view.rounds.findIndex((round) => round.roundId === minutes.roundId);
        const nonresponses = view.rounds
          .slice(0, index + 1)
          .flatMap((round) =>
            round.answers
              .filter(
                (answer) => answer.participantId !== 'secretary' && answer.status !== 'answered',
              )
              .map((answer) => ({ roundId: round.roundId, ...answer })),
          );
        return (
          <article
            key={minutes.minutesId}
            className="flex min-w-0 flex-col gap-3 rounded-lg fill-group p-3"
            aria-label={t('minutes')}
          >
            <h3 className="flex flex-wrap items-baseline gap-x-2 text-subtitle" style={semibold}>
              {t('minutes')}
              <time
                dateTime={minutes.createdAt}
                className="text-caption text-muted-foreground"
                style={normal}
              >
                {format.dateTime(new Date(minutes.createdAt), {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                })}
              </time>
            </h3>
            {minutes.error ? (
              <div role="note" className="text-danger wrap-anywhere">
                {t('invalidMinutes')}
                <MeetingDiagnostics text={minutes.error} />
              </div>
            ) : null}
            {doc ? (
              <>
                <TextList title={t('issues')} values={doc.issues} />
                <TextList
                  title={t('claims')}
                  values={doc.claims.map(
                    (claim) => `${nameOf(claim.participantId)}: ${claim.text}`,
                  )}
                />
                <TextList
                  title={t('agreements')}
                  values={doc.agreements.map(
                    (agreement) =>
                      `${agreement.text} (${agreement.supporters.map((p) => nameOf(p.participantId)).join(', ')})`,
                  )}
                />
                <TextList
                  title={t('remainingDissent')}
                  values={doc.remainingDissent.map(
                    (claim) => `${nameOf(claim.participantId)}: ${claim.text}`,
                  )}
                />
                <TextList title={t('unverifiedFacts')} values={doc.unverifiedFacts} />
                {nonresponses.length ? (
                  <div>
                    <h4 style={semibold}>{t('nonresponse')}</h4>
                    <ul className="list-inside list-disc">
                      {nonresponses.map((answer) => (
                        <li
                          key={`${answer.roundId}:${answer.participantId}`}
                          className="wrap-anywhere"
                        >
                          {nameOf(answer.participantId)} · {t(`answer.${answer.status}`)}
                          {answer.detail ? <MeetingDiagnostics text={answer.detail} /> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {doc.candidates.map((candidate) => (
                  <div
                    key={candidate.candidateId}
                    className="flex flex-col gap-2 border-t border-border pt-3"
                  >
                    {/* The goal is the candidate's name; it is printed once, here. */}
                    <h4 className="text-subtitle" style={semibold}>
                      <span className="block text-caption text-muted-foreground" style={normal}>
                        {t('candidate')}
                      </span>
                      {candidate.content.goal}
                    </h4>
                    <DecisionContent content={candidate.content} />
                    <div>
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={busy}
                        onClick={(event) =>
                          openDraft(
                            {
                              minutesId: minutes.minutesId,
                              candidateId: candidate.candidateId,
                              content: candidate.content,
                            },
                            event.currentTarget,
                          )
                        }
                      >
                        {t('editCandidate')}
                      </Button>
                    </div>
                  </div>
                ))}
              </>
            ) : null}
          </article>
        );
      })}
      {draft ? (
        <form
          ref={form}
          className="flex flex-col gap-3 rounded-lg fill-group p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run('adopt');
          }}
        >
          <h3 className="text-subtitle" style={semibold}>
            {t(draft.supersedesVersionId ? 'revise' : 'adopt')}
          </h3>
          <p className="text-caption text-muted-foreground">{t('editHint')}</p>
          <fieldset disabled={busy} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              {t('goal')}
              <Textarea
                name="goal"
                required
                maxLength={4000}
                rows={2}
                value={draft.content.goal}
                onChange={(event) =>
                  setDraft({ ...draft, content: { ...draft.content, goal: event.target.value } })
                }
              />
            </label>
            {fields.map((field) => (
              <label key={field} className="flex flex-col gap-1">
                {t(field)}
                <Textarea
                  name={field}
                  rows={2}
                  value={draft.content[field].join('\n')}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      content: { ...draft.content, [field]: event.target.value.split('\n') },
                    })
                  }
                />
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !draft.content.goal.trim()}>
              {t('adopt')}
            </Button>
            <Button type="button" variant="tertiary" disabled={busy} onClick={closeDraft}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {view.decisions?.map((decision, index) => {
        const withdrawn = view.decisionWithdrawals?.find((w) => w.versionId === decision.versionId);
        const superseded = view.decisions?.find(
          (d) => d.supersedesVersionId === decision.versionId,
        );
        const active = activeMeetingDecision(view, decision.versionId);
        return (
          <article
            key={decision.versionId}
            className="flex min-w-0 flex-col gap-3 rounded-lg fill-group p-3"
            aria-label={t('decision')}
          >
            <h3 className="text-subtitle" style={semibold}>
              {t('decisionLabel', { number: index + 1, goal: decision.content.goal })}
            </h3>
            <p className="text-caption text-muted-foreground">
              {t(withdrawn ? 'withdrawn' : superseded ? 'superseded' : 'adopted')}
              {withdrawn ? `: ${withdrawn.reason}` : ''}
              {superseded
                ? ` · ${t('supersededBy', { number: (view.decisions?.indexOf(superseded) ?? 0) + 1 })}`
                : ''}
            </p>
            <MeetingDiagnostics
              text={[decision.versionId, ...(superseded ? [superseded.versionId] : [])].join('\n')}
            />
            <DecisionContent content={decision.content} />
            {active ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="compact"
                    variant="tertiary"
                    disabled={busy}
                    onClick={(event) =>
                      openDraft(
                        {
                          minutesId: decision.minutesId,
                          candidateId: decision.candidateId,
                          content: decision.content,
                          supersedesVersionId: decision.versionId,
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    {t('revise')}
                  </Button>
                  <Button
                    size="compact"
                    variant="ghost-destructive"
                    disabled={busy}
                    onClick={() => {
                      setWithdrawal({ versionId: decision.versionId, reason: '' });
                      setDraft(null);
                    }}
                  >
                    {t('withdraw')}
                  </Button>
                </div>
                {withdrawal?.versionId === decision.versionId ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run('withdraw');
                    }}
                  >
                    <label className="flex flex-col gap-1">
                      {t('withdrawReason')}
                      <Textarea
                        required
                        maxLength={2000}
                        rows={2}
                        disabled={busy}
                        value={withdrawal.reason}
                        onChange={(event) =>
                          setWithdrawal({ ...withdrawal, reason: event.target.value })
                        }
                      />
                    </label>
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        type="submit"
                        disabled={busy || !withdrawal.reason.trim()}
                      >
                        {t('confirmWithdraw')}
                      </Button>
                      <Button
                        variant="tertiary"
                        type="button"
                        disabled={busy}
                        onClick={() => setWithdrawal(null)}
                      >
                        {t('cancel')}
                      </Button>
                    </div>
                  </form>
                ) : null}
                <MeetingHandoff session={session} decision={decision} onChange={onChange} />
              </>
            ) : null}
          </article>
        );
      })}
      {error ? (
        <p role="alert" className="text-danger wrap-anywhere">
          {error}
        </p>
      ) : null}
    </section>
  );
}
function TextList({ title, values }: { title: string; values: string[] }) {
  const t = useTranslations('MeetingsDecisions');
  return (
    <div>
      <h4 style={semibold}>{title}</h4>
      {values.length ? (
        <ul className="list-inside list-disc">
          {values.map((value, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: A saved immutable list may contain repeated text.
            <li key={`${index}:${value}`} className="wrap-anywhere">
              {value}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t('noneRecorded')}</p>
      )}
    </div>
  );
}
function DecisionContent({ content }: { content: MeetingDecisionContent }) {
  const t = useTranslations('MeetingsDecisions');
  return (
    // The goal heads the candidate or decision that holds this content.
    <div className="flex flex-col gap-2">
      {fields.map((field) => (
        <TextList key={field} title={t(field)} values={content[field]} />
      ))}
    </div>
  );
}
