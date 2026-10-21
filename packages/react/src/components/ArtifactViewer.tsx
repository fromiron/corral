import { type BinaryArtifact, ImageInput } from '@corral/contracts';
import { artifactLineage, type RunProjection } from '@corral/core';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { diffLines } from '../artifacts/diff.ts';
import type { RunSessionStore } from '../run/session.ts';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/**
 * One immutable version, rendered safely, with where it came from (C-024, C-025, C-030):
 * the version it revises, the versions its model call was given, and a line diff against
 * the earlier version. A review renders as its recorded verdict and issues.
 */
export function ArtifactViewer({
  session,
  versionId,
  onClose,
  onOpen,
  onStartFrom,
}: {
  session: RunSessionStore;
  versionId: string;
  onClose: () => void;
  /** Opens another version; without it, lineage links open in this viewer. */
  onOpen?: (artifactVersionId: string) => void;
  /** Offers "New run from this version" (CR-007). */
  onStartFrom?: (from: { runId: string; artifactVersionId: string; label: string }) => void;
}) {
  const t = useTranslations('Artifact');
  const headingId = useId();
  const [loadedId, setLoadedId] = useState<string | null>(null);
  // Without onOpen, a lineage link replaces what is shown until the caller picks another version.
  const [followed, setFollowed] = useState<{ from: string; id: string } | null>(null);
  const shownId = followed?.from === versionId ? followed.id : versionId;
  const open = onOpen ?? ((id: string) => setFollowed({ from: versionId, id }));

  const projection = useStore(session, (s) => s.projection);
  const artifact = useStore(session, (s) => s.projection?.artifacts[shownId]);
  const text = useStore(session, (s) => s.artifactTexts[shownId]);
  const parentId = artifact?.parentVersionId ?? null;
  const parentText = useStore(session, (s) => (parentId ? s.artifactTexts[parentId] : undefined));
  const review = useStore(session, (s) => s.projection?.reviews[shownId]);
  const lineage = projection ? artifactLineage(projection, shownId) : null;
  const inputs = lineage?.inputArtifactVersionIds;
  // The revised version is listed once, as the parent.
  const madeFrom = inputs?.filter((id) => id !== parentId);
  const definition = useStore(session, (s) => s.definition);
  const author = useStore(session, (s) =>
    artifact ? s.projection?.executions[artifact.authorExecutionId] : undefined,
  );
  const [comparingId, setComparingId] = useState<string | null>(null);
  const comparing = comparingId === shownId;

  const knownReference = Boolean(
    projection &&
      (definition?.input.images?.some((image) => image.imageId === shownId) ||
        projection.currentCriteriaVersionId === shownId ||
        Object.values(projection.artifacts).some((value) => value.criteriaVersionId === shownId) ||
        Object.values(projection.executions).some((value) => value.criteriaVersionId === shownId) ||
        Object.values(projection.reviews).some(
          (value) => value.criteriaVersionId === shownId || value.newCriteriaVersionId === shownId,
        ) ||
        Object.values(projection.iterations).some((value) => value.criteriaVersionId === shownId) ||
        Object.values(projection.approvals).some((value) => value.criteriaVersionId === shownId) ||
        Object.values(projection.patches).some(
          (value) =>
            value.kind === 'criteria' &&
            (value.before.criteriaVersionId === shownId ||
              value.after.criteriaVersionId === shownId),
        ) ||
        Object.values(projection.modelCalls).some((value) => value.responseRef === shownId) ||
        Object.values(projection.toolCalls).some((value) => value.resultRef === shownId)),
  );
  const canLoad = Boolean(artifact) || knownReference;
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
  useEffect(() => {
    if (comparing && parentId) void session.getState().loadArtifact(parentId);
  }, [session, comparing, parentId]);

  const diff = useMemo(
    () =>
      comparing && text !== undefined && parentText !== undefined
        ? diffLines(parentText, text)
        : null,
    [comparing, text, parentText],
  );

  let image: ReturnType<typeof ImageInput.safeParse> | null = null;
  if (!artifact && knownReference && text !== undefined) {
    try {
      image = ImageInput.safeParse(JSON.parse(text));
    } catch {
      /* Ordinary text reference. */
    }
  }
  if (!artifact)
    return (
      <section
        aria-labelledby={headingId}
        data-testid="artifact-viewer"
        className="flex flex-col gap-2 rounded-md fill-group p-2 text-xs"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 id={headingId} className="font-semibold">
            {t('reference')} · {shownId}
          </h3>
          <button type="button" onClick={onClose} className="rounded fill-control px-1.5 py-0.5">
            {t('close')}
          </button>
        </div>
        {knownReference && text !== undefined ? (
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
          <p role="status" className="text-muted">
            {canLoad && loadedId !== shownId ? t('loading') : t('unavailable')}
          </p>
        )}
      </section>
    );
  const label = definition?.nodes.find((n) => n.id === author?.nodeId)?.label ?? author?.nodeId;
  const link = (id: string) => (
    <button
      key={id}
      type="button"
      onClick={() => open(id)}
      className="rounded fill-control px-1 font-mono"
    >
      {id}
    </button>
  );
  return (
    <section
      aria-labelledby={headingId}
      data-testid="artifact-viewer"
      className="flex flex-col gap-2 rounded-md fill-group p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-xs font-semibold">
          {artifact.name} · {t('version', { version: artifact.version })}
        </h3>
        {onStartFrom && projection ? (
          <button
            type="button"
            onClick={() =>
              onStartFrom({
                runId: projection.runId,
                artifactVersionId: artifact.artifactVersionId,
                label: `${artifact.name} v${artifact.version}`,
              })
            }
            className="ml-auto rounded fill-control px-1.5 py-0.5 text-xs"
          >
            {t('newRunFromVersion')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded fill-control px-1.5 py-0.5 text-xs"
        >
          {t('close')}
        </button>
      </div>
      <p className="text-xs text-muted">
        {t('meta', {
          author: label ?? '—',
          contract: artifact.contract,
          bytes: artifact.byteLength,
          submitted: String(artifact.submitted),
        })}
      </p>
      {parentId || (madeFrom && madeFrom.length > 0) ? (
        <dl className="flex flex-col gap-1 text-xs">
          {parentId ? (
            <div className="flex flex-wrap items-center gap-1">
              <dt className="text-muted">{t('revises')}</dt>
              <dd>{link(parentId)}</dd>
            </div>
          ) : null}
          {madeFrom && madeFrom.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <dt className="text-muted">{t('madeFrom')}</dt>
              <dd className="flex flex-wrap gap-1">{madeFrom.map(link)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {lineage ? (
        <div
          className="flex flex-col gap-1 rounded fill-group p-2 text-xs"
          data-testid="artifact-lineage"
        >
          <h4 className="font-semibold">{t('lineage')}</h4>
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
          <p className="text-muted">{t('lineageNote')}</p>
        </div>
      ) : null}
      {review ? (
        <ReviewSummary review={review} target={link(review.targetVersionId)} artifactLink={link} />
      ) : null}
      {parentId && !binary ? (
        <button
          type="button"
          onClick={() => setComparingId(comparing ? null : shownId)}
          className="self-start rounded fill-control px-1.5 py-0.5 text-xs"
        >
          {comparing ? t('hideCompare') : t('compare', { version: parentId })}
        </button>
      ) : null}
      {binary && projection ? (
        <GeneratedImage
          key={shownId}
          runId={projection.runId}
          versionId={shownId}
          name={artifact.name}
          media={binary}
        />
      ) : comparing ? (
        diff === null ? (
          <p className="text-xs text-muted">{t('loading')}</p>
        ) : (
          <pre className="overflow-x-auto rounded fill-group text-xs" data-testid="artifact-diff">
            {diff.map((line, i) => (
              <div
                // Lines repeat; their position is their identity in this diff.
                // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
                key={i}
                data-diff={line.kind}
                className={
                  line.kind === 'added'
                    ? 'bg-success/15'
                    : line.kind === 'removed'
                      ? 'bg-danger/15 line-through'
                      : undefined
                }
              >
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                {line.text}
              </div>
            ))}
          </pre>
        )
      ) : text === undefined ? (
        <p className="text-xs text-muted">{t('loading')}</p>
      ) : review ? null : (
        <SafeMarkdown text={text} />
      )}
    </section>
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
    <figure className="flex min-w-0 flex-col gap-2" data-testid="generated-image">
      {failed ? (
        <p role="alert" className="text-sm text-danger">
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
        <p role="status" className="text-xs text-muted">
          {t('loading')}
        </p>
      ) : null}
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>
          {media.width} × {media.height} · {media.mime} · {media.bytes.toLocaleString()} B
        </span>
        <a
          href={`${url}?download=1`}
          download={`${versionId}.png`}
          className="rounded fill-control px-2 py-1"
        >
          {t('downloadImage')}
        </a>
      </figcaption>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">{t('imageIntegrity')}</summary>
        <p className="break-all font-mono">SHA-256: {media.sha256}</p>
      </details>
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
    <div className="flex flex-col gap-1 text-xs" data-testid="review-verdict">
      <p>
        <span className="font-semibold">{t(`verdict.${review.verdict}`)}</span>
        <span className="text-muted"> · {t('reviewOf')} </span>
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
        <div className="space-y-1 border-l border-line pl-2 text-muted">
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
          <p className="text-muted">{t('issues')}</p>
          <ul className="list-disc pl-5">
            {review.issues.map((issue) => (
              <li key={`${issue.criterionId}:${issue.reason}`}>
                <span className="text-muted">[{issue.severity}]</span> {issue.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {review.verdict === 'inconclusive' && review.issues.length === 0 ? (
        <p className="text-muted">{t('notAReview')}</p>
      ) : null}
    </div>
  );
}
