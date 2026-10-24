import type { MeetingDecisionContent, MeetingView } from '@corral/contracts';
import { activeMeetingDecision, type WorkSession } from '@corral/core';
import { Button, Textarea } from '@corral/react/design-kit';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';
import { MeetingHandoff } from './MeetingHandoff.tsx';

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
  const { meetings } = useServices();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [withdrawal, setWithdrawal] = useState<{ versionId: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const command = useRef<{ key: string; id: string } | null>(null);
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
    if (command.current?.key !== key) command.current = { key, id: newCommandId() };
    setBusy(true);
    setError('');
    try {
      const result =
        kind === 'adopt' && cleanedDraft
          ? await meetings.adopt(session.sessionId, {
              ...cleanedDraft,
              commandId: command.current.id,
            })
          : withdrawal
            ? await meetings.withdraw(session.sessionId, {
                ...withdrawal,
                commandId: command.current.id,
              })
            : null;
      if (!result) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      command.current = null;
      setDraft(null);
      setWithdrawal(null);
      await onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex min-w-0 flex-col gap-4 text-sm" aria-label={t('heading')}>
      <h2 className="font-medium">{t('heading')}</h2>
      <p className="text-muted-foreground">{t('candidateHint')}</p>
      {!view.minutes?.length ? <p className="text-muted-foreground">{t('empty')}</p> : null}
      {view.minutes?.map((minutes) => {
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
            className="flex min-w-0 flex-col gap-3 rounded fill-group p-3"
            aria-label={t('minutes')}
          >
            <h3 className="font-medium">
              {t('minutes')} · {minutes.createdAt}
            </h3>
            {minutes.error ? (
              <p role="alert" className="text-danger wrap-anywhere">
                {t('invalidMinutes')}: {minutes.error}
              </p>
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
                    <h4 className="font-medium">{t('nonresponse')}</h4>
                    <ul className="list-inside list-disc">
                      {nonresponses.map((answer) => (
                        <li
                          key={`${answer.roundId}:${answer.participantId}`}
                          className="wrap-anywhere"
                        >
                          {nameOf(answer.participantId)} · {t(`answer.${answer.status}`)}
                          {answer.detail ? `: ${answer.detail}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {doc.candidates.map((candidate) => (
                  <div key={candidate.candidateId} className="flex flex-col gap-2">
                    <h4 className="font-medium">
                      {t('candidate')}: {candidate.content.goal}
                    </h4>
                    <DecisionContent content={candidate.content} />
                    <div>
                      <Button
                        size="compact"
                        variant="tertiary"
                        disabled={busy}
                        onClick={() => {
                          setDraft({
                            minutesId: minutes.minutesId,
                            candidateId: candidate.candidateId,
                            content: candidate.content,
                          });
                          setWithdrawal(null);
                        }}
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
          className="flex flex-col gap-3 rounded fill-group p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run('adopt');
          }}
        >
          <h3 className="font-medium">{t(draft.supersedesVersionId ? 'revise' : 'adopt')}</h3>
          <p className="text-muted-foreground">{t('editHint')}</p>
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
            <Button type="button" variant="tertiary" disabled={busy} onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {view.decisions?.map((decision) => {
        const withdrawn = view.decisionWithdrawals?.find((w) => w.versionId === decision.versionId);
        const superseded = view.decisions?.find(
          (d) => d.supersedesVersionId === decision.versionId,
        );
        const active = activeMeetingDecision(view, decision.versionId);
        return (
          <article
            key={decision.versionId}
            className="flex min-w-0 flex-col gap-3 rounded fill-group p-3"
            aria-label={t('decision')}
          >
            <h3 className="font-medium">
              {t('decision')} · {decision.versionId}
            </h3>
            <p>
              {t(withdrawn ? 'withdrawn' : superseded ? 'superseded' : 'adopted')}
              {withdrawn ? `: ${withdrawn.reason}` : ''}
              {superseded ? ` · ${superseded.versionId}` : ''}
            </p>
            <DecisionContent content={decision.content} />
            {active ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="compact"
                    variant="tertiary"
                    disabled={busy}
                    onClick={() => {
                      setDraft({
                        minutesId: decision.minutesId,
                        candidateId: decision.candidateId,
                        content: decision.content,
                        supersedesVersionId: decision.versionId,
                      });
                      setWithdrawal(null);
                    }}
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
      <h4 className="font-medium">{title}</h4>
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
    <div className="flex flex-col gap-2">
      <p className="wrap-anywhere">{content.goal}</p>
      {fields.map((field) => (
        <TextList key={field} title={t(field)} values={content[field]} />
      ))}
    </div>
  );
}
