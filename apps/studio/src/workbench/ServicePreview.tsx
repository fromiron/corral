import type { WorkspacePreview, WorktreeCommandView } from '@corral/client';
import { Button, Input, Select } from '@corral/react/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { previewDesktop as desktop } from '../desktop.tsx';
import { useServices } from '../services.tsx';

/** Select an owned command, never an arbitrary localhost address. */
export function ServicePreview({ sessionId }: { sessionId: string }) {
  const t = useTranslations('Preview');
  const portId = useId();
  const { workspaces, mode } = useServices();
  const [commands, setCommands] = useState<WorktreeCommandView[]>([]);
  const [operationId, select] = useState('');
  const [port, setPort] = useState('5173');
  const [lease, setLease] = useState<WorkspacePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!workspaces || mode !== 'server') return;
    let live = true;
    const refresh = () =>
      void workspaces.commands(sessionId).then(
        (items) => {
          if (live) setCommands(items.filter((item) => item.state === 'running'));
        },
        () => {
          if (live) setCommands([]);
        },
      );
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [sessionId, workspaces, mode]);
  useEffect(
    () => () => {
      if (lease) void workspaces?.stopPreview(sessionId, lease.leaseId).catch(() => {});
    },
    [lease, sessionId, workspaces],
  );
  if (mode !== 'server' || !commands.length) return null;
  const selected = commands.find((item) => item.id === operationId)?.id ?? commands[0]?.id ?? '';
  return (
    <section aria-label={t('service')} className="flex flex-col gap-2 border-b border-line pb-2">
      <h3 className="text-xs font-medium">{t('service')}</h3>
      <Select
        label={t('operation')}
        size="xs"
        value={selected}
        onValueChange={select}
        options={commands.map((item) => ({
          value: item.id,
          label: `${item.command ?? item.shellId} · ${item.cwd}`,
        }))}
      />
      <label htmlFor={portId} className="flex items-center gap-2 text-xs">
        {t('port')}
        <Input
          id={portId}
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(event) => setPort(event.target.value)}
        />
      </label>
      {desktop ? (
        <Button
          size="xs"
          variant="outline"
          disabled={
            pending ||
            !selected ||
            !Number.isInteger(Number(port)) ||
            Number(port) < 1024 ||
            Number(port) > 65535
          }
          onClick={async () => {
            if (!workspaces || !desktop) return;
            setPending(true);
            setError(null);
            let next: WorkspacePreview | undefined;
            try {
              next = await workspaces.startPreview(sessionId, {
                operationId: selected,
                port: Number(port),
              });
              if (!alive.current) {
                await workspaces.stopPreview(sessionId, next.leaseId);
                return;
              }
              await desktop.openPreview(sessionId, next.leaseId);
              if (alive.current) setLease(next);
              else await workspaces.stopPreview(sessionId, next.leaseId);
            } catch (reason) {
              if (next) await workspaces.stopPreview(sessionId, next.leaseId).catch(() => {});
              setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
              setPending(false);
            }
          }}
        >
          {t('openInteractive')}
        </Button>
      ) : (
        <p className="text-xs text-muted">{t('desktopOnly')}</p>
      )}
      {lease ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            try {
              await workspaces?.stopPreview(sessionId, lease.leaseId);
              setLease(null);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          }}
        >
          {t('close')}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
