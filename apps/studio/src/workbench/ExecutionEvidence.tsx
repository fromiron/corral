import type { FileOperationView, VerificationResultView } from '@corral/client';
import type { RunSessionStore } from '@corral/react';
import { Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';

type Loaded = {
  sessionId: string;
  files: FileOperationView[];
  checks: VerificationResultView[];
};

/**
 * What one execution left (CR-046 P18): the files its broker writes touched, the results it
 * authored and the checks it ran, each leading to where that is reviewed. Only records that name
 * this run and execution are shown; a write whose outcome is unknown says so.
 */
export function ExecutionEvidence({
  session,
  sessionId,
  executionId,
  onOpenArtifact,
}: {
  session: RunSessionStore;
  sessionId: string;
  executionId: string;
  onOpenArtifact(artifactVersionId: string): void;
}) {
  const t = useTranslations('RunPage');
  const { workspaces, mode } = useServices();
  const runId = useStore(session, (state) => state.projection?.runId ?? null);
  const artifacts = useStore(session, (state) => state.projection?.artifacts);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!workspaces || mode !== 'server') return;
    let live = true;
    void Promise.all([
      workspaces.fileOperations(sessionId).catch(() => []),
      workspaces.verifications(sessionId).catch(() => []),
    ]).then(([files, checks]) => {
      if (live) setLoaded({ sessionId, files, checks });
    });
    return () => {
      live = false;
    };
  }, [workspaces, mode, sessionId]);
  // An answer read for another session is never shown here.
  const current = loaded?.sessionId === sessionId ? loaded : null;
  const seen = new Set<string>();
  const files = (current?.files ?? []).filter((op) => {
    if (op.run_id !== runId || op.execution_id !== executionId) return false;
    const path = op.to_path ?? op.path;
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
  const checks = (current?.checks ?? []).filter(
    (check) =>
      check.report?.owner.kind === 'execution' &&
      check.report.owner.runId === runId &&
      check.report.owner.executionId === executionId,
  );
  const results = Object.values(artifacts ?? {}).filter(
    (artifact) => artifact.authorExecutionId === executionId,
  );
  if (!runId || (!files.length && !checks.length && !results.length)) return null;
  return (
    <section aria-label={t('evidence')} className="mt-4 flex flex-col gap-3 text-xs">
      {files.length ? (
        <div>
          <h3 className="mb-1 font-medium">{t('evidenceFiles')}</h3>
          <ul className="flex flex-col gap-0.5">
            {files.map((op) => (
              <li key={op.id} className="flex items-baseline gap-2">
                <Link
                  to="/sessions/$sessionId/review"
                  params={{ sessionId }}
                  search={{ scope: 'run', runId, file: op.to_path ?? op.path }}
                  className="min-w-0 truncate font-mono hover:underline"
                >
                  {op.to_path ? `${op.path} → ${op.to_path}` : op.path}
                </Link>
                {op.state === 'uncertain' ? (
                  <span className="shrink-0 text-warning">{t('uncertainWrite')}</span>
                ) : op.state !== 'applied' ? (
                  <span className="shrink-0 text-muted-foreground">{op.state}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {results.length ? (
        <div>
          <h3 className="mb-1 font-medium">{t('evidenceResults')}</h3>
          <ul className="flex flex-col gap-0.5">
            {results.map((artifact) => (
              <li key={artifact.artifactVersionId}>
                <Button
                  variant="ghost"
                  size="compact"
                  className="-ml-2"
                  onClick={() => onOpenArtifact(artifact.artifactVersionId)}
                >
                  {artifact.name} · v{artifact.version}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {checks.length ? (
        <div>
          <h3 className="mb-1 font-medium">{t('evidenceChecks')}</h3>
          <ul className="flex flex-col gap-0.5">
            {checks.map((check) => (
              <li key={check.verificationId}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId }}
                  search={{ panel: 'checks' }}
                  className="hover:underline"
                >
                  {check.name}
                </Link>
                {check.stale || check.configChanged ? (
                  <span className="ml-2 text-warning">{t('evidenceCheckEarlier')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
