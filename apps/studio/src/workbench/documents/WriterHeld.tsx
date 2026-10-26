import type { UserTaskView } from '@corral/client';
import { Button } from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';

/**
 * A save refused because another writer holds the copy (strict mode). A running task
 * can be stopped here; a terminal or Run is stopped where it runs. Saving again stays explicit.
 */
export function WriterHeld({
  sessionId,
  onReleased,
}: {
  sessionId: string;
  onReleased?: () => void;
}) {
  const t = useTranslations('Documents');
  const td = useTranslations('DevTasks');
  const { workspaces } = useServices();
  const [tasks, setTasks] = useState<UserTaskView[]>([]);
  const [stopping, setStopping] = useState(false);
  const [released, setReleased] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaces?.tasks) return;
    let live = true;
    void workspaces.tasks(sessionId).then(
      (value) => live && setTasks(value.tasks.filter((task) => task.state === 'running')),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [workspaces, sessionId]);
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
      {error ? <span className="text-danger">{error}</span> : null}
    </div>
  );
}
