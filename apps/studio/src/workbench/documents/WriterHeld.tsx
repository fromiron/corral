import type { UserTaskView } from '@corral/client';
import {
  type CommandError,
  canonicalJson,
  TERMINAL_RUN_STATUSES,
  type WorkspaceTarget,
} from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import {
  Banner,
  BannerActions,
  BannerDescription,
  BannerTitle,
  Button,
} from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { holderKind } from '../refusal.ts';

/**
 * A save refused because another owner holds the copy. When the refusal names that owner
 * (api-contract.md 오류, `owner`), the banner names it and offers only its action: a task's stop,
 * or a terminal's controls; a run or an operation has none. A refusal without one lists the
 * running task, terminal or Run that may hold it. Saving again stays explicit.
 */
export function WriterHeld({
  target,
  owner,
  onReleased,
}: {
  target: WorkspaceTarget;
  owner?: CommandError['owner'] | undefined;
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
  const holder = owner ? holderKind(owner) : null;
  useEffect(() => {
    let live = true;
    // A named holder is the one thing to act on: only a task's stop needs the task's name.
    if (workspaces?.tasks && (!owner || owner.kind === 'task'))
      void workspaces.tasks(sessionId).then(
        (value) =>
          live &&
          setTasks(
            value.tasks.filter((task) =>
              owner
                ? task.operationId === owner.id && ['running', 'uncertain'].includes(task.state)
                : task.state === 'running',
            ),
          ),
        () => {},
      );
    if (owner)
      return () => {
        live = false;
      };
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
  }, [workspaces, terminals, transport, sessionId, scope, owner]);
  const terminalLink =
    !released && (owner ? owner.kind === 'terminal' : hasTerminal) ? (
      <Button
        variant="tertiary"
        render={
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId }}
            search={
              owner?.kind === 'terminal'
                ? { panel: 'terminal', terminal: owner.id }
                : { panel: 'terminal' }
            }
          />
        }
      >
        {t('openTerminal')}
      </Button>
    ) : null;
  return (
    <Banner status={released ? 'success' : 'warning'} role="alert">
      <BannerTitle>
        {released ? t('writerReleased') : holder ? t(`saveHeld.${holder}`) : t('writerHeld')}
      </BannerTitle>
      {error ? <BannerDescription className="text-danger">{error}</BannerDescription> : null}
      <BannerActions>
        {released
          ? null
          : tasks
              .filter((task) => !owner || (owner.kind === 'task' && task.operationId === owner.id))
              .map((task) => (
                <Button
                  key={task.operationId}
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
        {terminalLink}
        {!released && !owner
          ? runs.map((run) => (
              <Button
                key={run.runId}
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
      </BannerActions>
    </Banner>
  );
}
