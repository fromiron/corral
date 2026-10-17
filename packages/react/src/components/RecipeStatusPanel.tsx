import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { Button } from '../ui/button.tsx';

export function RecipeStatusPanel({
  session,
  onOpenArtifact,
}: {
  session: RunSessionStore;
  onOpenArtifact(id: string): void;
}) {
  const t = useTranslations('Recipe');
  const events = useStore(session, (state) => state.events),
    iterations = useStore(session, (state) => state.projection?.iterations);
  const stopped = events.findLast((event) => event.type === 'recipe.stopped');
  const evaluations = events.filter((event) => event.type === 'recipe.evaluated');
  if (!stopped && !evaluations.length) return null;
  return (
    <section
      data-testid="recipe-status"
      aria-label={t('heading')}
      className="flex flex-col gap-2 rounded border border-line p-3 text-xs"
    >
      <h3 className="font-semibold">{t('heading')}</h3>
      {stopped ? (
        <p role="status" className="text-warning">
          {t(`reasons.${stopped.payload.reason}`)}
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {evaluations.map((event) => (
          <li key={event.eventId}>
            <p>
              {t('round', {
                round: iterations?.[event.payload.iterationId]?.no ?? 0,
                verdict: t(`verdict.${event.payload.verdict}`),
              })}
            </p>
            <p className="text-muted">
              {t('evidence', {
                revision: event.payload.revision,
                checks: event.payload.checkReportIds.length,
              })}
              {event.payload.tree ? ` · ${event.payload.tree.slice(0, 12)}` : ''}
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onOpenArtifact(event.payload.candidateVersionId)}
              >
                {t('openCandidate')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onOpenArtifact(event.payload.reviewVersionId)}
              >
                {t('openReview')}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
