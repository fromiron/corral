import type { RunEvent } from '@corral/contracts';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, fontWeights } from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { FirstRow } from './FirstRow.tsx';

/** Whether the panel shows: a review recipe stopped, or judged a round. */
export const recipeStatusShown = (events: readonly RunEvent[]) =>
  events.some((event) => event.type === 'recipe.stopped' || event.type === 'recipe.evaluated');

export function RecipeStatusPanel({
  session,
  onOpenArtifact,
  action,
}: {
  session: RunSessionStore;
  onOpenArtifact(id: string): void;
  /** A control of the host's frame, at the end of the heading row (see ApprovalPanel). */
  action?: ReactNode;
}) {
  const t = useTranslations('Recipe');
  const events = useStore(session, (state) => state.events),
    iterations = useStore(session, (state) => state.projection?.iterations);
  const stopped = events.findLast((event) => event.type === 'recipe.stopped');
  const evaluations = events.filter((event) => event.type === 'recipe.evaluated');
  if (!recipeStatusShown(events)) return null;
  return (
    <section
      data-testid="recipe-status"
      aria-label={t('heading')}
      className="flex flex-col gap-2 rounded fill-group p-3 text-caption"
    >
      <FirstRow action={action}>
        <h3 style={{ fontVariationSettings: fontWeights.semibold }}>{t('heading')}</h3>
      </FirstRow>
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
            <p className="text-muted-foreground">
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
