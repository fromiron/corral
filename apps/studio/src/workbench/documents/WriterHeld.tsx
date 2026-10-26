import type { UserTaskView } from '@corral/client';
import { canonicalJson, TERMINAL_RUN_STATUSES, type WorkspaceTarget } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';

/**
 * A save refused because another writer holds the copy (strict mode). A running task
 * can be stopped here; a terminal or Run is stopped where it runs. Saving again stays explicit.
 */
export function WriterHeld({
  target,
  onReleased,
}: {
  target: WorkspaceTarget;
  onReleased?: () => void;
}) {
  const t = useTranslations('Documents');
  const td = useTranslations('DevTasks');
  const { workspaces, terminals, transport } = useServices();
  const { sessionId } = target;
  const scope = canonicalJson(target);
  const [tasks, setTasks] = useState<UserTaskView[]>([]);
  const [hasTerminal, setHasTerminal] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [stopping, setStopping] = useState(false);
  const [released, setReleased] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (workspaces?.tasks)
      void workspaces.tasks(sessionId).then(
        (value) => live && setTasks(value.tasks.filter((task) => task.state === 'running')),
        () => {},
      );
    if (terminals)
      void terminals.list(sessionId).then(
        (value) =>
          live &&
          setHasTerminal(
            value.terminals.some(
              (terminal) =>
                canonicalJson(terminal.target) === scope &&
                !['exited', 'failed'].includes(terminal.state),
            ),
          ),
        () => {},
      );
    if (transport)
      void transport.listRuns().then(
        (value) =>
          live &&
          setRuns(
            value.filter(
              (run) => run.sessionId === sessionId && !TERMINAL_RUN_STATUSES.has(run.status),
            ),
          ),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [workspaces, terminals, transport, sessionId, scope]);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
      <span className={released ? 'text-muted-foreground' : 'text-danger'}>
        {released ? t('writerReleased') : t('writerHeld')}
      </span>
      {released
        ? null
        : tasks.map((task) => (
            <Button
              key={task.operationId}
              size="compact"
              variant="tertiary"
              disabled={stopping}
              onClick={async () => {
                if (!workspaces) return;
                setStopping(true);
                setError(null);
                try {
                  const stopped = await workspaces.stopTask(sessionId, task.operationId);
                  if (stopped.cleanupConfirmed) {
                    setReleased(true);
                    onReleased?.();
                  } else setError(td(`state.${stopped.state}`));
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason));
                } finally {
                  setStopping(false);
                }
              }}
            >
              {td('stop', { script: task.script })}
            </Button>
          ))}
      {!released && hasTerminal ? (
        <Button
          size="compact"
          variant="tertiary"
          render={
            <Link to="/sessions/$sessionId" params={{ sessionId }} search={{ panel: 'terminal' }} />
          }
        >
          {t('openTerminal')}
        </Button>
      ) : null}
      {!released
        ? runs.map((run) => (
            <Button
              key={run.runId}
              size="compact"
              variant="tertiary"
              render={
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId }}
                  search={{ panel: 'run', run: run.runId, view: 'run' }}
                />
              }
            >
              {t('openActiveRun', { id: run.runId.slice(-6) })}
            </Button>
          ))
        : null}
      {error ? <span className="text-danger">{error}</span> : null}
    </div>
  );
}
