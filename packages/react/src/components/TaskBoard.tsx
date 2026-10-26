import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  KitButton,
  KitCard,
  KitCardContent,
  KitCardHeader,
  KitCardTitle,
  KitTable,
  KitTableBody,
  KitTableCell,
  KitTableHead,
  KitTableHeader,
  KitTableRow,
} from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { StatusBadge } from './StatusBadge.tsx';

/**
 * Every Task of the run: one owner role each, its attempts, who started it,
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
    <KitCard role="region" aria-labelledby="tasks-heading">
      <KitCardHeader>
        <h3 id="tasks-heading">
          <KitCardTitle>{t('heading')}</KitCardTitle>
        </h3>
      </KitCardHeader>
      <KitCardContent className="overflow-x-auto">
        {tasks.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <KitTable>
            <KitTableHeader>
              <KitTableRow>
                <KitTableHead>{t('task')}</KitTableHead>
                <KitTableHead>{t('owner')}</KitTableHead>
                <KitTableHead>{t('startedBy')}</KitTableHead>
                <KitTableHead>{t('status')}</KitTableHead>
                <KitTableHead>{t('submitted')}</KitTableHead>
              </KitTableRow>
            </KitTableHeader>
            <KitTableBody>
              {tasks.map((task, index) => {
                const execution = executionOfTask(task.taskId);
                const parent = execution?.parentExecutionId
                  ? projection.executions[execution.parentExecutionId]
                  : undefined;
                return (
                  <KitTableRow
                    key={task.taskId}
                    index={index}
                    className="align-top"
                    data-testid={`task-${task.taskId}`}
                  >
                    <KitTableCell>
                      {labelOf(task.nodeId)}
                      {execution?.item ? (
                        <span className="block text-muted-foreground">
                          {t('item', execution.item)}
                        </span>
                      ) : null}
                      <span className="block font-mono text-muted-foreground">{task.taskId}</span>
                    </KitTableCell>
                    <KitTableCell>
                      {roleOf(task.roleId)}
                      {task.attemptCount > 1 ? (
                        <span className="block text-muted-foreground">
                          {t('attempts', { count: task.attemptCount })}
                        </span>
                      ) : null}
                    </KitTableCell>
                    <KitTableCell>
                      {parent ? (
                        <a href={`#execution-${parent.executionId}`} className="underline">
                          {labelOf(parent.nodeId)}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{t('graph')}</span>
                      )}
                    </KitTableCell>
                    <KitTableCell>
                      <StatusBadge status={task.status} />
                    </KitTableCell>
                    <KitTableCell>
                      <div className="flex flex-wrap gap-1">
                        {task.submittedArtifactVersionIds.map((id) => (
                          <KitButton
                            key={id}
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenArtifact(id)}
                            className="font-mono"
                          >
                            {id}
                          </KitButton>
                        ))}
                      </div>
                    </KitTableCell>
                  </KitTableRow>
                );
              })}
            </KitTableBody>
          </KitTable>
        )}
      </KitCardContent>
    </KitCard>
  );
}
