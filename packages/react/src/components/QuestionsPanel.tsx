import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, fontWeights } from '../design-kit/index.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore } from '../run/session.ts';
import { ReviewVersion } from './ReviewVersion.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/**
 * Questions between agents: who asked whom, the answer, and the evidence.
 * Each question links to the responder's own execution, a new task created to answer it.
 */
export function QuestionsPanel({
  session,
  onOpenArtifact,
}: {
  session: RunSessionStore;
  onOpenArtifact: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Questions');
  const headingId = useId();
  const advice = useTranslations('Advice');
  const projection = useRunDisplay(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  if (!projection) return null;
  const labelOf = (nodeId: string) =>
    definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const questions = Object.values(projection.questions);
  if (questions.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3
        id={headingId}
        className="text-caption"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {t('heading')}
      </h3>
      <ul className="flex flex-col gap-2">
        {questions.map((question) => {
          const asker = projection.executions[question.senderExecutionId];
          const target = question.sharedOutrider
            ? advice('advisor')
            : labelOf(question.targetNodeId);
          const reviewId = question.reviewArtifactVersionId;
          const about = question.artifactRefs.filter((id) => id !== reviewId);
          const evidence = question.answer?.evidenceRefs.filter((id) => id !== reviewId) ?? [];
          const responderId =
            question.answer?.responderExecutionId ??
            Object.values(projection.executions).find((e) => e.taskId === question.taskId)
              ?.executionId;
          const versions = (ids: string[]) =>
            ids.map((id) => (
              <Button
                key={id}
                type="button"
                onClick={() => onOpenArtifact(id)}
                variant="ghost"
                className="font-mono"
              >
                {id}
              </Button>
            ));
          return (
            <li
              key={question.questionId}
              data-testid={`question-${question.questionId}`}
              className="flex flex-col gap-2 border-b border-border py-3 text-caption last:border-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`#execution-${question.senderExecutionId}`}
                  className="underline"
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {labelOf(asker?.nodeId ?? '')}
                </a>
                <span aria-hidden="true">→</span>
                {responderId ? (
                  <a
                    href={`#execution-${responderId}`}
                    className="underline"
                    style={{ fontVariationSettings: fontWeights.semibold }}
                  >
                    {target}
                  </a>
                ) : (
                  <span style={{ fontVariationSettings: fontWeights.semibold }}>{target}</span>
                )}
                <StatusBadge
                  status={question.status}
                  {...(question.sharedOutrider &&
                  (question.status === 'open' || question.status === 'answered')
                    ? { label: t(`consultation.${question.status}`) }
                    : {})}
                />
              </div>
              <p className="whitespace-pre-wrap">{question.body}</p>
              {reviewId && (
                <ReviewVersion session={session} versionId={reviewId} onOpen={onOpenArtifact} />
              )}
              {about.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
                  {t('about')} {versions(about)}
                </div>
              ) : null}
              {question.answer ? (
                <div className="border-l border-border pl-3">
                  <SafeMarkdown text={question.answer.body} />
                  {evidence.length > 0 ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                      {t('evidence')} {versions(evidence)}
                    </div>
                  ) : null}
                </div>
              ) : question.status === 'open' ? (
                <p className="text-muted-foreground">
                  {projection.status === 'paused' || projection.status === 'pausing'
                    ? t('paused')
                    : t('waiting', { deadline: question.deadline })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
