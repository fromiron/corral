import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { StatusBadge } from './StatusBadge.tsx';

/**
 * Every Task of the run (C-025, Spec §7.1): one owner role each, its attempts, who started it,
 * and the versions it submitted. Submitted versions are what moves on; drafts are not listed.
 */
export function TaskBoard({
  session,
  onOpenArtifact,
}: {
  session: RunSessionStore;
  onOpenArtifact: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Tasks');
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  if (!projection) return null;
  const labelOf = (nodeId: string) =>
    definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const roleOf = (roleId: string) => definition?.roles.find((r) => r.id === roleId)?.name ?? roleId;
  const executionOfTask = (taskId: string) =>
    Object.values(projection.executions).find((e) => e.taskId === taskId);
  const tasks = Object.values(projection.tasks);

  return (
    <section aria-labelledby="tasks-heading" className="flex flex-col gap-1">
      <h3 id="tasks-heading" className="text-xs font-semibold">
        {t('heading')}
      </h3>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted">{t('empty')}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1">{t('task')}</th>
              <th>{t('owner')}</th>
              <th>{t('startedBy')}</th>
              <th>{t('status')}</th>
              <th>{t('submitted')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const execution = executionOfTask(task.taskId);
              const parent = execution?.parentExecutionId
                ? projection.executions[execution.parentExecutionId]
                : undefined;
              return (
                <tr
                  key={task.taskId}
                  className="border-t border-line align-top"
                  data-testid={`task-${task.taskId}`}
                >
                  <td className="py-1">
                    {labelOf(task.nodeId)}
                    {execution?.item ? (
                      <span className="block text-muted">{t('item', execution.item)}</span>
                    ) : null}
                    <span className="block font-mono text-muted">{task.taskId}</span>
                  </td>
                  <td>
                    {roleOf(task.roleId)}
                    {task.attemptCount > 1 ? (
                      <span className="block text-muted">
                        {t('attempts', { count: task.attemptCount })}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {parent ? (
                      <a href={`#execution-${parent.executionId}`} className="underline">
                        {labelOf(parent.nodeId)}
                      </a>
                    ) : (
                      <span className="text-muted">{t('graph')}</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="flex flex-wrap gap-1">
                    {task.submittedArtifactVersionIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onOpenArtifact(id)}
                        className="rounded border border-line px-1 font-mono underline-offset-2 hover:underline"
                      >
                        {id}
                      </button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
