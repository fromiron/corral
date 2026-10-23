import type { TaskCandidates, UserTaskView } from '@corral/client';
import { Button } from '@corral/react/design-kit';
import { Play, Square } from '@corral/react/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { DeploymentTasks } from './DeploymentTasks.tsx';

const OUTPUT_LIMIT = 64 * 1024;
const open = (task: UserTaskView) => task.state === 'running' || task.state === 'uncertain';

/**
 * Package scripts of the session copy (CR-046 P15). Listing reads package.json only; a script runs
 * when a person starts it, and holds the copy's writer until its process group is gone.
 */
export function WorkbenchTasks({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  return (
    <>
      <Tasks key={sessionId} sessionId={sessionId} projectId={projectId} />
      <DeploymentTasks sessionId={sessionId} projectId={projectId} />
    </>
  );
}

function Tasks({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const t = useTranslations('DevTasks');
  const { workspaces, workspaceId, mode } = useServices();
  const [candidates, setCandidates] = useState<TaskCandidates | null>(null);
  const [tasks, setTasks] = useState<UserTaskView[]>([]);
  const [selected, select] = useState('');
  const [output, setOutput] = useState<{ id: string; text: string; offset: number } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const enabled = Boolean(workspaces?.tasks) && mode === 'server';
  useEffect(() => {
    void revision;
    if (!workspaces?.tasks || mode !== 'server') return;
    let live = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await workspaces.tasks(sessionId);
        if (!live) return;
        setCandidates(value.candidates);
        setTasks(value.tasks);
        select((current) =>
          value.tasks.some((task) => task.operationId === current)
            ? current
            : (value.tasks.find(open)?.operationId ?? value.tasks[0]?.operationId ?? ''),
        );
      } catch (reason) {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        reading = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [workspaces, sessionId, mode, revision]);
  const current = tasks.find((task) => task.operationId === selected);
  const running = current ? open(current) : false;
  useEffect(() => {
    if (!workspaces?.taskOutput || !selected || mode !== 'server') return;
    let live = true;
    let reading = false;
    let offset = 0;
    let text = '';
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const chunk = await workspaces.taskOutput(sessionId, selected, offset);
        if (!live) return;
        offset = chunk.nextOffset;
        text = (text + chunk.text).slice(-OUTPUT_LIMIT);
        setOutput({ id: selected, text, offset });
      } catch {
        /* The task list shows the receipt; output may be gone after a restart. */
      } finally {
        reading = false;
      }
    };
    void read();
    const interval = running ? setInterval(() => void read(), 1500) : undefined;
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [workspaces, sessionId, selected, running, mode]);
  const start = useCallback(
    async (script: string) => {
      if (!workspaces || !workspaceId) return;
      setPending(script);
      setError(null);
      try {
        const copy = await workspaces.worktree(sessionId);
        if (!copy || copy.missing) throw new Error(t('noCopy'));
        const task = await workspaces.startTask(sessionId, {
          operationId: `task_${crypto.randomUUID().replaceAll('-', '')}`,
          target: {
            hostId: workspaceId,
            projectId,
            bindingId: copy.bindingId,
            sessionId,
            copyGeneration: copy.copyGeneration,
          },
          script,
        });
        if (!alive.current) return;
        setTasks((items) => [
          task,
          ...items.filter((item) => item.operationId !== task.operationId),
        ]);
        select(task.operationId);
      } catch (reason) {
        if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (alive.current) {
          setPending(null);
          setRevision((value) => value + 1);
        }
      }
    },
    [workspaces, workspaceId, projectId, sessionId, t],
  );
  const stop = useCallback(
    async (task: UserTaskView) => {
      if (!workspaces) return;
      setPending(task.script);
      setError(null);
      try {
        const next = await workspaces.stopTask(sessionId, task.operationId);
        if (alive.current)
          setTasks((items) =>
            items.map((item) => (item.operationId === next.operationId ? next : item)),
          );
      } catch (reason) {
        if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (alive.current) {
          setPending(null);
          setRevision((value) => value + 1);
        }
      }
    },
    [workspaces, sessionId],
  );
  if (!enabled || !candidates) return null;
  const shown = output?.id === selected ? output.text : '';
  return (
    <section
      aria-label={t('title')}
      data-testid="workbench-tasks"
      className="flex min-w-0 flex-col gap-2 border-b border-line pb-3"
    >
      <h3 className="text-xs font-medium">{t('title')}</h3>
      {candidates.scripts.length ? (
        <ul aria-label={t('scripts')} className="max-h-48 space-y-0.5 overflow-y-auto">
          {candidates.scripts.map((script) => {
            const live = tasks.find((task) => task.script === script.name && open(task));
            const last = live ?? tasks.find((task) => task.script === script.name);
            return (
              <li key={script.name} className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5">
                <Button
                  variant={last && last.operationId === selected ? 'secondary' : 'ghost'}
                  size="compact"
                  disabled={!last}
                  aria-pressed={Boolean(last) && last?.operationId === selected}
                  onClick={() => last && select(last.operationId)}
                  title={script.command}
                  className="min-w-0 flex-1 justify-start gap-2 text-left"
                >
                  <span className="shrink-0 font-mono">{script.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {script.command}
                  </span>
                  {last ? (
                    <span className="shrink-0 text-muted-foreground">
                      {t(`state.${last.state}`)}
                    </span>
                  ) : null}
                </Button>
                {live ? (
                  <Button
                    size="icon-compact"
                    variant="ghost"
                    aria-label={t('stop', { script: script.name })}
                    disabled={pending !== null || live.state !== 'running'}
                    onClick={() => void stop(live)}
                  >
                    <Square />
                  </Button>
                ) : (
                  <Button
                    size="icon-compact"
                    variant="ghost"
                    aria-label={t('run', { script: script.name })}
                    disabled={pending !== null}
                    onClick={() => void start(script.name)}
                  >
                    <Play />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('empty')}</p>
      )}
      {current ? (
        <pre
          role="log"
          aria-label={t('output', { script: current.script })}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-subtle p-2 text-xs"
        >
          {shown}
        </pre>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
