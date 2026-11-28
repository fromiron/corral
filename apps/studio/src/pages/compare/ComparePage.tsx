import { type ComparedRun, RunComparison } from '@corral/react';
import { Button, EmptyState, fontWeights, ThinkingIndicator } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useModelPrices } from '../../prices.ts';
import { currentProject } from '../../projects.ts';
import { compareRoute } from '../../router.tsx';
import { useServices } from '../../services.tsx';
import { runIdentity, runIdentityText } from '../../workbench/runIdentity.ts';

type Read =
  | { state: 'loading' }
  | { state: 'ready'; runs: [ComparedRun, ComparedRun] }
  | { state: 'refused'; missing: string[]; failed: boolean };

/** `/compare?a=&b=`: two runs side by side. Reads only; nothing is started. */
export function ComparePage() {
  const t = useTranslations('Compare');
  const identityText = useTranslations('RunIdentity');
  const { a, b } = compareRoute.useSearch();
  const { transport, repository } = useServices();
  const prices = useModelPrices();
  const [read, setRead] = useState<Read>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const incomplete = !a?.trim() || !b?.trim();
  const projectId = currentProject();

  useEffect(() => {
    void attempt;
    if (incomplete) return;
    let active = true;
    const summaries = transport.listRuns().catch(() => []);
    const load = async (runId: string): Promise<ComparedRun> => {
      const { projection } = await transport.getSnapshot(runId);
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
    const outcome = (
      runId: string,
    ): Promise<{ run: ComparedRun } | { missing: string } | { failed: true }> =>
      load(runId).then(
        (run) => ({ run }),
        async () => {
          const definition = await transport.getRunDefinition(runId).catch(() => undefined);
          return definition === null ? { missing: runId } : { failed: true };
        },
      );
    setRead({ state: 'loading' });
    void Promise.all([outcome(a ?? ''), outcome(b ?? '')]).then(([first, second]) => {
      if (!active) return;
      if ('run' in first && 'run' in second)
        return setRead({ state: 'ready', runs: [first.run, second.run] });
      setRead({
        state: 'refused',
        missing: [first, second].flatMap((item) => ('missing' in item ? [item.missing] : [])),
        failed: [first, second].some((item) => 'failed' in item),
      });
    });
    return () => {
      active = false;
    };
  }, [a, b, incomplete, transport, repository, identityText, attempt]);
  const chooseRuns = (
    <Link to="/projects/$projectId" params={{ projectId }} hash="runs" className="underline">
      {t('chooseRuns')}
    </Link>
  );

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-title" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('heading')}
        </h2>
        <Link to="/projects/$projectId" params={{ projectId }} className="text-caption underline">
          {t('back')}
        </Link>
      </div>
      {incomplete ? (
        <EmptyState
          title={t('empty')}
          action={
            <Button render={<Link to="/projects/$projectId" params={{ projectId }} hash="runs" />}>
              {t('chooseRuns')}
            </Button>
          }
        />
      ) : read.state === 'refused' ? (
        <div className="flex flex-col items-start gap-3 text-body">
          <div role="alert" className="flex flex-col gap-1 text-destructive">
            {read.missing.map((runId) => (
              <p key={runId} className="m-0">
                {t('notFound', { runId })}
              </p>
            ))}
            {read.failed ? <p className="m-0">{t('readFailed')}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {read.failed ? (
              <Button variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
                {t('retry')}
              </Button>
            ) : null}
            {chooseRuns}
          </div>
        </div>
      ) : read.state === 'ready' ? (
        <RunComparison a={read.runs[0]} b={read.runs[1]} prices={prices} />
      ) : (
        <ThinkingIndicator labels={{ status: t('loading'), words: [t('loading')] }} />
      )}
    </main>
  );
}
