'use client';

// Background agent jobs: a composer that starts one (prompt, repository,
// branch, model), a segmented status filter with counts, compact task rows
// (title, live duration, repo / branch / model, state, diff stats, actions)
// and an expandable body with the steps and changed files. Tasks and every
// action come in as props; running clocks derive from `startedAt` via
// useNow(), so the component never advances a run by itself.

import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useControllable } from '../../hooks/use-controllable.ts';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { useNow } from '../../hooks/use-now.ts';
import { formatDuration } from '../../lib/agent-format.ts';
import { Elevated } from '../../lib/elevated.tsx';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { type IconComponentProps, useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring, tween } from '../../lib/springs.ts';
import { assignRef, cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { DropdownContent, DropdownMenu, DropdownTrigger } from '../ui/dropdown.tsx';
import { FluidHoverHighlight } from '../ui/fluid-hover-highlight.tsx';
import { InputMessage } from '../ui/input-message.tsx';
import { MenuItem } from '../ui/menu-item.tsx';
import { TabItem, TabPanel, Tabs, TabsList } from '../ui/tabs.tsx';
import { Tooltip } from '../ui/tooltip.tsx';
import {
  AgentCard,
  type AgentMark,
  AgentStatusIcon,
  Collapse,
  DisclosureChevron,
  Keycap,
  Meter,
  Roll,
  resolveMark,
  SizeScope,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Where a background task is. `ready` = finished and waiting for review. */
type AgentTaskStatus = 'queued' | 'running' | 'ready' | 'merged' | 'failed' | 'cancelled';

/** A step in the task's log. */
type AgentTaskStepState = 'done' | 'active' | 'failed';

interface AgentTaskStep {
  /** Stable key. Omitted, the step's position is used. */
  id?: string;
  /** What the agent did (`Ran pnpm test, 148 passed`). */
  text: string;
  state: AgentTaskStepState;
  /** How long the step took, in ms. */
  durationMs?: number;
  /** Active steps: when the step began (ms epoch); shows a live elapsed time instead of `durationMs`. */
  startedAt?: number;
  /** Detail under the step, in mono (a failing assertion, an error line). */
  note?: string;
}

/** How a file changed. */
type AgentTaskFileChange = 'added' | 'modified' | 'deleted' | 'renamed';

interface AgentTaskFile {
  /** Repository-relative path (`src/checkout/payment.test.ts`); the folder part is dimmed. */
  path: string;
  change: AgentTaskFileChange;
  additions: number;
  deletions: number;
}

interface AgentTaskPullRequest {
  number: number;
  /** Word after the number (`PR #479 open`). Omit once merged. */
  state?: 'open' | 'draft' | 'closed';
  /** Link target. Without it the PR button calls `onOpenPullRequest`. */
  href?: string;
}

interface AgentTask {
  id: string;
  /** The prompt or a short title (`Fix the flaky checkout test in CI`). */
  title: string;
  status: AgentTaskStatus;
  /** Repository (`arc-ui/web`). */
  repo: string;
  /** Mark before the repository. Default `github`. */
  repoLogo?: AgentMark;
  /** Working branch (`fix/flaky-checkout-test`), shown in mono. */
  branch: string;
  /** Model label (`Opus 5.5`). */
  model: string;
  /** Mark before the model (`claude`). */
  modelLogo?: AgentMark;
  /** When the run started (ms epoch). Running tasks show a live clock from it. */
  startedAt?: number;
  /** Finished tasks: total run time in ms. */
  durationMs?: number;
  /** Running tasks: what the agent is doing now. Omitted, the active step's text. */
  activity?: string;
  /** Failed tasks: one-line reason beside the status (`2 of 148 tests failed`). */
  error?: string;
  /** Diff stats. Shown when `additions` or `deletions` is set. */
  additions?: number;
  deletions?: number;
  /** Number of files changed, beside the diff stats. */
  filesChanged?: number;
  /** CI result, shown with a shield. */
  checks?: 'passed' | 'failed';
  /** The task's pull request, once opened. */
  pullRequest?: AgentTaskPullRequest;
  /** True while a pull request is being opened: the create button shows its spinner. */
  pullRequestPending?: boolean;
  /** Step log, oldest first. */
  steps?: AgentTaskStep[];
  /** Changed files for the expanded body. */
  files?: AgentTaskFile[];
}

/** A repository the composer can target. */
interface AgentTaskRepo {
  name: string;
  branches: string[];
  /** Picked when the repository is chosen. Default: the first branch. */
  defaultBranch?: string;
  /** Mark on the chip. Default `github`. */
  logo?: AgentMark;
}

/** A model the composer can pick. */
interface AgentTaskModel {
  id: string;
  /** Short label on the chip (`Opus 5.5`). */
  label: string;
  /** Longer label in the menu (`Claude Opus 5.5`). Default `label`. */
  menuLabel?: string;
  logo?: AgentMark;
}

/** What the composer submits. `repo`, `branch` and `model` are names / ids from the options. */
interface AgentTaskDraft {
  prompt: string;
  repo: string;
  branch: string;
  model: string;
}

/** The status filter. `review` = ready for review. */
type AgentTasksFilter = 'all' | 'running' | 'review' | 'merged';

interface AgentTasksProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Every task, newest first. The filter narrows what is shown. */
  tasks: AgentTask[];
  /** Accessible heading for the region. Default `Agent tasks`. */
  heading?: string;
  /** Start a task from the composer. Return the new task's id to expand it. Omit to hide the composer. */
  // biome-ignore lint/suspicious/noConfusingVoidType: a host may return nothing; `void` keeps such callbacks assignable.
  onStart?: (draft: AgentTaskDraft) => string | void;
  /** Repositories in the composer's repo menu; the first is preselected. */
  repos?: AgentTaskRepo[];
  /** Models in the composer's model menu; the first is preselected. */
  models?: AgentTaskModel[];
  /** Composer placeholder. Default `Describe a task`. */
  placeholder?: string;
  /** Controlled filter. */
  filter?: AgentTasksFilter;
  /** Uncontrolled initial filter. Default `all`. */
  defaultFilter?: AgentTasksFilter;
  onFilterChange?: (filter: AgentTasksFilter) => void;
  /** Filter tab labels. */
  filterLabels?: Partial<Record<AgentTasksFilter, string>>;
  /** Controlled ids of expanded tasks. */
  expanded?: string[];
  /** Uncontrolled initially expanded ids. */
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  /** Cancel a queued or running task. */
  onCancel?: (task: AgentTask) => void;
  /** Run a failed or cancelled task again (the row expands). */
  onRetry?: (task: AgentTask) => void;
  /** Open a pull request for a task that is ready for review. */
  onCreatePullRequest?: (task: AgentTask) => void;
  /** Open a task's pull request (when it has no `href`). */
  onOpenPullRequest?: (task: AgentTask) => void;
  /** Archive a task. With `onRestore`, an undo bar follows. */
  onArchive?: (task: AgentTask) => void;
  /** Put an archived task back at `index` (its position in `tasks` when archived). */
  onRestore?: (task: AgentTask, index: number) => void;
  /** How long the undo bar stays, in ms. Default 6000. */
  undoMs?: number;
  /** Density step for the tasks and everything inside them. Omitted, follows the nearest `SizeProvider`. */
  size?: SizeVariant;
  /** Localized text, names and announcements; the source English is the default.
   *  Filter tab names stay in `filterLabels`. */
  labels?: Partial<AgentTasksLabels>;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

interface AgentTasksLabels {
  /** Accessible name of the filter tabs. */
  filterTasks: string;
  /** Accessible name of a filter tab. */
  filterCount: (filter: string, count: number) => string;
  /** Shown when the filter matches nothing; `startHint` while Running is empty and a task can start. */
  empty: (startHint: boolean) => string;
  /** Accessible name of the task list. */
  tasks: string;
  status: Record<AgentTaskStatus, string>;
  change: Record<AgentTaskFileChange, string>;
  checks: Record<'passed' | 'failed', string>;
  files: (count: number) => string;
  /** Spoken diff stats of a task. */
  lineStats: (additions: number, deletions: number) => string;
  /** Spoken diff stats of a file. */
  fileStats: (additions: number, deletions: number) => string;
  startTask: string;
  describeTask: string;
  /** Spoken before the composer chips' values. */
  repository: string;
  branch: string;
  model: string;
  /** The composer's send key cap. */
  sendKey: string;
  cancel: string;
  retry: string;
  createPullRequest: string;
  openingPullRequest: string;
  /** Accessible name of the pull request button. */
  pullRequest: (number: number, state?: AgentTaskPullRequest['state']) => string;
  /** Visible pull request button text. */
  pullRequestShort: (number: number, state?: AgentTaskPullRequest['state']) => string;
  archive: string;
  archiveTask: (title: string) => string;
  steps: string;
  noSteps: string;
  changedFiles: string;
  noFiles: string;
  stepFailed: string;
  stepActive: string;
  /** The undo bar after an archive. */
  archivedBar: (title: string) => string;
  undo: string;
  started: (title: string) => string;
  ready: (title: string) => string;
  failed: (title: string, error?: string) => string;
  cancelled: (title: string) => string;
  merged: (title: string) => string;
  pullRequestOpened: (number: number) => string;
  archived: (title: string) => string;
  restored: (title: string) => string;
}

const defaultLabels: AgentTasksLabels = {
  filterTasks: 'Filter tasks',
  filterCount: (filter, n) => `${filter}, ${plural(n, 'task')}`,
  empty: (startHint) =>
    `Nothing in this view. ${startHint ? 'Start a task to watch it run.' : 'Try another filter.'}`,
  tasks: 'Tasks',
  status: {
    queued: 'Queued',
    running: 'Running',
    ready: 'Ready for review',
    merged: 'Merged',
    failed: 'Failed',
    cancelled: 'Cancelled',
  },
  change: {
    added: 'Added',
    modified: 'Modified',
    deleted: 'Deleted',
    renamed: 'Renamed',
  },
  checks: { passed: 'Checks passed', failed: 'Checks failed' },
  files: (n) => plural(n, 'file'),
  lineStats: (a, del) => `${plural(a, 'line')} added, ${plural(del, 'line')} removed`,
  fileStats: (a, del) => `${a} added, ${del} removed`,
  startTask: 'Start task',
  describeTask: 'Describe a task',
  repository: 'Repository: ',
  branch: 'Branch: ',
  model: 'Model: ',
  sendKey: 'Enter',
  cancel: 'Cancel',
  retry: 'Retry',
  createPullRequest: 'Create pull request',
  openingPullRequest: 'Opening pull request',
  pullRequest: (n, state) => `Pull request ${n}${state ? `, ${state}` : ''}`,
  pullRequestShort: (n, state) => `PR #${n}${state ? ` ${state}` : ''}`,
  archive: 'Archive',
  archiveTask: (title) => `Archive ${title}`,
  steps: 'Steps',
  noSteps: 'Waiting for the agent to start.',
  changedFiles: 'Changed files',
  noFiles: 'No files changed yet.',
  stepFailed: ' (failed)',
  stepActive: ' (in progress)',
  archivedBar: (title) => `Archived “${title}”`,
  undo: 'Undo',
  started: (title) => `${title} started.`,
  ready: (title) => `${title} is ready for review.`,
  failed: (title, error) => `${title} failed${error ? `: ${error}` : ''}.`,
  cancelled: (title) => `Cancelled ${title}.`,
  merged: (title) => `${title} was merged.`,
  pullRequestOpened: (n) => `Pull request ${n} opened.`,
  archived: (title) => `Archived ${title}.`,
  restored: (title) => `Restored ${title}.`,
};

const TasksLabelsContext = createContext<AgentTasksLabels>(defaultLabels);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FILTERS: AgentTasksFilter[] = ['all', 'running', 'review', 'merged'];

const defaultFilterLabels: Record<AgentTasksFilter, string> = {
  all: 'All',
  running: 'Running',
  review: 'Ready for review',
  merged: 'Merged',
};

const UNDO_FOCUS = '\u0000undo';

function isLive(task: AgentTask): boolean {
  return task.status === 'running' || task.status === 'queued';
}

function matches(task: AgentTask, filter: AgentTasksFilter): boolean {
  if (filter === 'running') return isLive(task);
  if (filter === 'review') return task.status === 'ready';
  if (filter === 'merged') return task.status === 'merged';
  return true;
}

function elapsedOf(task: AgentTask, now: number): number | undefined {
  if (isLive(task)) return task.startedAt !== undefined ? now - task.startedAt : undefined;
  return task.durationMs;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One sentence per meaningful change between two task lists, for the live region. */
function describeChanges(prev: AgentTask[], next: AgentTask[], labels: AgentTasksLabels): string {
  const before = new Map(prev.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const t of next) {
    const p = before.get(t.id);
    if (!p) {
      if (isLive(t)) out.push(labels.started(t.title));
      continue;
    }
    if (p.status !== t.status) {
      if (isLive(t) && !isLive(p)) out.push(labels.started(t.title));
      else if (t.status === 'ready') out.push(labels.ready(t.title));
      else if (t.status === 'failed') out.push(labels.failed(t.title, t.error));
      else if (t.status === 'cancelled') out.push(labels.cancelled(t.title));
      else if (t.status === 'merged') out.push(labels.merged(t.title));
    }
    if (t.pullRequest && !p.pullRequest) out.push(labels.pullRequestOpened(t.pullRequest.number));
  }
  return out.join(' ');
}

// Page-local glyphs: the icon map has no pull-request or merge slot yet.
function PullRequestGlyph({ size = 16, strokeWidth = 1.5, className }: IconComponentProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <circle cx="6.5" cy="5.5" r="2.1" />
      <circle cx="6.5" cy="18.5" r="2.1" />
      <path d="M6.5 7.6v8.8" />
      <circle cx="18" cy="18.5" r="2.1" />
      <path d="M18 16.4v-4.9a4 4 0 0 0-4-4H9.6" />
      <path d="m12 4.6-2.6 2.9 2.6 2.9" />
    </svg>
  );
}

function MergeGlyph({ size = 16, strokeWidth = 1.5, className }: IconComponentProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <circle cx="7" cy="5.6" r="2.1" />
      <circle cx="7" cy="18.4" r="2.1" />
      <circle cx="17.2" cy="12" r="2.1" />
      <path d="M7 7.7v8.6" />
      <path d="M9.1 6.2c2.8.5 5.4 1.9 5.9 4.4" />
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Background agent tasks: start one, filter by status, expand a row for its steps and files. */
const AgentTasks = forwardRef<HTMLDivElement, AgentTasksProps>(({ size, ...props }, ref) => (
  <SizeScope size={size}>
    <AgentTasksInner ref={ref} {...props} />
  </SizeScope>
));
AgentTasks.displayName = 'AgentTasks';

interface UndoState {
  task: AgentTask;
  index: number;
  /** When it was archived (ms epoch); the bar drains from here. */
  at: number;
}

const AgentTasksInner = forwardRef<HTMLDivElement, Omit<AgentTasksProps, 'size'>>(
  (
    {
      tasks,
      heading = 'Agent tasks',
      onStart,
      repos = [],
      models = [],
      placeholder = 'Describe a task',
      filter: filterProp,
      defaultFilter = 'all',
      onFilterChange,
      filterLabels,
      expanded: expandedProp,
      defaultExpanded = [],
      onExpandedChange,
      onCancel,
      onRetry,
      onCreatePullRequest,
      onOpenPullRequest,
      onArchive,
      onRestore,
      undoMs = 6000,
      labels: labelOverrides,
      className,
      ...props
    },
    ref,
  ) => {
    const uid = useId();
    const size = useSize();
    const icons = useIcons();
    const filterNames = { ...defaultFilterLabels, ...filterLabels };
    const labels = useMemo(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides]);

    const [filter, setFilterValue] = useControllable(filterProp, defaultFilter, onFilterChange);
    // Re-picking the current tab is not a change.
    const setFilter = (next: AgentTasksFilter) => {
      if (next !== filter) setFilterValue(next);
    };

    const [expanded, setExpanded] = useControllable(
      expandedProp,
      defaultExpanded,
      onExpandedChange,
    );
    const toggle = (id: string) =>
      setExpanded(expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id]);
    const expand = (id: string) => {
      if (!expanded.includes(id)) setExpanded([...expanded, id]);
    };

    const ticking = tasks.some(
      (t) =>
        isLive(t) &&
        (t.startedAt !== undefined ||
          !!t.steps?.some((s) => s.state === 'active' && s.startedAt !== undefined)),
    );
    const now = useNow(1000, ticking);

    const counts: Record<AgentTasksFilter, number> = {
      all: tasks.length,
      running: tasks.filter(isLive).length,
      review: tasks.filter((t) => t.status === 'ready').length,
      merged: tasks.filter((t) => t.status === 'merged').length,
    };
    const shown = tasks.filter((t) => matches(t, filter));

    // Announce status changes once per change (adjusted during render, not in an effect).
    const [prevTasks, setPrevTasks] = useState(tasks);
    const [announcement, setAnnouncement] = useState('');
    if (prevTasks !== tasks) {
      const message = describeChanges(prevTasks, tasks, labels);
      setPrevTasks(tasks);
      if (message) setAnnouncement(message);
    }

    const [undo, setUndo] = useState<UndoState | null>(null);

    // When an action swaps or removes the focused button, focus lands on the
    // row's toggle (or the undo button) instead of falling to the page.
    const rootRef = useRef<HTMLDivElement | null>(null);
    const toggles = useRef(new Map<string, HTMLButtonElement>());
    const undoButton = useRef<HTMLButtonElement>(null);
    const pendingFocus = useRef<string | null>(null);
    useEffect(() => {
      const target = pendingFocus.current;
      if (!target) return;
      const active = document.activeElement;
      if (active && active !== document.body) {
        // Focus is still on the acted button (a spinner) or moved elsewhere on purpose.
        if (!rootRef.current?.contains(active)) pendingFocus.current = null;
        return;
      }
      pendingFocus.current = null;
      if (target === UNDO_FOCUS) undoButton.current?.focus();
      else toggles.current.get(target)?.focus();
    });

    const act = {
      cancel: onCancel
        ? (task: AgentTask) => {
            pendingFocus.current = task.id;
            onCancel(task);
          }
        : undefined,
      retry: onRetry
        ? (task: AgentTask) => {
            pendingFocus.current = task.id;
            expand(task.id);
            onRetry(task);
          }
        : undefined,
      createPr: onCreatePullRequest
        ? (task: AgentTask) => {
            pendingFocus.current = task.id;
            onCreatePullRequest(task);
          }
        : undefined,
      openPr: onOpenPullRequest,
      archive: onArchive
        ? (task: AgentTask) => {
            const index = tasks.indexOf(task);
            if (onRestore) {
              setUndo({ task, index, at: Date.now() });
              pendingFocus.current = UNDO_FOCUS;
            }
            setAnnouncement(labels.archived(task.title));
            onArchive(task);
          }
        : undefined,
    };

    const restore = () => {
      if (!undo || !onRestore) return;
      pendingFocus.current = undo.task.id;
      setAnnouncement(labels.restored(undo.task.title));
      onRestore(undo.task, undo.index);
      setUndo(null);
    };

    const headingId = `${uid}-heading`;
    const Search = icons.search;

    return (
      <TasksLabelsContext.Provider value={labels}>
        <AgentCard
          ref={(el) => {
            rootRef.current = el;
            assignRef(ref, el);
          }}
          role="region"
          aria-labelledby={headingId}
          className={cn('@container grid gap-3 p-3', className)}
          {...props}
        >
          <h2 id={headingId} className="sr-only">
            {heading}
          </h2>

          {onStart && (
            <Composer
              repos={repos}
              models={models}
              placeholder={placeholder}
              onStart={(draft) => {
                const id = onStart(draft);
                setFilter('all');
                if (typeof id === 'string') expand(id);
              }}
            />
          )}

          <Tabs
            value={filter}
            onValueChange={(v) => setFilter(v as AgentTasksFilter)}
            className="grid min-w-0 gap-2"
          >
            <div className="max-w-full overflow-x-auto scrollbar-hide">
              <TabsList aria-label={labels.filterTasks}>
                {FILTERS.map((f) => (
                  <TabItem
                    key={f}
                    value={f}
                    label={`${filterNames[f]} ${counts[f]}`}
                    aria-label={labels.filterCount(filterNames[f], counts[f])}
                    className="tabular-nums"
                  />
                ))}
              </TabsList>
            </div>

            <TabPanel value={filter} tabIndex={-1}>
              <TaskList
                tasks={shown}
                expanded={expanded}
                now={now}
                onToggle={toggle}
                act={act}
                registerToggle={(id, el) => {
                  if (el) toggles.current.set(id, el);
                  else toggles.current.delete(id);
                }}
                idPrefix={uid}
              />

              {shown.length === 0 && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={tween.moderate}
                  className={cn(
                    size.type.body,
                    'flex flex-col items-center gap-2 px-3 pt-8 pb-7 text-center text-muted-foreground',
                  )}
                >
                  <Search size={18} strokeWidth={1.5} aria-hidden />
                  <span>{labels.empty(filter === 'running' && onStart !== undefined)}</span>
                </motion.p>
              )}

              <AnimatePresence mode="wait" initial={false}>
                {undo && (
                  <UndoBar
                    key={undo.at}
                    title={undo.task.title}
                    at={undo.at}
                    durationMs={undoMs}
                    buttonRef={undoButton}
                    onUndo={restore}
                    onExpire={() => setUndo((u) => (u && u.at === undo.at ? null : u))}
                  />
                )}
              </AnimatePresence>
            </TabPanel>
          </Tabs>

          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </AgentCard>
      </TasksLabelsContext.Provider>
    );
  },
);
AgentTasksInner.displayName = 'AgentTasksInner';

// ─── Composer ────────────────────────────────────────────────────────────────

function Composer({
  repos,
  models,
  placeholder,
  onStart,
}: {
  repos: AgentTaskRepo[];
  models: AgentTaskModel[];
  placeholder: string;
  onStart: (draft: AgentTaskDraft) => void;
}) {
  const size = useSize();
  const icons = useIcons();
  const [draft, setDraft] = useState('');
  const [repoName, setRepoName] = useState(repos[0]?.name ?? '');
  const repo = repos.find((r) => r.name === repoName) ?? repos[0];
  const [branch, setBranch] = useState(repo ? (repo.defaultBranch ?? repo.branches[0] ?? '') : '');
  const [modelId, setModelId] = useState(models[0]?.id ?? '');
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const Chevron = icons['chevron-down'];
  const labels = useContext(TasksLabelsContext);

  const start = (prompt: string) => {
    onStart({ prompt, repo: repo?.name ?? '', branch, model: model?.id ?? '' });
    setDraft('');
  };

  return (
    <InputMessage
      size={size.variant}
      value={draft}
      onValueChange={setDraft}
      onSend={(text) => start(text)}
      placeholder={placeholder}
      sendLabel={labels.startTask}
      minRows={2}
      maxRows={6}
      textareaProps={{ 'aria-label': labels.describeTask, spellCheck: false }}
      leftSlot={
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          {repo && (
            <DropdownMenu>
              <DropdownTrigger
                render={
                  <Button
                    variant="ghost"
                    size="compact"
                    leadingIcon={resolveMark(repo.logo ?? 'github')}
                    trailingIcon={Chevron}
                  >
                    <span className="sr-only">{labels.repository}</span>
                    {repo.name}
                  </Button>
                }
              />
              <DropdownContent checkedIndex={repos.indexOf(repo)}>
                {repos.map((r, i) => (
                  <MenuItem
                    key={r.name}
                    index={i}
                    label={r.name}
                    checked={r === repo}
                    onSelect={() => {
                      setRepoName(r.name);
                      setBranch(r.defaultBranch ?? r.branches[0] ?? '');
                    }}
                  />
                ))}
              </DropdownContent>
            </DropdownMenu>
          )}
          {repo && repo.branches.length > 0 && (
            <DropdownMenu>
              <DropdownTrigger
                render={
                  <Button
                    variant="ghost"
                    size="compact"
                    leadingIcon={icons['git-branch']}
                    trailingIcon={Chevron}
                  >
                    <span className="sr-only">{labels.branch}</span>
                    {branch}
                  </Button>
                }
              />
              <DropdownContent checkedIndex={repo.branches.indexOf(branch)}>
                {repo.branches.map((b, i) => (
                  <MenuItem
                    key={b}
                    index={i}
                    label={b}
                    checked={b === branch}
                    onSelect={() => setBranch(b)}
                  />
                ))}
              </DropdownContent>
            </DropdownMenu>
          )}
          {model && (
            <DropdownMenu>
              <DropdownTrigger
                render={
                  <Button
                    variant="ghost"
                    size="compact"
                    leadingIcon={resolveMark(model.logo)}
                    trailingIcon={Chevron}
                  >
                    <span className="sr-only">{labels.model}</span>
                    {model.label}
                  </Button>
                }
              />
              <DropdownContent checkedIndex={models.indexOf(model)}>
                {models.map((m, i) => (
                  <MenuItem
                    key={m.id}
                    index={i}
                    icon={resolveMark(m.logo)}
                    label={m.menuLabel ?? m.label}
                    checked={m === model}
                    onSelect={() => setModelId(m.id)}
                  />
                ))}
              </DropdownContent>
            </DropdownMenu>
          )}
        </div>
      }
      rightSlot={
        <span aria-hidden className="flex items-center @max-[520px]:hidden">
          <Keycap>{labels.sendKey}</Keycap>
        </span>
      }
    />
  );
}

// ─── List ────────────────────────────────────────────────────────────────────

interface RowActions {
  cancel?: (task: AgentTask) => void;
  retry?: (task: AgentTask) => void;
  createPr?: (task: AgentTask) => void;
  openPr?: (task: AgentTask) => void;
  archive?: (task: AgentTask) => void;
}

function TaskList({
  tasks,
  expanded,
  now,
  onToggle,
  act,
  registerToggle,
  idPrefix,
}: {
  tasks: AgentTask[];
  expanded: string[];
  now: number;
  onToggle: (id: string) => void;
  act: RowActions;
  registerToggle: (id: string, el: HTMLButtonElement | null) => void;
  idPrefix: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(containerRef);
  const shape = useShape();
  const labels = useContext(TasksLabelsContext);
  return (
    <div ref={containerRef} className="relative" {...hover.handlers}>
      <FluidHoverHighlight hover={hover} className={shape.bg} />
      <ul className="grid" aria-label={labels.tasks}>
        <AnimatePresence initial={false} mode="popLayout">
          {tasks.map((task, i) => (
            <TaskRow
              key={task.id}
              task={task}
              index={i}
              register={hover.registerItem}
              clearHover={() => hover.setActiveIndex(null)}
              open={expanded.includes(task.id)}
              now={now}
              onToggle={() => onToggle(task.id)}
              act={act}
              toggleRef={(el) => registerToggle(task.id, el)}
              bodyId={`${idPrefix}-${task.id}-body`}
            />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

interface TaskRowProps {
  task: AgentTask;
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  clearHover: () => void;
  open: boolean;
  now: number;
  onToggle: () => void;
  act: RowActions;
  toggleRef: (el: HTMLButtonElement | null) => void;
  bodyId: string;
}

const TaskRow = forwardRef<HTMLLIElement, TaskRowProps>(
  ({ task, index, register, clearHover, open, now, onToggle, act, toggleRef, bodyId }, ref) => {
    const size = useSize();
    const shape = useShape();
    const icons = useIcons();
    const labels = useContext(TasksLabelsContext);
    const summaryRef = useRef<HTMLDivElement>(null);
    useRegisterFluidHoverItem(register, index, summaryRef);

    const Branch = icons['git-branch'];
    const RepoMark = resolveMark(task.repoLogo ?? 'github');
    const ModelMark = resolveMark(task.modelLogo);
    const elapsed = elapsedOf(task, now);
    const markSize = size.variant === 'compact' ? 12 : 13;

    return (
      <motion.li
        ref={ref}
        layout="position"
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: spring.moderate.exit }}
        transition={spring.moderate}
        data-status={task.status}
        data-open={open || undefined}
        className="relative not-first:before:absolute not-first:before:inset-x-2.5 not-first:before:top-0 not-first:before:h-px not-first:before:bg-border"
      >
        {/* The summary is the hover row; a click anywhere on it (outside a control) toggles. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the title button toggles from the keyboard. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the title button inside is the keyboard path. */}
        <div
          ref={summaryRef}
          data-fluid-hover-index={index}
          className="relative z-10 my-1 grid cursor-pointer gap-1.5 px-2.5 py-2.5"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, a')) return;
            onToggle();
          }}
        >
          <h3 className="flex min-w-0">
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={onToggle}
              className={cn(
                'group flex w-full min-w-0 items-start gap-3 text-left',
                focusRing,
                shape.item,
              )}
            >
              <span
                className={cn(
                  size.type.subtitle,
                  'min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]',
                )}
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {task.title}
              </span>
              <span
                className={cn(
                  size.type.caption,
                  'flex shrink-0 items-center gap-1.5 pt-px whitespace-nowrap text-muted-foreground tabular-nums',
                )}
              >
                {elapsed !== undefined && <span>{formatDuration(elapsed)}</span>}
                <DisclosureChevron
                  open={open}
                  className="text-current transition-colors duration-80 group-hover:text-foreground"
                />
              </span>
            </button>
          </h3>

          <div
            className={cn(
              size.type.caption,
              'flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground',
            )}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {RepoMark && <RepoMark size={markSize} />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{task.repo}</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Branch size={markSize} strokeWidth={1.5} aria-hidden />
              <code className="min-w-0 font-mono [overflow-wrap:anywhere]">{task.branch}</code>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {ModelMark && <ModelMark size={markSize} />}
              <span className="min-w-0">{task.model}</span>
            </span>
          </div>

          <div className="flex min-h-7 flex-wrap items-center gap-x-3.5 gap-y-2">
            <span className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1">
              <StatusWord task={task} />
              {task.status === 'failed' ? (
                task.error && (
                  <span
                    className={cn(
                      size.type.caption,
                      'min-w-0 text-muted-foreground [overflow-wrap:anywhere]',
                    )}
                  >
                    {task.error}
                  </span>
                )
              ) : (
                <AnimatePresence initial={false}>
                  {(task.additions !== undefined || task.deletions !== undefined) && (
                    <motion.span
                      key="stats"
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, transition: spring.fast.exit }}
                      transition={spring.moderate}
                      className="inline-flex items-center gap-3.5"
                    >
                      <DiffStats additions={task.additions ?? 0} deletions={task.deletions ?? 0} />
                      {task.filesChanged !== undefined && (
                        <span
                          className={cn(
                            size.type.caption,
                            'whitespace-nowrap text-muted-foreground tabular-nums',
                          )}
                        >
                          {labels.files(task.filesChanged)}
                        </span>
                      )}
                    </motion.span>
                  )}
                </AnimatePresence>
              )}
              {task.checks && <Checks result={task.checks} />}
            </span>
            <RowButtons task={task} act={act} />
          </div>
        </div>

        <Collapse open={open} id={bodyId} lift>
          {/* Hovering the body clears the row highlight instead of snapping it to the nearest row. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer tracking only clears the row highlight. */}
          <div
            className="px-2.5 pt-0.5 pb-3"
            onMouseMove={(e) => {
              e.stopPropagation();
              clearHover();
            }}
          >
            <TaskBody task={task} now={now} />
          </div>
        </Collapse>
      </motion.li>
    );
  },
);
TaskRow.displayName = 'TaskRow';

function StatusWord({ task }: { task: AgentTask }) {
  const size = useSize();
  const labels = useContext(TasksLabelsContext);
  const iconPx = size.variant === 'compact' ? 13 : 15;
  const activeStep = task.steps?.findLast((s) => s.state === 'active');
  const running = task.status === 'running';

  let label: string;
  let glyph: ReactNode;
  switch (task.status) {
    case 'queued':
      label = labels.status.queued;
      glyph = (
        <span className="pulse-soft flex">
          <AgentStatusIcon status="queued" size={iconPx} />
        </span>
      );
      break;
    case 'running':
      label = task.activity ?? activeStep?.text ?? labels.status.running;
      glyph = <AgentStatusIcon status="running" size={iconPx} />;
      break;
    case 'ready':
      label = labels.status.ready;
      glyph = <AgentStatusIcon status="done" size={iconPx} />;
      break;
    case 'merged':
      label = labels.status.merged;
      glyph = (
        <MergeGlyph size={iconPx} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
      );
      break;
    case 'failed':
      label = labels.status.failed;
      glyph = <AgentStatusIcon status="failed" size={iconPx} />;
      break;
    case 'cancelled':
      label = labels.status.cancelled;
      glyph = <AgentStatusIcon status="stopped" size={iconPx} />;
      break;
  }

  // The glyph swaps on a status change; the label crossfades on every new step
  // without restarting the spinner.
  return (
    <span
      className={cn(
        size.type.body,
        'relative inline-flex min-w-0 items-center gap-1.5 text-muted-foreground',
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={task.status}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
          transition={spring.fast}
          className="flex shrink-0"
        >
          {glyph}
        </motion.span>
      </AnimatePresence>
      <Roll
        id={`${task.status}:${label}`}
        innerClassName={cn('[overflow-wrap:anywhere]', running && 'shimmer-text')}
      >
        {label}
      </Roll>
    </span>
  );
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  const size = useSize();
  const labels = useContext(TasksLabelsContext);
  return (
    <span
      className={cn(
        size.type.caption,
        'inline-flex items-center gap-2 whitespace-nowrap tabular-nums',
      )}
    >
      <span className="sr-only">{labels.lineStats(additions, deletions)}</span>
      <span aria-hidden style={{ color: additions ? 'var(--success)' : 'var(--muted-foreground)' }}>
        +{additions}
      </span>
      <span
        aria-hidden
        style={{ color: deletions ? 'var(--destructive)' : 'var(--muted-foreground)' }}
      >
        −{deletions}
      </span>
      {(additions > 0 || deletions > 0) && (
        // Grows in from the left when the stats first appear (a run finishing).
        <motion.span
          aria-hidden
          className="inline-flex h-1 w-8 shrink-0 origin-left gap-0.5"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={spring.slow}
        >
          {additions > 0 && (
            <span
              className="h-full min-w-[3px] rounded-full"
              style={{ flex: `${additions} 1 0`, backgroundColor: 'var(--success)' }}
            />
          )}
          {deletions > 0 && (
            <span
              className="h-full min-w-[3px] rounded-full"
              style={{ flex: `${deletions} 1 0`, backgroundColor: 'var(--destructive)' }}
            />
          )}
        </motion.span>
      )}
    </span>
  );
}

function Checks({ result }: { result: 'passed' | 'failed' }) {
  const size = useSize();
  const labels = useContext(TasksLabelsContext);
  const icons = useIcons();
  const Shield = icons.shield;
  return (
    <span
      className={cn(
        size.type.caption,
        'inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground',
      )}
    >
      <span
        className="flex"
        style={{ color: result === 'passed' ? 'var(--success)' : 'var(--destructive)' }}
      >
        <Shield size={14} strokeWidth={1.5} aria-hidden />
      </span>
      {labels.checks[result]}
    </span>
  );
}

function RowButtons({ task, act }: { task: AgentTask; act: RowActions }) {
  const icons = useIcons();
  const labels = useContext(TasksLabelsContext);
  const Trash = icons.trash;
  const pr = task.pullRequest;
  const GitHub = resolveMark('github');
  return (
    <span className="ml-auto flex items-center gap-1">
      {isLive(task) && act.cancel && (
        <Button
          variant="tertiary"
          size="compact"
          leadingIcon={icons.stop}
          onClick={() => act.cancel?.(task)}
        >
          {labels.cancel}
        </Button>
      )}
      {(task.status === 'failed' || task.status === 'cancelled') && act.retry && (
        <Button
          variant="tertiary"
          size="compact"
          leadingIcon={icons['rotate-ccw']}
          onClick={() => act.retry?.(task)}
        >
          {labels.retry}
        </Button>
      )}
      {task.status === 'ready' && !pr && act.createPr && (
        <Button
          variant="primary"
          size="compact"
          leadingIcon={PullRequestGlyph}
          loading={task.pullRequestPending}
          disabled={task.pullRequestPending}
          aria-label={task.pullRequestPending ? labels.openingPullRequest : undefined}
          onClick={() => act.createPr?.(task)}
        >
          {labels.createPullRequest}
        </Button>
      )}
      {pr && (pr.href || act.openPr) && (
        <Button
          variant="ghost"
          size="compact"
          leadingIcon={GitHub}
          aria-label={labels.pullRequest(pr.number, pr.state)}
          // biome-ignore lint/a11y/useAnchorContent: Button renders its label into the anchor.
          render={pr.href ? <a href={pr.href} target="_blank" rel="noreferrer" /> : undefined}
          onClick={pr.href ? undefined : () => act.openPr?.(task)}
          className="tabular-nums text-foreground"
        >
          {labels.pullRequestShort(pr.number, pr.state)}
        </Button>
      )}
      {act.archive && (
        <Tooltip content={labels.archive}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={labels.archiveTask(task.title)}
            onClick={() => act.archive?.(task)}
            className="hover:text-destructive"
          >
            <Trash />
          </Button>
        </Tooltip>
      )}
    </span>
  );
}

// ─── Body ────────────────────────────────────────────────────────────────────

function TaskBody({ task, now }: { task: AgentTask; now: number }) {
  const size = useSize();
  const labels = useContext(TasksLabelsContext);
  const shape = useShape();
  const steps = task.steps ?? [];
  const files = task.files ?? [];
  return (
    <Elevated
      offset={1}
      className={cn(
        'grid grid-cols-1 items-start gap-4 p-3.5 @min-[560px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @min-[560px]:gap-x-6',
        shape.bg,
      )}
    >
      <section className="min-w-0">
        <SectionTitle>{labels.steps}</SectionTitle>
        <ol className="grid gap-1.5">
          <AnimatePresence initial={false}>
            {steps.map((step, i) => (
              <StepRow key={step.id ?? i} step={step} now={now} />
            ))}
          </AnimatePresence>
          {steps.length === 0 && (
            <li className={cn(size.type.body, 'text-muted-foreground')}>{labels.noSteps}</li>
          )}
        </ol>
      </section>
      <section className="min-w-0">
        <SectionTitle count={files.length}>{labels.changedFiles}</SectionTitle>
        <ul className="grid gap-1.5">
          {files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
          {files.length === 0 && (
            <li className={cn(size.type.caption, 'text-muted-foreground')}>{labels.noFiles}</li>
          )}
        </ul>
      </section>
    </Elevated>
  );
}

function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  const size = useSize();
  return (
    <h4
      className={cn(size.type.caption, 'mb-2 flex items-center gap-1.5 text-muted-foreground')}
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {children}
      {count !== undefined && (
        <span className="tabular-nums" style={{ fontVariationSettings: fontWeights.normal }}>
          {count}
        </span>
      )}
    </h4>
  );
}

function StepRow({ step, now }: { step: AgentTaskStep; now: number }) {
  const size = useSize();
  const labels = useContext(TasksLabelsContext);
  const icons = useIcons();
  const X = icons.x;
  const iconPx = size.variant === 'compact' ? 12 : 13;
  const ms =
    step.state === 'active' && step.startedAt !== undefined
      ? now - step.startedAt
      : step.durationMs;
  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.moderate}
      data-state={step.state}
      className={cn(
        size.type.body,
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2',
      )}
    >
      <span className="relative flex h-[1lh] items-center self-start">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={step.state}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
            transition={spring.fast}
            className="flex"
          >
            {step.state === 'done' && <AgentStatusIcon status="done" size={iconPx} />}
            {step.state === 'active' && <AgentStatusIcon status="running" size={iconPx} />}
            {step.state === 'failed' && (
              <span className="flex" style={{ color: 'var(--destructive)' }}>
                <X size={iconPx} strokeWidth={2.2} aria-hidden />
              </span>
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">
        {step.text}
        {step.state === 'failed' && <span className="sr-only">{labels.stepFailed}</span>}
        {step.state === 'active' && <span className="sr-only">{labels.stepActive}</span>}
      </span>
      <span className={cn(size.type.caption, 'text-muted-foreground tabular-nums')}>
        {ms !== undefined ? formatDuration(ms) : ''}
      </span>
      {step.note && (
        <p
          className={cn(
            size.type.caption,
            'col-span-2 col-start-2 mt-0.5 font-mono text-muted-foreground [overflow-wrap:anywhere]',
          )}
        >
          {step.note}
        </p>
      )}
    </motion.li>
  );
}

function FileRow({ file }: { file: AgentTaskFile }) {
  const size = useSize();
  const labels = useContext(TasksLabelsContext);
  const slash = file.path.lastIndexOf('/');
  const dir = file.path.slice(0, slash + 1);
  const name = file.path.slice(slash + 1);
  return (
    <li
      className={cn(
        size.type.caption,
        'grid grid-cols-[60px_minmax(0,1fr)_auto] items-baseline gap-x-2',
      )}
    >
      <span className="text-muted-foreground">{labels.change[file.change]}</span>
      <span className="truncate font-mono text-foreground" title={file.path}>
        <span className="text-muted-foreground">{dir}</span>
        {name}
      </span>
      <span className="flex gap-1.5 tabular-nums">
        <span className="sr-only">{labels.fileStats(file.additions, file.deletions)}</span>
        <span
          aria-hidden
          style={{ color: file.additions ? 'var(--success)' : 'var(--muted-foreground)' }}
        >
          +{file.additions}
        </span>
        <span
          aria-hidden
          style={{ color: file.deletions ? 'var(--destructive)' : 'var(--muted-foreground)' }}
        >
          −{file.deletions}
        </span>
      </span>
    </li>
  );
}

// ─── Undo ────────────────────────────────────────────────────────────────────

function UndoBar({
  title,
  at,
  durationMs,
  buttonRef,
  onUndo,
  onExpire,
}: {
  title: string;
  at: number;
  durationMs: number;
  buttonRef: Ref<HTMLButtonElement>;
  onUndo: () => void;
  onExpire: () => void;
}) {
  const size = useSize();
  const shape = useShape();
  const labels = useContext(TasksLabelsContext);
  const now = useNow(200);
  const left = Math.max(0, durationMs - (now - at));
  useEffect(() => {
    if (left <= 0) onExpire();
  }, [left, onExpire]);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6, transition: spring.moderate.exit }}
      transition={spring.moderate}
      className={cn(
        'relative mt-2 flex items-center justify-between gap-2.5 overflow-hidden border border-border py-1.5 pr-1.5 pl-3',
        shape.bg,
      )}
    >
      <span className={cn(size.type.body, 'min-w-0 truncate text-muted-foreground')}>
        {labels.archivedBar(title)}
      </span>
      <Button ref={buttonRef} variant="secondary" size="compact" onClick={onUndo}>
        {labels.undo}
      </Button>
      {/* Drains over the undo window. */}
      <Meter
        value={durationMs > 0 ? left / durationMs : 0}
        color="var(--muted-foreground)"
        className="absolute inset-x-0 bottom-0 h-0.5 rounded-none bg-transparent"
      />
    </motion.div>
  );
}

export type {
  AgentTask,
  AgentTaskDraft,
  AgentTaskFile,
  AgentTaskFileChange,
  AgentTaskModel,
  AgentTaskPullRequest,
  AgentTaskRepo,
  AgentTaskStatus,
  AgentTaskStep,
  AgentTaskStepState,
  AgentTasksFilter,
  AgentTasksLabels,
  AgentTasksProps,
};
export { AgentTasks };
