import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/** One immutable version, rendered safely, with where it came from (C-024, C-025). */
export function ArtifactViewer({
  session,
  versionId,
  onClose,
}: {
  session: RunSessionStore;
  versionId: string;
  onClose: () => void;
}) {
  const t = useTranslations('Artifact');
  const artifact = useStore(session, (s) => s.projection?.artifacts[versionId]);
  const text = useStore(session, (s) => s.artifactTexts[versionId]);
  const definition = useStore(session, (s) => s.definition);
  const author = useStore(session, (s) =>
    artifact ? s.projection?.executions[artifact.authorExecutionId] : undefined,
  );

  useEffect(() => {
    void session.getState().loadArtifact(versionId);
  }, [session, versionId]);

  if (!artifact) return null;
  const label = definition?.nodes.find((n) => n.id === author?.nodeId)?.label ?? author?.nodeId;
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
      {text === undefined ? (
        <p className="text-xs text-muted">{t('loading')}</p>
      ) : (
        <SafeMarkdown text={text} />
      )}
    </section>
  );
}
