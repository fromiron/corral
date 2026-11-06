import { type ComparedRun, RunComparison } from '@corral/react';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useModelPrices } from '../prices.ts';
import { currentProject } from '../projects.ts';
import { compareRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { runIdentity, runIdentityText } from '../workbench/runIdentity.ts';

/** `/compare?a=&b=`: two runs side by side. Reads only; nothing is started. */
export function ComparePage() {
  const t = useTranslations('Compare');
  const identityText = useTranslations('RunIdentity');
  const { a, b } = compareRoute.useSearch();
  const { transport, repository } = useServices();
  const prices = useModelPrices();
  const [runs, setRuns] = useState<[ComparedRun, ComparedRun] | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const incomplete = !a?.trim() || !b?.trim();
  const projectId = currentProject();

  useEffect(() => {
    if (incomplete) {
      setRuns(null);
      setMissing(null);
      return;
    }
    let active = true;
    const summaries = transport.listRuns().catch(() => []);
    const load = async (runId: string): Promise<ComparedRun> => {
      const { projection } = await transport.getSnapshot(runId).catch(() => {
        throw new Error(runId);
      });
      const outputId = projection.output?.artifactVersionIds[0];
      const [output, definition, all] = await Promise.all([
        outputId ? transport.getArtifactText(runId, outputId) : Promise.resolve(null),
        transport.getRunDefinition(runId).catch(() => null),
        summaries,
      ]);
      const summary = all.find((item) => item.runId === runId) ?? {
        runId,
        status: projection.status,
        corralId: projection.corralId ?? '',
        startedAt: projection.startedAt ?? '',
        sessionId: null,
        projectId: null,
      };
      const session = summary.sessionId
        ? await repository.getSession(summary.sessionId).catch(() => null)
        : null;
      const identity = runIdentity(summary, all, session ? [session] : [], definition);
      return {
        projection,
        output,
        name: runIdentityText(identity, identityText('unnamed'), (number) =>
          identityText('number', { number }),
        ),
      };
    };
    setRuns(null);
    setMissing(null);
    Promise.all([load(a ?? ''), load(b ?? '')])
      .then((loaded) => {
        if (active) setRuns(loaded);
      })
      .catch((error: unknown) => {
        if (active) setMissing(error instanceof Error ? error.message : String(a));
      });
    return () => {
      active = false;
    };
  }, [a, b, incomplete, transport, repository, identityText]);

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('heading')}</h2>
        <Link to="/projects/$projectId" params={{ projectId }} className="text-xs underline">
          {t('back')}
        </Link>
      </div>
      {incomplete ? (
        <div className="flex flex-col items-start gap-3 text-sm">
          <p>{t('chooseRunsHint')}</p>
          <Link to="/projects/$projectId" params={{ projectId }} hash="runs" className="underline">
            {t('chooseRuns')}
          </Link>
        </div>
      ) : missing !== null ? (
        <p role="alert" className="text-sm text-danger">
          {t('notFound', { runId: missing })}
        </p>
      ) : runs ? (
        <RunComparison a={runs[0]} b={runs[1]} prices={prices} />
      ) : null}
    </main>
  );
}
