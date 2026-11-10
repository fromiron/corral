import {
  type AgentTask,
  type AgentTaskStatus,
  AgentTasks,
  Button,
  cn,
  EmptyState,
  fontWeights,
  useShape,
} from '@corral/react/design-kit';
import { Folder, GitBranch, MessageSquare } from '@corral/react/icons';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import {
  SAMPLE_MODEL,
  SAMPLE_PROJECT,
  SAMPLE_TASKS,
  type SampleTask,
  type SampleText,
} from './fixture.ts';
import { useSample, useTaskLabels } from './labels.ts';
import { SimulatedResult, usePreviewClock, useRunName } from './parts.tsx';
import { selectTask, setTaskStatus, usePreview } from './store.ts';

// Task board preview: the task list, one task's steps, files and linked session, a status change
// and its simulated result.

/** The statuses a person moves a task between; failed and cancelled come from a run. */
const STATUS_CHOICES = [
  'queued',
  'running',
  'ready',
  'merged',
] as const satisfies AgentTaskStatus[];

/** A sample task as the kit draws it, in its current (possibly simulated) status. */
function kitTask(
  task: SampleTask,
  status: AgentTaskStatus,
  say: (text: SampleText) => string,
  live: (sampleAt: number) => number,
): AgentTask {
  // A step still under way stops with its run once a simulated status ends the run.
  const steps =
    status === 'running' ? task.steps : task.steps.filter((step) => step.state !== 'active');
  return {
    id: task.id,
    title: say(task.title),
    status,
    repo: SAMPLE_PROJECT.repo,
    repoLogo: Folder,
    branch: task.branch,
    model: SAMPLE_MODEL,
    ...(task.startedAt === undefined ? {} : { startedAt: live(task.startedAt) }),
    ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
    ...(task.error ? { error: say(task.error) } : {}),
    ...(task.checks ? { checks: task.checks } : {}),
    ...(task.pullRequest === undefined
      ? {}
      : {
          pullRequest: {
            number: task.pullRequest,
            ...(status === 'merged' ? {} : { state: 'open' as const }),
          },
        }),
    ...(task.files.length
      ? {
          additions: task.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: task.files.reduce((sum, file) => sum + file.deletions, 0),
          filesChanged: task.files.length,
        }
      : {}),
    steps: steps.map((step, index) => ({
      id: `${task.id}-${index}`,
      text: say(step.text),
      state: step.state,
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      ...(step.startedAt === undefined ? {} : { startedAt: live(step.startedAt) }),
      ...(step.note ? { note: step.note } : {}),
    })),
    files: task.files.map((file) => ({ ...file })),
  };
}

export function TaskBoardPreview({ onOpenPull }: { onOpenPull: (number: number) => void }) {
  const tl = useTaskLabels();
  const say = useSample();
  const live = usePreviewClock();
  const { statuses, selected, changes } = usePreview((state) => state.board);
  const tasks = SAMPLE_TASKS.map((task) =>
    kitTask(task, statuses[task.id] ?? task.status, say, live),
  );
  const open = SAMPLE_TASKS.find((task) => task.id === selected);
  const change = changes.findLast((item) => item.taskId === selected);
  return (
    <div className="@container">
      <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_18rem]">
        <AgentTasks
          heading={tl.labels.tasks}
          tasks={tasks}
          labels={tl.labels}
          filterLabels={tl.filters}
          expanded={selected ? [selected] : []}
          onExpandedChange={(next) => selectTask(next.find((id) => id !== selected) ?? null)}
          // A row action opens that task, so its simulated result is in view.
          onCancel={(task) => {
            selectTask(task.id);
            setTaskStatus(task.id, 'cancelled');
          }}
          onRetry={(task) => {
            selectTask(task.id);
            setTaskStatus(task.id, 'queued');
          }}
          onOpenPullRequest={(task) => {
            const number = SAMPLE_TASKS.find((item) => item.id === task.id)?.pullRequest;
            if (number !== undefined) onOpenPull(number);
          }}
        />
        {open ? (
          <TaskDetail
            task={open}
            status={statuses[open.id] ?? open.status}
            moved={change ? tl.status(change.to) : null}
          />
        ) : (
          <NoTask />
        )}
      </div>
    </div>
  );
}

function NoTask() {
  const t = useTranslations('FeaturePreview.board');
  return <EmptyState title={t('none')} />;
}

function TaskDetail({
  task,
  status,
  moved,
}: {
  task: SampleTask;
  status: AgentTaskStatus;
  moved: string | null;
}) {
  const t = useTranslations('FeaturePreview.board');
  const tl = useTaskLabels();
  const say = useSample();
  const runName = useRunName();
  const heading = useId();
  const shape = useShape();
  return (
    <section
      aria-labelledby={heading}
      className={cn('grid gap-4 border border-border p-4', shape.container)}
    >
      <div className="grid gap-1">
        <span className="text-caption text-muted-foreground">{t('detail')}</span>
        <h2
          id={heading}
          className="m-0 text-subtitle text-foreground [overflow-wrap:anywhere]"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {say(task.title)}
        </h2>
      </div>
      <dl className="m-0 grid gap-3 text-body">
        <div className="grid gap-0.5">
          <dt className="text-caption text-muted-foreground">{t('session')}</dt>
          <dd className="m-0 flex min-w-0 items-center gap-1.5 text-foreground">
            <MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {task.linked ? runName(task.linked) : t('noSession')}
            </span>
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-caption text-muted-foreground">{t('branch')}</dt>
          <dd className="m-0 flex min-w-0 items-center gap-1.5 text-foreground">
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 font-mono text-caption [overflow-wrap:anywhere]">
              {task.branch}
            </code>
          </dd>
        </div>
      </dl>
      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-caption text-muted-foreground">{t('status')}</legend>
        <div className="flex flex-wrap gap-1">
          {STATUS_CHOICES.map((choice) => (
            <Button
              key={choice}
              size="compact"
              variant={status === choice ? 'secondary' : 'ghost'}
              aria-pressed={status === choice}
              onClick={() => setTaskStatus(task.id, choice)}
            >
              {tl.status(choice)}
            </Button>
          ))}
        </div>
      </fieldset>
      {moved ? <SimulatedResult>{t('moved', { status: moved })}</SimulatedResult> : null}
    </section>
  );
}
