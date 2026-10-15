import { ReinsPanel, RunView, useSteerTarget } from '@corral/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { runRoute } from '../router.tsx';
import { useServices } from '../services.tsx';

/** /runs/$runId?execution=… — the run view with Reins, without the editor. */
export function RunPage() {
  const t = useTranslations('RunPage');
  const { runId } = runRoute.useParams();
  const { execution } = runRoute.useSearch();
  const navigate = useNavigate({ from: '/runs/$runId' });
  const { session } = useServices();
  const activeRunId = useStore(session, (s) => s.runId);
  const corralId = useStore(session, (s) => s.definition?.id ?? null);
  const target = useSteerTarget(session, execution ?? null);

  if (activeRunId !== runId) {
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <h2 className="text-lg font-semibold">{t('heading', { runId })}</h2>
        <p role="status" className="text-sm text-muted">
          {t('missing')}
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
        <RunView session={session} onSteer={(id) => void navigate({ search: { execution: id } })} />
      </section>
      <ReinsPanel session={session} target={target} />
    </main>
  );
}
