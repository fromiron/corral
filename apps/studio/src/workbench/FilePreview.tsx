import type { WorkspacePreview } from '@corral/client';
import { Button } from '@corral/react/design-kit';
import { RefreshCw, X } from '@corral/react/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { previewDesktop as desktop } from '../desktop.tsx';
import { useServices } from '../services.tsx';

export const canPreviewFile = (path: string) => /\.(?:html?|png|jpe?g|webp|gif|svg)$/i.test(path);

/** Viewing a file creates no worker/run and never runs HTML in the Studio origin. */
export function FilePreview({ sessionId, path }: { sessionId: string; path: string }) {
  const t = useTranslations('Preview');
  const { workspaces } = useServices();
  const [requested, setRequested] = useState(false);
  const [lease, setLease] = useState<WorkspacePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [revision, refresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!requested || !workspaces) return;
    const current = ++generation.current;
    let owned: WorkspacePreview | undefined;
    setLease(null);
    setError(null);
    void workspaces.startPreview(sessionId, { path }).then(
      (result) => {
        owned = result;
        if (generation.current === current) setLease(result);
        else void workspaces.stopPreview(sessionId, result.leaseId).catch(() => {});
      },
      (reason: unknown) => {
        if (generation.current === current)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      generation.current++;
      if (owned) void workspaces.stopPreview(sessionId, owned.leaseId).catch(() => {});
    };
  }, [requested, path, sessionId, workspaces]);
  if (!requested)
    return (
      <Button size="compact" variant="tertiary" onClick={() => setRequested(true)}>
        {t('open')}
      </Button>
    );
  return (
    <section aria-label={t('title')} className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs" title={path}>
          {path}
        </span>
        {desktop && lease ? (
          <Button
            size="compact"
            variant="tertiary"
            onClick={() => {
              void desktop
                ?.openPreview(sessionId, lease.leaseId)
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : String(reason)),
                );
            }}
          >
            {t('openInteractive')}
          </Button>
        ) : null}
        <Button
          size="icon-compact"
          variant="ghost"
          aria-label={t('refresh')}
          disabled={!lease}
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw />
        </Button>
        <Button
          size="icon-compact"
          variant="ghost"
          aria-label={t('close')}
          disabled={closing}
          onClick={async () => {
            setClosing(true);
            try {
              if (lease) await workspaces?.stopPreview(sessionId, lease.leaseId);
              setRequested(false);
              setLease(null);
              setError(null);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
              setClosing(false);
            }
          }}
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : lease ? (
        <iframe
          key={`${lease.leaseId}:${revision}`}
          title={t('title')}
          src={lease.url}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-[45vh] min-h-64 w-full rounded border border-line bg-white"
          data-testid="file-preview-frame"
        />
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {t('loading')}
        </p>
      )}
      <p className="text-2xs text-muted-foreground">{t('staticOnly')}</p>
    </section>
  );
}
