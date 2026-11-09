import type { UserTaskView, WorkspacePreview, WorktreeCommandView } from '@corral/client';
import { Button, Input, Select } from '@corral/react/design-kit';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { previewDesktop as desktop } from '../desktop.tsx';
import { useServices } from '../services.tsx';
import { workHref } from './navigation.ts';
import { PreviewFeedback } from './PreviewFeedback.tsx';
import { type PreviewOutput, PreviewView } from './PreviewView.tsx';

/** Select an owned command, never an arbitrary localhost address. */
export function ServicePreview({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const t = useTranslations('Preview');
  const portId = useId();
  const { workspaces, workspaceId, mode } = useServices();
  const context = useMemo(
    () => ({ workspaces, workspaceId, sessionId, projectId }),
    [workspaces, workspaceId, sessionId, projectId],
  );
  const current = useRef(context);
  current.current = context;
  const [commands, setCommands] = useState<
    { id: string; label: string; kind: PreviewOutput['kind'] }[]
  >([]);
  const [operationId, select] = useState('');
  const [port, setPort] = useState('5173');
  const [opened, setOpened] = useState<{
    context: typeof context;
    lease: WorkspacePreview;
    output: PreviewOutput | null;
  } | null>(null);
  const lease = opened?.context === context ? opened.lease : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new destination must not inherit the previous pending state.
  useEffect(() => {
    setPending(false);
    setError(null);
  }, [context]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!workspaces || mode !== 'server') return;
    let live = true;
    // A Run's command or a task a person started; a terminal's server is not owned.
    const refresh = () =>
      void Promise.all([
        workspaces.commands(sessionId).catch(() => [] as WorktreeCommandView[]),
        workspaces.tasks
          ? workspaces.tasks(sessionId).then(
              (value) => value.tasks,
              () => [] as UserTaskView[],
            )
          : Promise.resolve([] as UserTaskView[]),
      ]).then(([items, tasks]) => {
        if (!live) return;
        setCommands([
          ...tasks
            .filter((task) => task.state === 'running')
            .map((task) => ({
              id: task.operationId,
              kind: 'task' as const,
              label: `${task.packageManager} run ${task.script}`,
            })),
          ...items
            .filter((item) => item.state === 'running')
            .map((item) => ({
              id: item.id,
              kind: 'command' as const,
              label: `${item.command ?? item.shellId} · ${item.cwd}`,
            })),
        ]);
      });
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [sessionId, workspaces, mode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Leaving the host or session closes its owned preview.
  useEffect(
    () => () => {
      if (opened)
        void opened.context.workspaces
          ?.stopPreview(opened.context.sessionId, opened.lease.leaseId)
          .catch(() => {});
    },
    [opened, context],
  );
  if (mode !== 'server') return <BrowserQaPreviewLink />;
  // The Preview tab is this pane's own view, so an idle one says why it is empty.
  if (!commands.length)
    return (
      <>
        <p className="text-caption text-muted-foreground">{t('noService')}</p>
        <BrowserQaPreviewLink />
      </>
    );
  const selected = commands.find((item) => item.id === operationId)?.id ?? commands[0]?.id ?? '';
  return (
    <section aria-label={t('service')} className="flex flex-col gap-2 border-b border-line pb-2">
      <h3 className="text-xs font-medium">{t('service')}</h3>
      <Select
        label={t('operation')}
        size="xs"
        value={selected}
        onValueChange={select}
        disabled={pending}
        options={commands.map((item) => ({ value: item.id, label: item.label }))}
      />
      <label htmlFor={portId} className="flex items-center gap-2 text-xs">
        {t('port')}
        <Input
          id={portId}
          type="number"
          min={1024}
          max={65535}
          value={port}
          disabled={pending}
          onChange={(event) => setPort(event.target.value)}
        />
      </label>
      {desktop ? (
        <Button
          size="compact"
          variant="tertiary"
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
              if (!alive.current || current.current !== context) {
                await workspaces.stopPreview(sessionId, next.leaseId);
                return;
              }
              await desktop.openPreview(sessionId, next.leaseId);
              const chosen = commands.find((item) => item.id === selected);
              if (alive.current && current.current === context)
                setOpened({
                  context,
                  lease: next,
                  output: chosen ? { kind: chosen.kind, operationId: chosen.id } : null,
                });
              else await workspaces.stopPreview(sessionId, next.leaseId);
            } catch (reason) {
              if (next) await workspaces.stopPreview(sessionId, next.leaseId).catch(() => {});
              if (alive.current && current.current === context)
                setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
              if (alive.current && current.current === context) setPending(false);
            }
          }}
        >
          {t('openInteractive')}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t('desktopOnly')}</p>
      )}
      {lease ? (
        <Button
          size="compact"
          variant="ghost"
          onClick={async () => {
            try {
              await workspaces?.stopPreview(sessionId, lease.leaseId);
              if (current.current === context) setOpened(null);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          }}
        >
          {t('close')}
        </Button>
      ) : null}
      {lease && opened ? (
        <PreviewView sessionId={sessionId} lease={lease} output={opened.output} />
      ) : null}
      {lease ? (
        <PreviewFeedback
          key={`${workspaceId}:${sessionId}:${lease.leaseId}`}
          projectId={projectId}
          sessionId={sessionId}
          lease={lease}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <BrowserQaPreviewLink />
    </section>
  );
}

/**
 * The browser QA feature preview, which returns here. Only a link: this pane never shows the
 * preview's sample page, snapshot or screenshot (docs/specs/features/feature-preview.md).
 */
function BrowserQaPreviewLink() {
  const t = useTranslations('Preview');
  const returnTo = workHref(useRouterState({ select: (state) => state.location.href }));
  return (
    <Button
      variant="ghost"
      size="compact"
      className="self-start"
      render={
        <Link
          to="/preview/$feature"
          params={{ feature: 'browser-qa' }}
          search={returnTo ? { returnTo } : {}}
        />
      }
    >
      {t('browserQaPreview')}
    </Button>
  );
}
