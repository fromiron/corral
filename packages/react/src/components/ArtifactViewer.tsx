import { useEffect, useMemo, useState } from 'react';
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
}: {
  session: RunSessionStore;
  versionId: string;
  onClose: () => void;
  /** Opens another version; without it, lineage links open in this viewer. */
  onOpen?: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Artifact');
  // Without onOpen, a lineage link replaces what is shown until the caller picks another version.
  const [followed, setFollowed] = useState<{ from: string; id: string } | null>(null);
  const shownId = followed?.from === versionId ? followed.id : versionId;
  const open = onOpen ?? ((id: string) => setFollowed({ from: versionId, id }));

  const artifact = useStore(session, (s) => s.projection?.artifacts[shownId]);
  const text = useStore(session, (s) => s.artifactTexts[shownId]);
  const parentId = artifact?.parentVersionId ?? null;
  const parentText = useStore(session, (s) => (parentId ? s.artifactTexts[parentId] : undefined));
  const review = useStore(session, (s) => s.projection?.reviews[shownId]);
  const inputs = useStore(session, (s) =>
    artifact?.modelCallId
      ? s.projection?.modelCalls[artifact.modelCallId]?.inputArtifactVersionIds
      : undefined,
  );
  // The revised version is listed once, as the parent.
  const madeFrom = inputs?.filter((id) => id !== parentId);
  const definition = useStore(session, (s) => s.definition);
  const author = useStore(session, (s) =>
    artifact ? s.projection?.executions[artifact.authorExecutionId] : undefined,
  );
  const [comparingId, setComparingId] = useState<string | null>(null);
  const comparing = comparingId === shownId;

  useEffect(() => {
    void session.getState().loadArtifact(shownId);
  }, [session, shownId]);
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

  if (!artifact) return null;
  const label = definition?.nodes.find((n) => n.id === author?.nodeId)?.label ?? author?.nodeId;
  const link = (id: string) => (
    <button
      key={id}
      type="button"
      onClick={() => open(id)}
      className="rounded border border-line px-1 font-mono"
    >
      {id}
    </button>
  );
  return (
    <section
      aria-labelledby="artifact-heading"
      data-testid="artifact-viewer"
      className="flex flex-col gap-2 rounded-md border border-line p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="artifact-heading" className="text-xs font-semibold">
          {artifact.name} · {t('version', { version: artifact.version })}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-line px-1.5 py-0.5 text-xs"
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
      {review ? (
        <div className="flex flex-col gap-1 text-xs" data-testid="review-verdict">
          <p>
            <span className="font-semibold">{t(`verdict.${review.verdict}`)}</span>
            <span className="text-muted"> · {t('reviewOf')} </span>
            {link(review.targetVersionId)}
          </p>
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
      ) : null}
      {parentId ? (
        <button
          type="button"
          onClick={() => setComparingId(comparing ? null : shownId)}
          className="self-start rounded border border-line px-1.5 py-0.5 text-xs"
        >
          {comparing ? t('hideCompare') : t('compare', { version: parentId })}
        </button>
      ) : null}
      {comparing ? (
        diff === null ? (
          <p className="text-xs text-muted">{t('loading')}</p>
        ) : (
          <pre
            className="overflow-x-auto rounded border border-line text-xs"
            data-testid="artifact-diff"
          >
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
