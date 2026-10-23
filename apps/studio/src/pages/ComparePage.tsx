import { type ComparedRun, RunComparison } from '@corral/react';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useModelPrices } from '../prices.ts';
import { compareRoute } from '../router.tsx';
import { useServices } from '../services.tsx';

/** `/compare?a=&b=`: two runs side by side (roadmap 16). Reads only; nothing is started. */
export function ComparePage() {
  const t = useTranslations('Compare');
  const { a, b } = compareRoute.useSearch();
  const { transport, repository } = useServices();
  const prices = useModelPrices();
  const [runs, setRuns] = useState<[ComparedRun, ComparedRun] | null>(null);
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async (runId: string): Promise<ComparedRun> => {
      const { projection } = await transport.getSnapshot(runId).catch(() => {
        throw new Error(runId);
      });
      const outputId = projection.output?.artifactVersionIds[0];
      const [output, record] = await Promise.all([
        outputId ? transport.getArtifactText(runId, outputId) : Promise.resolve(null),
        projection.corralId
          ? repository.get(projection.corralId).catch(() => null)
          : Promise.resolve(null),
      ]);
      return { projection, output, name: record?.definition.name ?? null };
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
  }, [a, b, transport, repository]);

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('heading')}</h2>
        <Link to="/" className="text-xs underline">
          {t('back')}
        </Link>
      </div>
      {missing !== null ? (
        <p role="alert" className="text-sm text-danger">
          {t('notFound', { runId: missing })}
        </p>
      ) : runs ? (
        <RunComparison a={runs[0]} b={runs[1]} prices={prices} />
      ) : null}
    </main>
  );
}
