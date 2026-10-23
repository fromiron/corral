import type { WorkspacePreview } from '@corral/client';
import { Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { previewDesktop as desktop } from '../desktop.tsx';
import { useServices } from '../services.tsx';

/** Human and model open the same run-owned lease; source navigation keeps concurrent runs distinct. */
export function PreviewLeases({ sessionId }: { sessionId: string }) {
  const t = useTranslations('Preview');
  const format = useFormatter();
  const { workspaces, mode } = useServices();
  const [leases, setLeases] = useState<WorkspacePreview[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaces || mode !== 'server') return;
    let live = true;
    const refresh = () =>
      void workspaces.previews(sessionId).then(
        (items) => {
          if (live) setLeases(items.filter((lease) => lease.runId && lease.state === 'ready'));
        },
        () => {
          if (live) setLeases([]);
        },
      );
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sessionId, workspaces, mode]);
  if (!leases.length) return null;
  return (
    <section aria-label={t('opened')} className="flex flex-col gap-2 border-b border-line pb-2">
      <h3 className="text-xs font-medium">{t('opened')}</h3>
      <ul className="flex flex-col gap-2">
        {leases.map((lease) => (
          <li key={lease.leaseId} className="flex flex-col gap-1 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={lease.path}>
                {lease.kind === 'service' ? `${t('service')} · ` : ''}
                {lease.path}
              </span>
              <time dateTime={lease.createdAt} className="shrink-0 text-muted-foreground">
                {format.dateTime(new Date(lease.createdAt), { timeStyle: 'short' })}
              </time>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {desktop || lease.kind === 'static' ? (
                <Button
                  variant="tertiary"
                  size="compact"
                  onClick={() => {
                    setError(null);
                    if (desktop)
                      void desktop
                        .openPreview(sessionId, lease.leaseId)
                        .catch((reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : String(reason)),
                        );
                    else setOpened(lease.leaseId);
                  }}
                >
                  {desktop ? t('openInteractive') : t('open')}
                </Button>
              ) : (
                <span className="text-muted-foreground">{t('desktopOnly')}</span>
              )}
              <Link
                className="text-primary underline"
                to="/sessions/$sessionId"
                params={{ sessionId }}
                search={{ panel: 'run', run: lease.runId, view: 'run' }}
              >
                {t('runSource')}
              </Link>
              <Button
                variant="ghost"
                size="compact"
                onClick={async () => {
                  try {
                    await workspaces?.stopPreview(sessionId, lease.leaseId);
                    setLeases((items) => items.filter((item) => item.leaseId !== lease.leaseId));
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                  }
                }}
              >
                {t('close')}
              </Button>
            </div>
            {!desktop && lease.kind === 'static' && opened === lease.leaseId ? (
              <>
                <iframe
                  title={t('title')}
                  src={lease.url}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  className="h-[45vh] min-h-64 w-full rounded border border-line bg-white"
                />
                <p className="text-2xs text-muted-foreground">{t('staticOnly')}</p>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
