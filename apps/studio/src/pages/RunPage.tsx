import {
  ArtifactViewer,
  QuestionsPanel,
  ReinsPanel,
  RunView,
  TaskBoard,
  Timeline,
  useSteerTarget,
} from '@corral/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { runRoute } from '../router.tsx';
import { useServices } from '../services.tsx';

/** /runs/$runId?execution=… — the run view with Reins, without the editor. */
export function RunPage() {
  const t = useTranslations('RunPage');
  const { runId } = runRoute.useParams();
  const { execution, artifact } = runRoute.useSearch();
  const navigate = useNavigate({ from: '/runs/$runId' });
  const { session } = useServices();
  const activeRunId = useStore(session, (s) => s.runId);
  const missing = useStore(session, (s) => s.missingRunId === runId);
  const corralId = useStore(session, (s) => s.definition?.id ?? null);
  const target = useSteerTarget(session, execution ?? null);
  const openArtifact = (id: string) => void navigate({ search: (s) => ({ ...s, artifact: id }) });

  // A direct link or a reload: follow the run from the runtime's record.
  useEffect(() => {
    void session.getState().open(runId);
  }, [session, runId]);

  if (activeRunId !== runId) {
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <h2 className="text-lg font-semibold">{t('heading', { runId })}</h2>
        <p role="status" className="text-sm text-muted">
          {missing ? t('missing') : t('loading')}
        </p>
        <Link to="/" className="text-sm underline">
          ←
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-6 md:grid-cols-[1fr_22rem]">
      <section aria-labelledby="run-page-heading" className="flex flex-col gap-3">
        <h2 id="run-page-heading" className="text-lg font-semibold">
          {t('heading', { runId })}
        </h2>
        {corralId ? (
          <Link to="/corrals/$corralId/edit" params={{ corralId }} className="text-xs underline">
            {t('openCorral')}
          </Link>
        ) : null}
        <RunView
          session={session}
          onSteer={(id) => void navigate({ search: (s) => ({ ...s, execution: id }) })}
        />
        <TaskBoard session={session} onOpenArtifact={openArtifact} />
        <QuestionsPanel session={session} onOpenArtifact={openArtifact} />
        <Timeline session={session} />
      </section>
      <div className="flex flex-col gap-4">
        {artifact ? (
          <ArtifactViewer
            session={session}
            versionId={artifact}
            onClose={() => void navigate({ search: (s) => ({ ...s, artifact: undefined }) })}
          />
        ) : null}
        <ReinsPanel session={session} target={target} />
      </div>
    </main>
  );
}
