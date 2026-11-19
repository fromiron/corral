import type { CorralDefinition } from '@corral/contracts';
import { reviewedOutputBinding } from '@corral/core';
import { fontWeights } from '@corral/react/design-kit';
import { memo, useId } from 'react';
import { useTranslations } from 'use-intl';

/** Describes the compiled definition that the run controls would start now. */
export const RunSetupSummary = memo(function RunSetupSummary({
  definition,
  savedRevision,
}: {
  definition: CorralDefinition;
  /** Null when starting would use the current, unsaved edits. */
  savedRevision: number | null;
}) {
  const t = useTranslations('RunSetupSummary');
  const headingId = useId();
  const lines: string[] = [];
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const reviews: string[] = [];
  for (const output of definition.nodes) {
    if (output.type !== 'output') continue;
    for (const binding of output.inputBindings) {
      if (binding.kind !== 'task_output') continue;
      const source = binding.sourceNodeId ? nodes.get(binding.sourceNodeId) : undefined;
      const submitter =
        (source?.type === 'agent' && source.invocation === 'scheduled') ||
        (source?.type === 'team' && source.source.kind === 'reference')
          ? source.label
          : null;
      lines.push(
        submitter
          ? t('result', { result: binding.name, submitter })
          : t('missingSubmitter', { result: binding.name }),
      );
    }
    for (const gate of output.requiredReviews ?? []) {
      const loop = nodes.get(gate.loopNodeId);
      let limit: string;
      if (loop?.type !== 'loop') {
        limit = t('missingLimit');
      } else if (loop.limitPolicy?.kind === 'unlimited') {
        limit = t('noLimit');
      } else if (loop.maxIterations === undefined) {
        limit = t('missingLimit');
      } else if (loop.reviewRecipe) {
        limit = t('recipeLimit', {
          count: loop.maxIterations,
          attempts: loop.reviewRecipe.maxAttempts,
          repairs: loop.reviewRecipe.maxRepairs,
        });
      } else {
        const resets =
          loop.limitPolicy?.kind === 'raise_reasoning' || loop.limitPolicy?.kind === 'upper_model';
        limit = t(resets ? 'resetLimit' : 'roundLimit', { count: loop.maxIterations });
      }
      reviews.push(
        t(reviewedOutputBinding(output, gate) ? 'review' : 'missingReviewInput', {
          result: gate.bindingName,
          limit,
        }),
      );
    }
  }
  if (!lines.length) lines.push(t('noResult'));
  const shared = definition.sharedOutrider;
  if (shared) {
    lines.push(
      shared.targets.kind === 'all'
        ? t('wholeTeam')
        : t('selected', { count: new Set(shared.targets.nodeIds).size }),
      t(shared.artifactReview ? 'artifactReviewOn' : 'artifactReviewOff'),
      shared.observation
        ? t('observationInterval', { count: shared.observation.review.interval })
        : t('observationOff'),
    );
  }
  lines.push(...reviews);
  return (
    <section aria-labelledby={headingId} className="mb-3 grid min-w-0 gap-1 break-words">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3
          id={headingId}
          className="text-caption"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t('heading')}
        </h3>
        <span className="text-caption text-muted-foreground">
          {savedRevision === null
            ? t('unsavedChanges')
            : t('savedRevision', { revision: savedRevision })}
        </span>
      </div>
      <ul className="grid gap-1 text-body">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: these read-only sentences can be identical for distinct bindings.
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  );
});
