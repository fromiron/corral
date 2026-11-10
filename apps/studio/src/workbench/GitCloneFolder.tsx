import { Button, fontWeights, Input } from '@corral/react/design-kit';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type CloneOperation, projectRequest } from '../projects-api.ts';

/** What is typed into the clone form; its owner may keep it while the form is unmounted. */
export interface GitCloneDraft {
  source: string;
  destination: string;
}

export function GitCloneFolder({
  onSelect,
  draft,
  onDraftChange,
}: {
  onSelect(path: string): void;
  draft?: GitCloneDraft;
  onDraftChange?(draft: GitCloneDraft): void;
}) {
  const t = useTranslations('GitClone');
  const [own, setOwn] = useState<GitCloneDraft>({ source: '', destination: '' });
  const { source, destination } = draft && onDraftChange ? draft : own;
  const change = draft && onDraftChange ? onDraftChange : setOwn;
  const setSource = (value: string) => change({ source: value, destination });
  const setDestination = (value: string) => change({ source, destination: value });
  const [operations, setOperations] = useState<CloneOperation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setOperations(
        (await projectRequest<{ operations: CloneOperation[] }>('/project-clones')).operations,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t('loadFailed'));
    }
  }, [t]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const running = operations.some((op) => op.state === 'running');
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => void refresh(), 1000);
    return () => clearInterval(interval);
  }, [running, refresh]);
  return (
    <details className="rounded fill-group p-3 text-body">
      <summary className="cursor-pointer" style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('title')}
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-caption text-muted-foreground">{t('intro')}</p>
        <label className="flex flex-col gap-1 text-caption">
          {t('source')}
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://github.com/owner/repository.git"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1 text-caption">
          {t('destination')}
          <Input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            spellCheck={false}
          />
        </label>
        <Button
          type="button"
          size="compact"
          className="self-start"
          disabled={busy || !source.trim() || !destination.trim()}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await projectRequest('/project-clones', {
                commandId: `clone_${crypto.randomUUID()}`,
                source: source.trim(),
                destination: destination.trim(),
              });
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : t('startFailed'));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('start')}
        </Button>
        <ul className="flex flex-col gap-2">
          {operations
            .slice(-6)
            .reverse()
            .map((op) => (
              <li
                key={op.id}
                className="flex flex-wrap items-center gap-2 border-t border-line pt-2"
              >
                <div className="min-w-0 flex-1 text-caption">
                  <div className="truncate" title={op.destination}>
                    {op.destination}
                  </div>
                  <span
                    role={op.state === 'running' ? 'status' : undefined}
                    className="text-muted-foreground"
                  >
                    {op.progress}
                  </span>
                </div>
                {op.state === 'running' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={async () => {
                      try {
                        await projectRequest(`/project-clones/${op.id}/cancel`, {});
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : t('cancelFailed'));
                      }
                    }}
                  >
                    {t('cancel')}
                  </Button>
                ) : null}
                {op.state === 'completed' ? (
                  <Button
                    type="button"
                    variant="tertiary"
                    size="compact"
                    onClick={() => onSelect(op.destination)}
                  >
                    {t('use')}
                  </Button>
                ) : null}
                {op.state !== 'running' &&
                op.state !== 'completed' &&
                op.partialDirectory &&
                op.cleanupConfirmed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={async () => {
                      try {
                        await projectRequest(`/project-clones/${op.id}/remove-partial`, {});
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : t('cleanupFailed'));
                      }
                    }}
                  >
                    {t('removePartial')}
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
