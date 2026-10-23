import type { ChangeSetView } from '@corral/client';
import { Button } from '@corral/react/design-kit';
import { FileDiff } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

/** Fixed start/end trees; never capture a new snapshot just to show a summary. */
export function RunChanges({ sessionId, runId }: { sessionId: string; runId: string }) {
  const { workspaces } = useServices();
  const t = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const tw = useTranslations('Workbench');
  const ts = useTranslations('Sessions');
  const [changes, setChanges] = useState<ChangeSetView | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void retry;
    let current = true;
    setChanges(null);
    setError(false);
    void workspaces
      ?.changes(sessionId, { kind: 'run', runId })
      .then((value) => {
        if (current) setChanges(value);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [workspaces, sessionId, runId, retry]);
  const unknown =
    changes?.files.filter((file) => file.additions === null || file.deletions === null).length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button
        variant="tertiary"
        size="compact"
        data-testid="run-change-summary"
        render={
          <Link
            to="/sessions/$sessionId/review"
            params={{ sessionId }}
            search={{ scope: 'run', runId }}
          />
        }
      >
        <FileDiff />
        {changes?.unavailable
          ? tf('noBaseline')
          : changes
            ? `${tw('changeCount', { count: changes.files.length })} · +${changes.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)} −${changes.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)}`
            : ts('reviewChanges')}
      </Button>
      {unknown > 0 ? (
        <span className="text-muted-foreground">{t('uncountedChanges', { count: unknown })}</span>
      ) : null}
      {error ? (
        <Button variant="ghost" size="compact" onClick={() => setRetry((value) => value + 1)}>
          {t('retryChanges')}
        </Button>
      ) : null}
    </div>
  );
}
