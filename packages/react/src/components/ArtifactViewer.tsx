import { type BinaryArtifact, ImageInput } from '@corral/contracts';
import { artifactLineage, canReadArtifactBody, type RunProjection } from '@corral/core';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  KitAccordion as Accordion,
  KitAccordionContent as AccordionContent,
  KitAccordionItem as AccordionItem,
  KitAccordionTrigger as AccordionTrigger,
  KitButton as Button,
  KitCard as Card,
  KitCardAction as CardAction,
  KitCardContent as CardContent,
  KitCardDescription as CardDescription,
  KitCardHeader as CardHeader,
  KitCardTitle as CardTitle,
} from '../design-kit/index.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore } from '../run/session.ts';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/**
 * A currently available artifact or operational reference, rendered safely. Creation and
 * input relationships remain metadata even when a previous body has been released.
 */
export function ArtifactViewer({
  session,
  versionId,
  onClose,
  onOpen,
}: {
  session: RunSessionStore;
  versionId: string;
  onClose: () => void;
  /** Opens another currently available reference; retired bodies never become links. */
  onOpen?: (artifactVersionId: string) => void;
  /** Compatibility callback; historical artifact reuse is no longer offered. */
  onStartFrom?: (from: { runId: string; artifactVersionId: string; label: string }) => void;
}) {
  const t = useTranslations('Artifact');
  const headingId = useId();
  const [loadedId, setLoadedId] = useState<string | null>(null);
  // Current reference inspection can stay in this viewer when the host has no dock handler.
  const [followed, setFollowed] = useState<{ from: string; id: string } | null>(null);
  const shownId = followed?.from === versionId ? followed.id : versionId;
  const open = onOpen ?? ((id: string) => setFollowed({ from: versionId, id }));

  const projection = useRunDisplay(session, (s) => s.projection);
  const currentProjection = useStore(session, (s) => s.projection);
  const artifact = useRunDisplay(session, (s) => s.projection?.artifacts[shownId]);
  const text = useStore(session, (s) => s.artifactTexts[shownId]);
  const review = useRunDisplay(session, (s) => s.projection?.reviews[shownId]);
  const lineage = projection ? artifactLineage(projection, shownId) : null;
  const madeFrom = lineage?.inputArtifactVersionIds;
  const definition = useStore(session, (s) => s.definition);
  const author = useRunDisplay(session, (s) =>
    artifact ? s.projection?.executions[artifact.authorExecutionId] : undefined,
  );

  const knownReference = Boolean(
    projection &&
      (definition?.input.images?.some((image) => image.imageId === shownId) ||
        projection.currentCriteriaVersionId === shownId ||
        projection.forkedFrom?.carried.some((step) => step.artifactVersionIds.includes(shownId)) ||
        Object.values(projection.artifacts).some((value) => value.criteriaVersionId === shownId) ||
        Object.values(projection.executions).some((value) => value.criteriaVersionId === shownId) ||
        Object.values(projection.reviews).some(
          (value) => value.criteriaVersionId === shownId || value.newCriteriaVersionId === shownId,
        ) ||
        Object.values(projection.iterations).some((value) => value.criteriaVersionId === shownId) ||
        Object.values(projection.approvals).some(
          (value) => value.criteriaVersionId === shownId || value.tool?.bodyRef === shownId,
        ) ||
        Object.values(projection.patches).some(
          (value) =>
            value.kind === 'criteria' &&
            (value.before.criteriaVersionId === shownId ||
              value.after.criteriaVersionId === shownId),
        ) ||
        Object.values(projection.modelCalls).some((value) => value.responseRef === shownId) ||
        Object.values(projection.toolCalls).some((value) => value.resultRef === shownId)),
  );
  const canLoad =
    Boolean(artifact || knownReference) && canReadArtifactBody(currentProjection, shownId);
  const binary = artifact?.media;
  useEffect(() => {
    if (!canLoad || binary) return;
    let active = true;
    void session
      .getState()
      .loadArtifact(shownId)
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoadedId(shownId);
      });
    return () => {
      active = false;
    };
  }, [session, shownId, canLoad, binary]);

  let image: ReturnType<typeof ImageInput.safeParse> | null = null;
  if (!artifact && knownReference && canLoad && text !== undefined) {
    try {
      image = ImageInput.safeParse(JSON.parse(text));
    } catch {
      /* Ordinary text reference. */
    }
  }
  if (!artifact)
    return (
      <Card role="region" aria-labelledby={headingId} data-testid="artifact-viewer">
        <CardHeader>
          <h3 id={headingId}>
            <CardTitle>
              {t('reference')} · {shownId}
            </CardTitle>
          </h3>
          <CardAction>
            <Button variant="ghost" onClick={onClose}>
              {t('close')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {knownReference && canLoad && text !== undefined ? (
            image?.success ? (
              <img
                className="max-h-96 max-w-full object-contain"
                alt={image.data.name}
                src={`data:${image.data.mime};base64,${image.data.data}`}
              />
            ) : (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">{text}</pre>
            )
          ) : (
            <p role="status" className="text-muted-foreground">
              {canLoad && loadedId !== shownId ? t('loading') : t('unavailable')}
            </p>
          )}
        </CardContent>
      </Card>
    );
  const label = definition?.nodes.find((n) => n.id === author?.nodeId)?.label ?? author?.nodeId;
  const link = (id: string) =>
    canReadArtifactBody(currentProjection, id) ? (
      <Button key={id} variant="ghost" onClick={() => open(id)} className="font-mono">
        {id}
      </Button>
    ) : (
      <span key={id} className="font-mono">
        {id}
      </span>
    );
  return (
    <Card role="region" aria-labelledby={headingId} data-testid="artifact-viewer">
      <CardHeader>
        <h3 id={headingId}>
          <CardTitle>
            {artifact.name} · {t('version', { version: artifact.version })}
          </CardTitle>
        </h3>
        <CardAction className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        </CardAction>
        <CardDescription>
          {t('meta', {
            author: label ?? '—',
            contract: artifact.contract,
            bytes: artifact.byteLength,
            submitted: String(artifact.submitted),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {madeFrom && madeFrom.length > 0 ? (
          <dl className="flex flex-col gap-2 text-caption">
            <div className="flex flex-wrap items-center gap-1">
              <dt className="text-muted-foreground">{t('madeFrom')}</dt>
              <dd className="flex flex-wrap gap-1">{madeFrom.map(link)}</dd>
            </div>
          </dl>
        ) : null}
        {lineage ? (
          <div className="flex flex-col gap-2 text-caption" data-testid="artifact-lineage">
            <h4 className="text-subtitle">{t('lineage')}</h4>
            <p>
              {t('request', {
                request: artifact.modelCallId ?? '—',
                snapshot: artifact.contextSnapshotId ?? '—',
              })}
            </p>
            <p>{t('configRevision', { revision: lineage.configRevision })}</p>
            {lineage.criteriaVersionId ? (
              <p>
                {t('criteria')} {link(lineage.criteriaVersionId)}
              </p>
            ) : null}
            <dl className="flex flex-col gap-1">
              <dt className="font-medium">{t('direct')}</dt>
              <dd>
                {lineage.directDirectiveIds.length === 0 ? (
                  t('noDirectives')
                ) : (
                  <ul>
                    {lineage.directDirectiveIds.map((id) => (
                      <li key={id}>
                        <span className="font-mono">{id}</span> · {projection?.directives[id]?.text}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt className="font-medium">{t('indirect')}</dt>
              <dd>
                {lineage.indirectDirectiveIds.length === 0 ? (
                  t('noDirectives')
                ) : (
                  <ul>
                    {lineage.indirectDirectiveIds.map((id) => (
                      <li key={id}>
                        <span className="font-mono">{id}</span> · {projection?.directives[id]?.text}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
            <p className="text-muted-foreground">{t('lineageNote')}</p>
          </div>
        ) : null}
        {review ? (
          <ReviewSummary
            review={review}
            target={link(review.targetVersionId)}
            artifactLink={link}
          />
        ) : null}
        {!canLoad ? (
          <p role="status" className="text-body text-muted-foreground">
            {t(
              currentProjection?.artifacts[shownId]?.bodyAvailable === false
                ? 'retired'
                : 'unavailable',
            )}
          </p>
        ) : binary && projection ? (
          <GeneratedImage
            key={shownId}
            runId={projection.runId}
            versionId={shownId}
            name={artifact.name}
            media={binary}
          />
        ) : text === undefined ? (
          <p className="text-caption text-muted-foreground">{t('loading')}</p>
        ) : review ? null : (
          <SafeMarkdown text={text} />
        )}
      </CardContent>
    </Card>
  );
}

export function GeneratedImage({
  runId,
  versionId,
  name,
  media,
}: {
  runId: string;
  versionId: string;
  name: string;
  media: BinaryArtifact;
}) {
  const t = useTranslations('Artifact');
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const url = `/api/v1/runs/${encodeURIComponent(runId)}/artifact-versions/${encodeURIComponent(versionId)}/media`;
  return (
    <figure className="flex min-w-0 flex-col gap-4" data-testid="generated-image">
      {failed ? (
        <p role="alert" className="text-caption text-danger">
          {t('imageUnavailable')}
        </p>
      ) : (
        <img
          src={url}
          alt={name}
          width={media.width}
          height={media.height}
          className="max-h-[70vh] max-w-full self-center object-contain"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {!failed && !loaded ? (
        <p role="status" className="text-caption text-muted-foreground">
          {t('loading')}
        </p>
      ) : null}
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-caption">
        <span>
          {media.width} × {media.height} · {media.mime} · {media.bytes.toLocaleString()} B
        </span>
        <Button
          variant="tertiary"
          render={<a href={`${url}?download=1`} download={`${versionId}.png`} />}
        >
          {t('downloadImage')}
        </Button>
      </figcaption>
      <Accordion>
        <AccordionItem value="integrity" highlight="trigger">
          <AccordionTrigger>{t('imageIntegrity')}</AccordionTrigger>
          <AccordionContent>
            <p className="break-all font-mono">SHA-256: {media.sha256}</p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </figure>
  );
}

/** The same committed verdict in artifact detail and the conversation. */
export function ReviewSummary({
  review,
  target,
  artifactLink,
}: {
  review: RunProjection['reviews'][string];
  target: ReactNode;
  artifactLink?: (id: string) => ReactNode;
}) {
  const t = useTranslations('Artifact');
  return (
    <div className="flex flex-col gap-2 text-body" data-testid="review-verdict">
      <p>
        <span className="font-semibold">{t(`verdict.${review.verdict}`)}</span>
        <span className="text-muted-foreground"> · {t('reviewOf')} </span>
        {target}
      </p>
      {review.stale ? (
        <p role="status" className="text-warning">
          {t('staleReview', {
            previous: review.criteriaVersionId,
            current: review.newCriteriaVersionId ?? '—',
          })}
        </p>
      ) : null}
      {review.design ? (
        <div className="space-y-1 border-l border-line pl-2 text-muted-foreground">
          <p>{t(review.design.scope === 'targeted' ? 'designTargeted' : 'designReleaseReport')}</p>
          <p>{t('designEvidenceNote')}</p>
          <p>
            {t('designReport')} ·{' '}
            {artifactLink?.(review.design.reportVersionId) ?? review.design.reportVersionId}
          </p>
          {review.design.tokenProposalVersionId ? (
            <p>
              {t('tokenProposal')} ·{' '}
              {artifactLink?.(review.design.tokenProposalVersionId) ??
                review.design.tokenProposalVersionId}
            </p>
          ) : null}
          {review.design.preferenceSources.map((source, index) => (
            <p
              key={
                source.origin === 'user_answer'
                  ? `${source.requestId}:${source.questionId}`
                  : `ai:${index}`
              }
            >
              {t(source.origin === 'user_answer' ? 'preferenceAnswer' : 'preferenceAi')}
              {source.origin === 'user_answer' ? ` · ${source.requestId}/${source.questionId}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      {review.issues.length > 0 ? (
        <div>
          <p className="text-muted-foreground">{t('issues')}</p>
          <ul className="list-disc pl-5">
            {review.issues.map((issue) => (
              <li key={`${issue.criterionId}:${issue.reason}`}>
                <span className="text-muted-foreground">[{issue.severity}]</span> {issue.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {review.verdict === 'inconclusive' && review.issues.length === 0 ? (
        <p className="text-muted-foreground">{t('notAReview')}</p>
      ) : null}
    </div>
  );
}
