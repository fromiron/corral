import type { WorktreeCommandView } from '@corral/client';
import type { CommandReport } from '@corral/contracts';
import { Button } from '@corral/react/design-kit';
import { RefreshCw } from '@corral/react/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

/** Operator readback comes from the persisted process record, never from a stop click. */
export function WorktreeCommandPanel({ sessionId }: { sessionId: string }) {
  return <CommandPanel key={sessionId} sessionId={sessionId} />;
}

function CommandPanel({ sessionId }: { sessionId: string }) {
  const t = useTranslations('Processes');
  const { workspaces, mode } = useServices();
  const [commands, setCommands] = useState<WorktreeCommandView[]>([]);
  const [selected, select] = useState('');
  const [detail, setDetail] = useState<{
    id: string;
    report: CommandReport;
    output: string;
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void revision; // Manual refresh and stop readback invalidate the polling snapshot.
    if (!workspaces || mode !== 'server') return;
    let live = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const items = await workspaces.commands(sessionId);
        if (live) {
          setCommands(items);
          select((current) =>
            items.some((item) => item.id === current)
              ? current
              : (items.find((item) => item.state === 'running')?.id ?? items[0]?.id ?? ''),
          );
        }
      } catch (reason) {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        pending = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), 2000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [workspaces, sessionId, mode, revision]);
  useEffect(() => {
    void revision;
    if (!workspaces || !selected || mode !== 'server') return;
    let live = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const [report, output] = await Promise.all([
          workspaces.commandReport(sessionId, selected),
          workspaces.commandOutput(sessionId, selected),
        ]);
        if (live)
          setDetail({
            id: selected,
            report,
            output: output.text,
            truncated:
              output.truncated || output.bytes > new TextEncoder().encode(output.text).length,
          });
      } catch (reason) {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        pending = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), 2000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [workspaces, sessionId, selected, mode, revision]);
  if (!workspaces || mode !== 'server') return null;
  const current = commands.find((item) => item.id === selected);
  const report = detail?.id === selected ? detail.report : null;
  const state = report?.state ?? current?.state;
  return (
    <section
      aria-label={t('title')}
      data-testid="worktree-command-panel"
      className="flex min-w-0 flex-col gap-2 border-b border-line pb-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{t('title')}</h3>
        <Button
          size="icon-compact"
          variant="ghost"
          aria-label={t('refresh')}
          onClick={() => {
            setError(null);
            refresh((value) => value + 1);
          }}
        >
          <RefreshCw />
        </Button>
      </div>
      {commands.length ? (
        <ul aria-label={t('history')} className="max-h-40 space-y-1 overflow-y-auto">
          {commands.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={item.id === selected}
                onClick={() => select(item.id)}
                className={`flex w-full min-w-0 items-start justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-raised ${item.id === selected ? 'bg-sidebar-selected' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate" title={item.command ?? undefined}>
                  {item.command ?? t('unavailableCommand')}
                </span>
                <span className="shrink-0 text-muted-foreground">{t(`state.${item.state}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('empty')}</p>
      )}
      {current ? (
        <div className="min-w-0 space-y-2">
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-subtle p-2 text-xs">
            {current.command ?? t('unavailableCommand')}
          </pre>
          <p className="break-words text-xs text-muted-foreground">
            {current.shellId} · {current.cwd} ·{' '}
            {current.mode === 'service' ? t('service') : t('foreground')}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
            <span>{state ? t(`state.${state}`) : t('loading')}</span>
            {report?.exitCode !== null && report?.exitCode !== undefined ? (
              <span>{t('exitCode', { code: report.exitCode })}</span>
            ) : null}
            {report?.timedOut ? <span className="text-danger">{t('timedOut')}</span> : null}
            {report && state !== 'running' ? (
              <span className={report.cleanupConfirmed ? 'text-muted-foreground' : 'text-danger'}>
                {report.cleanupConfirmed ? t('cleanupConfirmed') : t('cleanupUnconfirmed')}
              </span>
            ) : null}
          </div>
          {state === 'running' ? (
            <Button
              size="compact"
              variant="tertiary"
              disabled={stopping === selected}
              onClick={async () => {
                const operationId = selected;
                setStopping(operationId);
                setError(null);
                try {
                  const stopped = await workspaces.stopCommand(sessionId, operationId);
                  if (!alive.current) return;
                  setDetail((previous) => ({
                    id: operationId,
                    report: stopped,
                    output: previous?.id === operationId ? previous.output : '',
                    truncated: previous?.id === operationId ? previous.truncated : false,
                  }));
                  refresh((value) => value + 1);
                } catch (reason) {
                  if (alive.current)
                    setError(reason instanceof Error ? reason.message : String(reason));
                } finally {
                  if (alive.current) setStopping(null);
                }
              }}
            >
              {stopping === selected ? t('stopping') : t('stop')}
            </Button>
          ) : null}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('output')}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-subtle p-2 text-xs">
              {detail?.id === selected ? detail.output || t('noOutput') : t('loading')}
            </pre>
            {detail?.id === selected && detail.truncated ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('truncated')}</p>
            ) : null}
          </details>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
