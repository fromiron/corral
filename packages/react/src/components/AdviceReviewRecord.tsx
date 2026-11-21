import type { RunEvent } from '@corral/contracts';
import { Fragment, type ReactNode, useId } from 'react';
import { useTranslations } from 'use-intl';
import { Button, fontWeights } from '../design-kit/index.ts';
import type { TeamRecord } from '../run/teamRecord.ts';

export function AdviceReviewRecord({
  record,
  questionsId,
  onRound,
  onOpenArtifact,
  events,
  describe,
}: {
  record: TeamRecord;
  questionsId: string | null;
  onRound: (loopId: string, iterationId: string) => void;
  onOpenArtifact?: ((versionId: string) => void) | undefined;
  events: readonly RunEvent[];
  describe: (event: RunEvent) => ReactNode;
}) {
  const t = useTranslations('TeamRecord');
  const heading = useId();
  const { questions, observation } = record;
  const questionsLine = !questions?.total
    ? t('noRequests')
    : [
        t('requests', { count: questions.total }),
        ...(['open', 'answered', 'cancelled', 'timed_out'] as const)
          .filter((state) => questions[state] > 0)
          .map((state) => t(state, { count: questions[state] })),
      ].join(' · ');
  const action = (label: string, open?: () => void) =>
    open ? (
      <Button
        variant="ghost"
        onClick={open}
        className="h-auto max-w-full justify-start whitespace-normal px-0 py-1 text-left underline"
      >
        {label}
      </Button>
    ) : (
      label
    );
  return (
    <section aria-labelledby={heading} className="min-w-0 break-words text-caption">
      <h3 id={heading} style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('title')}
      </h3>
      <ul aria-live="polite" aria-atomic="true" className="mt-1 grid gap-1">
        {questions && (
          <li>
            {questionsId && questions.total > 0 ? (
              <a href={`#${questionsId}`} className="underline">
                {questionsLine}
              </a>
            ) : (
              questionsLine
            )}
          </li>
        )}
        {observation &&
          (['delivered', 'notDelivered', 'late'] as const).map((kind) => {
            const count = observation[kind];
            if (!count && kind !== 'delivered') return null;
            const text = t(kind, { count });
            const seqs = new Set(observation[`${kind}Seqs`]);
            const evidence = seqs.size ? events.filter((event) => seqs.has(event.runSeq)) : [];
            return (
              <li key={kind}>
                {evidence.length ? (
                  <details>
                    <summary>{text}</summary>
                    <ul aria-live="off" className="grid gap-1 pl-3 text-muted-foreground">
                      {evidence.map((event) => (
                        <li key={event.eventId}>
                          #{event.runSeq} · {describe(event)}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  text
                )}
              </li>
            );
          })}
        {record.reviews.map((review) => {
          const { status, round } = review;
          const state = t(status === 'cancelled' ? 'reviewCancelled' : status, {
            no: round?.no ?? 0,
          });
          const label = [
            t('result', { name: review.binding }),
            ...(review.rounds &&
            (review.rounds !== round?.no || (status !== 'passed' && status !== 'inProgress'))
              ? [t('rounds', { count: review.rounds })]
              : []),
            state,
          ].join(' · ');
          return (
            <Fragment key={`${review.outputId}:${review.bindingId}`}>
              <li>{action(label, round ? () => onRound(review.loopId, round.id) : undefined)}</li>
              {review.submissions.map((version) => (
                <li key={version.id}>
                  {action(
                    t('submitted', version),
                    onOpenArtifact && (() => onOpenArtifact(version.id)),
                  )}
                </li>
              ))}
            </Fragment>
          );
        })}
      </ul>
    </section>
  );
}
