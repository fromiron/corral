import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { SafeMarkdown } from './SafeMarkdown.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/**
 * Questions between agents (C-025, Spec §7.2): who asked whom, the answer, and the evidence.
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
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  if (!projection) return null;
  const labelOf = (nodeId: string) =>
    definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const questions = Object.values(projection.questions);
  if (questions.length === 0) return null;

  return (
    <section aria-labelledby="questions-heading" className="flex flex-col gap-1">
      <h3 id="questions-heading" className="text-xs font-semibold">
        {t('heading')}
      </h3>
      <ul className="flex flex-col gap-2">
        {questions.map((question) => {
          const asker = projection.executions[question.senderExecutionId];
          const responderId =
            question.answer?.responderExecutionId ??
            Object.values(projection.executions).find((e) => e.taskId === question.taskId)
              ?.executionId;
          const versions = (ids: string[]) =>
            ids.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onOpenArtifact(id)}
                className="rounded border border-line px-1 font-mono text-xs"
              >
                {id}
              </button>
            ));
          return (
            <li
              key={question.questionId}
              data-testid={`question-${question.questionId}`}
              className="flex flex-col gap-1 rounded-md border border-line p-2 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`#execution-${question.senderExecutionId}`}
                  className="font-medium underline"
                >
                  {labelOf(asker?.nodeId ?? '')}
                </a>
                <span aria-hidden="true">→</span>
                {responderId ? (
                  <a href={`#execution-${responderId}`} className="font-medium underline">
                    {labelOf(question.targetNodeId)}
                  </a>
                ) : (
                  <span className="font-medium">{labelOf(question.targetNodeId)}</span>
                )}
                <StatusBadge status={question.status} />
              </div>
              <p className="whitespace-pre-wrap">{question.body}</p>
              {question.artifactRefs.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 text-muted">
                  {t('about')} {versions(question.artifactRefs)}
                </div>
              ) : null}
              {question.answer ? (
                <div className="rounded border border-line bg-surface p-2">
                  <SafeMarkdown text={question.answer.body} />
                  {question.answer.evidenceRefs.length > 0 ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-muted">
                      {t('evidence')} {versions(question.answer.evidenceRefs)}
                    </div>
                  ) : null}
                </div>
              ) : question.status === 'open' ? (
                <p className="text-muted">
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
