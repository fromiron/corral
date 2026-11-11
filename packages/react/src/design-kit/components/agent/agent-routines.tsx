'use client';

// Scheduled agent routines: a header with the live "n of m on schedule" count
// and a natural-language composer for new routines, then one row per routine
// with its schedule in words, a countdown to `nextRunAt`, the last run, the
// sources → destination → model chain, run-history ticks, Run now / Stop and a
// pause switch. A fold holds the live run, the latest report and a schedule
// editor. Routines, runs and callbacks come in as props; the countdown derives
// from `nextRunAt` through `useNow`, and turning a sentence into a draft is the
// caller's `parseDraft`.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
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
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring, tween } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { FluidHoverHighlight } from '../ui/fluid-hover-highlight.tsx';
import { InputField, InputGroup } from '../ui/input-group.tsx';
import { InputMessage } from '../ui/input-message.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select.tsx';
import { Switch } from '../ui/switch.tsx';
import { TabItem, Tabs, TabsList } from '../ui/tabs.tsx';
import { Tooltip } from '../ui/tooltip.tsx';
import {
  AgentCard,
  type AgentMark,
  AgentStatusIcon,
  Collapse,
  DisclosureChevron,
  LiveDot,
  MetaDot,
  Meter,
  Roll,
  RollNumber,
  resolveMark,
  SizeScope,
  ToolStack,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** How often a routine runs. */
type RoutineFrequency = 'hourly' | 'daily' | 'weekdays' | 'weekly';

interface RoutineSchedule {
  /** Cadence: every hour, every day, Monday–Friday, or one weekday. */
  frequency: RoutineFrequency;
  /** Time of day, 24-hour `HH:MM` (`09:00`). Hourly routines use only the minutes. */
  time: string;
  /** Weekday for `weekly`, 0 = Sunday … 6 = Saturday. Default 5 (Friday). */
  day?: number;
}

/** Outcome of one past run. `skipped` = the routine ran and found nothing to do. */
type RoutineRunStatus = 'success' | 'skipped' | 'failed';

interface RoutineRun {
  /** Stable key for the history tick; omitted, `at` is used. */
  id?: string;
  status: RoutineRunStatus;
  /** When the run happened (ms epoch). */
  at: number;
}

/** Something the routine reads (`Linear`, `Sentry`). */
interface RoutineSource {
  id: string;
  /** Visible and spoken name. */
  name: string;
  /** Brand mark (`"linear"`) or an icon component. Omitted, a database glyph. */
  logo?: AgentMark;
}

/** Where the routine posts its report. */
interface RoutineDestination {
  /** Short visible label (`#triage`, `DM`). */
  label: string;
  /** Spoken form for assistive tech (`Slack #triage`). Default `label`. */
  spoken?: string;
  /** Brand mark of the destination app (`"slack"`). */
  logo?: AgentMark;
}

/** The model a routine runs on. */
interface RoutineModel {
  /** `Claude Sonnet 5.5`; shown in the mark's tooltip and read out. */
  name: string;
  logo?: AgentMark;
}

/** A run in progress (started by Run now or the schedule). */
interface RoutineActiveRun {
  /** Index into the routine's `steps` of the step in progress. */
  step: number;
  /** 0–1. Omitted, `(step + 1) / steps.length`. */
  progress?: number;
}

interface AgentRoutine {
  id: string;
  /** Short scannable name (`Morning triage`). */
  name: string;
  /** What the routine does, in the user's words. Shown in the fold. */
  instruction?: string;
  schedule: RoutineSchedule;
  /** Apps the routine reads, in order. */
  sources: RoutineSource[];
  destination: RoutineDestination;
  model: RoutineModel;
  /** On schedule (true) or paused (false). */
  enabled: boolean;
  /** Next scheduled run (ms epoch). The countdown derives from it; ignored while paused. */
  nextRunAt?: number;
  /** Past runs, oldest first. The newest one is "Last run". */
  history: RoutineRun[];
  /** Step labels of one run (`Reading new Linear issues`, …). */
  steps?: string[];
  /**
   * Latest report as plain text: lines starting with `- ` become a list, and
   * issue keys (`ENG-2141`), PR numbers (`#1842`) and channels (`#eng`) are emphasized.
   */
  report?: string;
  /** Set while a run is in progress. */
  run?: RoutineActiveRun;
}

/** What a sentence in the composer parses to; previewed as chips before it is added. */
interface RoutineDraft {
  /** Suggested name; the caller may derive its own on create. */
  name?: string;
  schedule: RoutineSchedule;
  sources: RoutineSource[];
  destination: RoutineDestination;
}

interface AgentRoutinesProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Routines, in display order. */
  routines: AgentRoutine[];
  /** Heading. Default `Routines`. */
  title?: string;
  /** Controlled expanded routine (`null` = none). */
  openId?: string | null;
  /** Initially expanded routine when uncontrolled. */
  defaultOpenId?: string | null;
  /** Called with the routine to expand, or `null` to collapse. Also fires when a run starts. */
  onOpenChange?: (id: string | null) => void;
  /** The pause switch. Omit to hide it. */
  onEnabledChange?: (id: string, enabled: boolean) => void;
  /** Run now. Omit to hide Run now / Stop. */
  onRun?: (id: string) => void;
  /** Stop a run in progress. */
  onStop?: (id: string) => void;
  /** Save from the schedule editor. Omit to hide the editor. */
  onScheduleChange?: (id: string, schedule: RoutineSchedule) => void;
  /** Add a routine from the composer's sentence. Omit to hide "New routine". */
  onCreate?: (text: string, draft: RoutineDraft | null) => void;
  /** Turns the composer's sentence into a draft for the live chip preview (and `onCreate`). */
  parseDraft?: (text: string) => RoutineDraft | null;
  /** Controlled composer visibility. */
  creating?: boolean;
  /** Initial composer visibility when uncontrolled. */
  defaultCreating?: boolean;
  onCreatingChange?: (creating: boolean) => void;
  /** Composer placeholder. Default `Weekdays at 9, read Linear and Sentry, post to #triage`. */
  createPlaceholder?: string;
  /** An example sentence shown as the placeholder; Tab fills it in. */
  createSuggestion?: string;
  /** History ticks per row. Default 14. */
  historyLength?: number;
  /** Density step for the card and everything inside it. Omitted, follows the nearest `SizeProvider`. */
  size?: SizeVariant;
  /** Localized text, names and announcements; the source English is the default. */
  labels?: Partial<AgentRoutinesLabels>;
}

// ─── Schedule wording ────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

const FREQUENCIES: { value: RoutineFrequency; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
];

const RUN_LABEL: Record<RoutineRunStatus, string> = {
  success: 'Succeeded',
  skipped: 'Skipped',
  failed: 'Failed',
};

const TICK_COLOR: Record<RoutineRunStatus, string> = {
  success: 'color-mix(in srgb, var(--success) 55%, var(--background))',
  failed: 'color-mix(in srgb, var(--destructive) 70%, var(--background))',
  skipped: 'color-mix(in srgb, var(--muted-foreground) 30%, var(--background))',
};

/** Clock text the way a person writes it: `9:00`, `16:00`, `8:30`. */
function clockText(time: string): string {
  const [hh = '0', mm = '00'] = time.split(':');
  return `${Number(hh)}:${mm.padStart(2, '0')}`;
}

/** `Weekdays at 9:00`, `Fridays at 16:00`, `Every hour at :00`, `Every day at 7:30`. */
function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.frequency === 'hourly')
    return `Every hour at :${(schedule.time.split(':')[1] ?? '00').padStart(2, '0')}`;
  const at = clockText(schedule.time);
  if (schedule.frequency === 'daily') return `Every day at ${at}`;
  if (schedule.frequency === 'weekdays') return `Weekdays at ${at}`;
  return `${WEEKDAYS[schedule.day ?? 5]}s at ${at}`;
}

/** The phrase mid-sentence: weekday names keep their capital. */
function scheduleInSentence(schedule: RoutineSchedule): string {
  const text = describeSchedule(schedule);
  return schedule.frequency === 'weekly' ? text : (text[0] as string).toLowerCase() + text.slice(1);
}

function dayStart(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `today 6:00`, `yesterday 9:00`, `Fri 16 Oct, 16:00`. */
function runDayLabel(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const diff = Math.round((dayStart(now) - dayStart(at)) / DAY_MS);
  if (diff === 0) return `today ${hm}`;
  if (diff === 1) return `yesterday ${hm}`;
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${hm}`;
}

function sameSchedule(a: RoutineSchedule, b: RoutineSchedule): boolean {
  return (
    a.frequency === b.frequency &&
    a.time === b.time &&
    (a.frequency !== 'weekly' || (a.day ?? 5) === (b.day ?? 5))
  );
}

const semibold: CSSProperties = { fontVariationSettings: fontWeights.semibold };

// ─── Labels ──────────────────────────────────────────────────────────────────

interface AgentRoutinesLabels {
  /** Header line under the title; `count` is the rolling number. */
  scheduleSummary: (count: ReactNode, total: number) => ReactNode;
  newRoutine: string;
  /** Accessible name of the composer field. */
  describeRoutine: string;
  /** The composer's send action. */
  addRoutine: string;
  cancel: string;
  /** Shown without routines; `canCreate` when New routine is available. */
  empty: (canCreate: boolean) => string;
  /** A schedule in words (`Weekdays at 9:00`), on rows and draft chips. */
  schedule: (schedule: RoutineSchedule) => string;
  /** When a run happened (`today 6:00`, `Fri 16 Oct, 16:00`). */
  runDay: (at: number, now: number) => string;
  runStatus: Record<RoutineRunStatus, string>;
  frequency: Record<RoutineFrequency, string>;
  /** Weekday names, Sunday first, for the weekly day picker. */
  weekdays: readonly string[];
  runningNow: string;
  paused: string;
  scheduled: string;
  dueNow: string;
  nextRunIn: (ms: number) => string;
  stop: string;
  stopRoutine: (name: string) => string;
  runNow: string;
  runRoutine: (name: string) => string;
  /** Accessible name of the pause switch. */
  enabledSwitch: (name: string) => string;
  /** After the run status: `Last run today 9:00`. */
  lastRun: (day: string) => string;
  notRun: string;
  /** Spoken sources → destination → model chain. */
  chain: (sources: string[], destination: string, model: string) => string;
  noRunsYet: string;
  /** Spoken history: counts per status among the last `total` runs. */
  history: (
    counts: Partial<Record<RoutineRunStatus, number>>,
    total: number,
    newest: string,
  ) => string;
  latestReport: string;
  /** In the report box before any run. */
  noReport: string;
  /** Spoken after a finished step of the live run. */
  stepDone: string;
  /** Accessible name of the schedule editor. */
  scheduleFor: (name: string) => string;
  repeats: string;
  day: string;
  time: string;
  timeError: string;
  save: string;
  saved: string;
  /** Draft hint while the sentence is empty or does not parse yet. */
  draftHint: (hasText: boolean) => string;
  /** Spoken before the draft chips. */
  willCreate: string;
  finished: (name: string) => string;
  added: (name: string, onSchedule: number, total: number) => string;
  running: (name: string) => string;
  stopped: (name: string) => string;
  enabledChanged: (name: string, enabled: boolean, onSchedule: number, total: number) => string;
  rescheduled: (name: string, schedule: RoutineSchedule) => string;
}

const defaultLabels: AgentRoutinesLabels = {
  scheduleSummary: (count, total) => (
    <>
      {count} of {total} on schedule
    </>
  ),
  newRoutine: 'New routine',
  describeRoutine: 'Describe the routine',
  addRoutine: 'Add routine',
  cancel: 'Cancel',
  empty: (canCreate) => `No routines yet.${canCreate ? ' Describe one with New routine.' : ''}`,
  schedule: describeSchedule,
  runDay: runDayLabel,
  runStatus: RUN_LABEL,
  frequency: Object.fromEntries(FREQUENCIES.map((f) => [f.value, f.label])) as Record<
    RoutineFrequency,
    string
  >,
  weekdays: WEEKDAYS,
  runningNow: 'Running now',
  paused: 'Paused',
  scheduled: 'Scheduled',
  dueNow: 'Due now',
  nextRunIn: (ms) => `Next run in ${formatDuration(ms)}`,
  stop: 'Stop',
  stopRoutine: (name) => `Stop ${name}`,
  runNow: 'Run now',
  runRoutine: (name) => `Run ${name} now`,
  enabledSwitch: (name) => `${name} on schedule`,
  lastRun: (day) => `Last run ${day}`,
  notRun: 'Not run yet',
  chain: (sources, destination, model) =>
    `Reads ${sources.join(', ')}, posts to ${destination}, runs on ${model}.`,
  noRunsYet: 'No runs yet',
  history: (counts, total, newest) => {
    const summary = (['success', 'skipped', 'failed'] as const)
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${RUN_LABEL[s].toLowerCase()}`)
      .join(', ');
    return `Last ${total} runs: ${summary}. Most recent ${newest}.`;
  },
  latestReport: 'Latest report',
  noReport: 'No runs yet.',
  stepDone: ', done',
  scheduleFor: (name) => `Schedule for ${name}`,
  repeats: 'Repeats',
  day: 'Day',
  time: 'Time',
  timeError: 'Enter a time',
  save: 'Save',
  saved: 'Saved',
  draftHint: (hasText) =>
    hasText
      ? 'Keep going: a schedule, sources and a destination.'
      : 'Describe a schedule, sources and a destination.',
  willCreate: 'Will create: ',
  finished: (name) => `${name} finished.`,
  added: (name, count, total) => `Added ${name}. ${count} of ${total} on schedule.`,
  running: (name) => `Running ${name}.`,
  stopped: (name) => `Stopped ${name}.`,
  enabledChanged: (name, enabled, count, total) =>
    `${name} is ${enabled ? 'on schedule' : 'paused'}. ${count} of ${total} on schedule.`,
  rescheduled: (name, schedule) => `${name} now runs ${scheduleInSentence(schedule)}.`,
};

// ─── Small parts ─────────────────────────────────────────────────────────────

/** The thin live bar across the top of a running row, with a sheen: it fades
 *  in and its fill grows from empty to the run's progress. */
function RunBar({ progress }: { progress: number }) {
  const reduce = useReducedMotion() ?? false;
  // The first frame draws an empty fill, so the bar grows in instead of appearing at its value.
  const [entered, setEntered] = useState(reduce);
  useEffect(() => setEntered(true), []);
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-x-3 top-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: tween.moderate.exit }}
      transition={tween.moderate}
    >
      <Meter
        live
        value={entered ? progress : 0}
        color="var(--emphasis)"
        className="h-0.5 bg-accent"
      />
    </motion.div>
  );
}

/** Last-N run ticks: green succeeded, muted skipped, red failed. */
function HistoryTicks({
  runs,
  max,
  now,
  dim,
  labels,
}: {
  runs: RoutineRun[];
  max: number;
  now: number;
  dim: boolean;
  labels: AgentRoutinesLabels;
}) {
  const size = useSize();
  const shown = runs.slice(-max);
  if (shown.length === 0) {
    return (
      <span className={cn(size.type.caption, 'shrink-0 text-muted-foreground')}>
        {labels.noRunsYet}
      </span>
    );
  }
  const counts = shown.reduce<Partial<Record<RoutineRunStatus, number>>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const newest = shown[shown.length - 1] as RoutineRun;
  const label = labels.history(counts, shown.length, labels.runDay(newest.at, now));
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'flex h-5 shrink-0 items-center gap-[3px] transition-opacity duration-240',
        dim && 'opacity-50',
      )}
    >
      <AnimatePresence initial={false}>
        {shown.map((run, i) => (
          <Tooltip
            key={run.id ?? run.at}
            content={`${labels.runStatus[run.status]} · ${labels.runDay(run.at, now)}`}
          >
            <motion.span
              layout
              className={cn(
                'block h-3.5 w-1 origin-bottom rounded-[2px]',
                // Narrow cards keep the newest ten.
                i < shown.length - 10 && '@max-[470px]:hidden',
              )}
              style={{ backgroundColor: TICK_COLOR[run.status] }}
              initial={{ scaleY: 0, opacity: 0 }}
              animate={{ scaleY: 1, opacity: 1 }}
              exit={{ scaleY: 0, opacity: 0, transition: spring.fast.exit }}
              transition={spring.moderate}
            />
          </Tooltip>
        ))}
      </AnimatePresence>
    </span>
  );
}

/** Plain-text report → paragraphs and lists, with ids and channels emphasized. */
function Report({ text }: { text: string }) {
  const size = useSize();
  const rich = (line: string) =>
    line.split(/([A-Z][A-Z0-9]+-\d+|#\w+)/g).map((part, i) =>
      i % 2 === 1 ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: split parts of a static line may repeat and never reorder.
        <b key={i} className="text-foreground" style={semibold}>
          {part}
        </b>
      ) : (
        part
      ),
    );
  const blocks: ({ kind: 'p'; text: string } | { kind: 'ul'; items: string[] })[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'ul') last.items.push(line.slice(2));
      else blocks.push({ kind: 'ul', items: [line.slice(2)] });
    } else if (line.trim()) {
      blocks.push({ kind: 'p', text: line });
    }
  }
  return (
    <div className={cn(size.type.body, 'grid gap-1 text-muted-foreground')}>
      {blocks.map((b, i) =>
        b.kind === 'p' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: report blocks are static text that may repeat.
          <p key={i} className="m-0">
            {rich(b.text)}
          </p>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: report blocks are static text that may repeat.
          <ul key={i} className="m-0 grid list-disc gap-0.5 pl-4.5">
            {b.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: report items are static text that may repeat.
              <li key={j}>{rich(item)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** The live run inside the fold: current step with a spinner, then every step. */
function RunState({
  steps,
  step,
  labels,
}: {
  steps: string[];
  step: number;
  labels: AgentRoutinesLabels;
}) {
  const size = useSize();
  const icons = useIcons();
  const Check = icons.check;
  const current = steps[Math.min(step, steps.length - 1)];
  return (
    <motion.div
      className="grid gap-2"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: spring.moderate.exit }}
      transition={spring.moderate}
    >
      {current && (
        <p className={cn(size.type.body, 'm-0 flex min-w-0 items-center gap-2')} aria-live="polite">
          <AgentStatusIcon status="running" size={13} />
          <span className="shimmer-text truncate">{current}</span>
        </p>
      )}
      <ol className="m-0 grid gap-1 p-0">
        {steps.map((label, i) => {
          const state = i < step ? 'done' : i === step ? 'current' : 'pending';
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: step labels may repeat and keep their run order.
              key={i}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                size.type.body,
                'flex min-w-0 items-center gap-2 transition-colors duration-160',
                state === 'current' ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                {state === 'done' ? (
                  <motion.span
                    className="inline-grid"
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={spring.fast}
                    style={{ color: 'var(--success)' }}
                  >
                    <Check size={12} strokeWidth={2} />
                  </motion.span>
                ) : state === 'current' ? (
                  <LiveDot />
                ) : (
                  <span className="size-1 rounded-full bg-border" />
                )}
              </span>
              <span className="min-w-0 truncate">{label}</span>
              {state === 'done' && <span className="sr-only">{labels.stepDone}</span>}
            </li>
          );
        })}
      </ol>
    </motion.div>
  );
}

/** Frequency tabs, a weekday select for weekly, a time field, and Save. */
function ScheduleEditor({
  schedule,
  name,
  onSave,
  labels,
}: {
  schedule: RoutineSchedule;
  name: string;
  onSave: (schedule: RoutineSchedule) => void;
  labels: AgentRoutinesLabels;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<RoutineSchedule>(schedule);
  const [saved, setSaved] = useState(false);
  const scheduleKey = `${schedule.frequency}|${schedule.time}|${schedule.day ?? ''}`;
  // Re-seed the draft only when the saved schedule itself changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the schedule's value, not its identity, re-seeds the draft.
  useEffect(() => {
    setDraft(schedule);
  }, [scheduleKey]);

  const timeOk = /^\d{1,2}:\d{2}/.test(draft.time);
  const dirty = !sameSchedule(draft, schedule);
  const edit = (next: Partial<RoutineSchedule>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...next }));
  };

  return (
    <SizeProvider size="compact">
      <EditorBody
        uid={uid}
        name={name}
        labels={labels}
        draft={draft}
        dirty={dirty}
        saved={saved}
        timeOk={timeOk}
        onFrequency={(frequency) =>
          edit({ frequency, day: frequency === 'weekly' ? (draft.day ?? 5) : draft.day })
        }
        onDay={(day) => edit({ day })}
        onTime={(time) => edit({ time })}
        onSubmit={() => {
          if (!timeOk || !dirty) return;
          const next: RoutineSchedule = {
            frequency: draft.frequency,
            time: draft.time.slice(0, 5).padStart(5, '0'),
            ...(draft.frequency === 'weekly'
              ? { day: draft.day ?? 5 }
              : draft.day !== undefined
                ? { day: draft.day }
                : {}),
          };
          setSaved(true);
          onSave(next);
        }}
      />
    </SizeProvider>
  );
}

function EditorBody({
  uid,
  name,
  labels,
  draft,
  dirty,
  saved,
  timeOk,
  onFrequency,
  onDay,
  onTime,
  onSubmit,
}: {
  uid: string;
  name: string;
  labels: AgentRoutinesLabels;
  draft: RoutineSchedule;
  dirty: boolean;
  saved: boolean;
  timeOk: boolean;
  onFrequency: (f: RoutineFrequency) => void;
  onDay: (day: number) => void;
  onTime: (time: string) => void;
  onSubmit: () => void;
}) {
  const size = useSize();
  const icons = useIcons();
  const label = cn(size.type.body, 'text-muted-foreground');
  return (
    <form
      aria-label={labels.scheduleFor(name)}
      className="relative flex flex-wrap items-end gap-x-3 gap-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-1">
        <span id={`${uid}-freq`} className={label}>
          {labels.repeats}
        </span>
        <Tabs
          value={draft.frequency}
          onValueChange={(v) => onFrequency(v as RoutineFrequency)}
          aria-labelledby={`${uid}-freq`}
        >
          <TabsList>
            {FREQUENCIES.map((f) => (
              <TabItem key={f.value} value={f.value} label={labels.frequency[f.value]} />
            ))}
          </TabsList>
        </Tabs>
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        {draft.frequency === 'weekly' && (
          <motion.div
            key="day"
            className="grid gap-1"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: spring.fast.exit }}
            transition={spring.moderate}
          >
            <span id={`${uid}-day`} className={label}>
              {labels.day}
            </span>
            <Select value={String(draft.day ?? 5)} onValueChange={(v) => onDay(Number(v))}>
              <SelectTrigger aria-labelledby={`${uid}-day`} className="w-32" />
              <SelectContent>
                {labels.weekdays.map((d, i) => (
                  <SelectItem key={d} index={i} value={String(i)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </motion.div>
        )}
      </AnimatePresence>
      <InputGroup className="w-32 gap-1">
        <InputField
          index={0}
          label={labels.time}
          type="time"
          value={draft.time}
          onChange={onTime}
          error={timeOk ? undefined : labels.timeError}
          className="tabular-nums"
        />
      </InputGroup>
      <Button
        type="submit"
        variant="secondary"
        disabled={!dirty || !timeOk}
        leadingIcon={saved && !dirty ? icons.check : undefined}
      >
        {saved && !dirty ? labels.saved : labels.save}
      </Button>
    </form>
  );
}

/** The composer's live preview: what the sentence will create, as chips. */
function DraftChips({
  draft,
  hasText,
  labels,
}: {
  draft: RoutineDraft | null;
  hasText: boolean;
  labels: AgentRoutinesLabels;
}) {
  const size = useSize();
  const icons = useIcons();
  if (!draft) {
    return (
      <span className={cn(size.type.caption, 'truncate pl-1 text-muted-foreground')}>
        {labels.draftHint(hasText)}
      </span>
    );
  }
  const DestMark = resolveMark(draft.destination.logo);
  const chips: { key: string; icon?: ReactNode; label: string }[] = [
    {
      key: `when-${labels.schedule(draft.schedule)}`,
      icon: <icons.clock size={12} strokeWidth={1.5} />,
      label: labels.schedule(draft.schedule),
    },
    ...draft.sources.map((s) => {
      const Mark = resolveMark(s.logo) ?? icons.database;
      return { key: `src-${s.id}`, icon: <Mark size={12} />, label: s.name };
    }),
    {
      key: `dest-${draft.destination.label}`,
      icon: DestMark ? <DestMark size={12} /> : undefined,
      label: draft.destination.label,
    },
  ];
  return (
    <span className="relative flex min-w-0 flex-wrap items-center gap-1">
      <span className="sr-only">{labels.willCreate}</span>
      <AnimatePresence initial={false} mode="popLayout">
        {chips.map((c) => (
          <motion.span
            key={c.key}
            layout
            className="inline-flex"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: spring.fast.exit }}
            transition={spring.fast}
          >
            <Badge color="gray">
              <span className="inline-flex min-w-0 items-center gap-1">
                {c.icon && (
                  <span aria-hidden className="inline-grid shrink-0 text-muted-foreground">
                    {c.icon}
                  </span>
                )}
                <span className="truncate">{c.label}</span>
              </span>
            </Badge>
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

interface RoutineRowProps {
  routine: AgentRoutine;
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  open: boolean;
  foldId: string;
  now: number;
  historyLength: number;
  onToggle: () => void;
  toggleRef: (el: HTMLButtonElement | null) => void;
  onRun?: () => void;
  onStop?: () => void;
  onEnabledChange?: () => void;
  onScheduleSave?: (schedule: RoutineSchedule) => void;
  foldHover: Pick<HTMLAttributes<HTMLDivElement>, 'onMouseEnter' | 'onMouseLeave' | 'onMouseMove'>;
  labels: AgentRoutinesLabels;
}

const IGNORE_ROW_CLICK = "button, a, input, select, textarea, [role='switch'], [data-row-controls]";

function RoutineRow({
  routine: r,
  index,
  register,
  open,
  foldId,
  now,
  historyLength,
  onToggle,
  toggleRef,
  onRun,
  onStop,
  onEnabledChange,
  onScheduleSave,
  foldHover,
  labels,
}: RoutineRowProps) {
  const summaryRef = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(register, index, summaryRef);
  const size = useSize();
  const shape = useShape();
  const icons = useIcons();
  const Arrow = icons['arrow-right'];
  const Skip = icons['skip-forward'];

  const steps = r.steps ?? [];
  const live = r.run !== undefined;
  const run = r.run as RoutineActiveRun;
  const progress = live
    ? (run.progress ?? (steps.length ? (run.step + 1) / steps.length : 0.5))
    : 0;
  const last = r.history[r.history.length - 1];
  const DestMark = resolveMark(r.destination.logo);
  const ModelMark = resolveMark(r.model.logo);

  let countKey: string;
  let countText: string;
  if (live) {
    countKey = 'running';
    countText = labels.runningNow;
  } else if (!r.enabled) {
    countKey = 'paused';
    countText = labels.paused;
  } else if (r.nextRunAt === undefined) {
    countKey = 'scheduled';
    countText = labels.scheduled;
  } else {
    countKey = 'next';
    const left = r.nextRunAt - now;
    countText = left <= 0 ? labels.dueNow : labels.nextRunIn(left);
  }

  const onSummaryClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(IGNORE_ROW_CLICK)) return;
    onToggle();
  };

  return (
    <motion.li
      layout="position"
      className="relative"
      data-open={open || undefined}
      data-enabled={r.enabled || undefined}
      data-running={live || undefined}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: spring.moderate.exit }}
      transition={spring.moderate}
    >
      {index > 0 && <span aria-hidden className="absolute inset-x-3 top-0 h-px bg-border" />}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the name button toggles from the keyboard. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the name button inside is the keyboard path. */}
      <div
        ref={summaryRef}
        data-fluid-hover-index={index}
        onClick={onSummaryClick}
        className="relative z-10 grid cursor-pointer gap-1.5 px-3 py-3.5"
      >
        <AnimatePresence>{live && <RunBar key="bar" progress={progress} />}</AnimatePresence>

        {/* Name, Run now, pause switch */}
        <div className="flex min-h-6 min-w-0 items-center gap-3">
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={open}
            aria-controls={foldId}
            onClick={onToggle}
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 text-left',
              shape.chip,
              focusRing,
            )}
          >
            <span
              className={cn(
                size.type.subtitle,
                'truncate transition-colors duration-160',
                r.enabled || live ? 'text-foreground' : 'text-muted-foreground',
              )}
              style={semibold}
            >
              {r.name}
            </span>
            <DisclosureChevron open={open} />
          </button>
          <span data-row-controls className="ml-auto flex shrink-0 items-center gap-1.5">
            {live && onStop ? (
              <Button
                variant="ghost"
                size="compact"
                leadingIcon={icons.stop}
                aria-label={labels.stopRoutine(r.name)}
                onClick={onStop}
              >
                {labels.stop}
              </Button>
            ) : onRun ? (
              <Button
                variant="ghost"
                size="compact"
                leadingIcon={icons.play}
                aria-label={labels.runRoutine(r.name)}
                disabled={live}
                onClick={onRun}
              >
                {labels.runNow}
              </Button>
            ) : null}
            {onEnabledChange && (
              <Switch
                label={labels.enabledSwitch(r.name)}
                checked={r.enabled}
                onToggle={onEnabledChange}
                className="px-0 py-0 [&>span:last-child]:sr-only"
              />
            )}
          </span>
        </div>

        {/* Schedule · countdown, last run */}
        <div
          className={cn(size.type.body, 'flex min-w-0 items-center gap-2 text-muted-foreground')}
        >
          <span className="min-w-0 truncate">{labels.schedule(r.schedule)}</span>
          <MetaDot />
          <Roll
            id={countKey}
            className="shrink-0 whitespace-nowrap tabular-nums"
            innerClassName={cn(live && 'shimmer-text')}
          >
            {countText}
          </Roll>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 pl-3 @max-[560px]:hidden">
            {last ? (
              <>
                {last.status === 'skipped' ? (
                  <Skip size={13} strokeWidth={1.5} />
                ) : (
                  <AgentStatusIcon
                    status={last.status === 'failed' ? 'failed' : 'done'}
                    size={13}
                  />
                )}
                <span>
                  <span className="sr-only">{labels.runStatus[last.status]}, </span>
                  {labels.lastRun(labels.runDay(last.at, now))}
                </span>
              </>
            ) : (
              <span>{labels.notRun}</span>
            )}
          </span>
        </div>

        {/* Sources → destination | model, history */}
        <div
          className={cn(
            size.type.caption,
            'flex min-h-5 min-w-0 items-center gap-2 text-foreground',
          )}
        >
          <span aria-hidden className="flex min-w-0 items-center gap-1.5">
            <ToolStack tools={r.sources.map((s) => s.logo ?? icons.database)} max={3} size={18} />
            <Arrow size={12} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
            {DestMark && <DestMark size={12} />}
            <span className="max-w-[18ch] truncate @max-[600px]:max-w-[11ch] @max-[470px]:max-w-[8ch]">
              {r.destination.label}
            </span>
            {ModelMark && (
              <>
                <span className="mx-1.5 h-3 w-px shrink-0 bg-border @max-[420px]:hidden" />
                <Tooltip content={r.model.name}>
                  <span className="inline-grid shrink-0 place-items-center @max-[420px]:hidden">
                    <ModelMark size={14} />
                  </span>
                </Tooltip>
              </>
            )}
          </span>
          <span className="sr-only">
            {labels.chain(
              r.sources.map((s) => s.name),
              r.destination.spoken ?? r.destination.label,
              r.model.name,
            )}
          </span>
          <span className="min-w-0 flex-1" />
          <HistoryTicks
            runs={r.history}
            max={historyLength}
            now={now}
            dim={!r.enabled}
            labels={labels}
          />
        </div>
      </div>

      <Collapse open={open} id={foldId} lift {...foldHover}>
        <div className="grid gap-3 px-3 pt-0.5 pb-4">
          <AnimatePresence initial={false}>
            {live && steps.length > 0 && (
              <RunState key="run" steps={steps} step={run.step} labels={labels} />
            )}
          </AnimatePresence>
          <section className="relative grid gap-1.5">
            <h3 className={cn(size.type.caption, 'm-0 text-muted-foreground')}>
              {labels.latestReport}
            </h3>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={r.report ?? ''}
                className={cn('bg-muted px-3 py-2.5', shape.bg)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: tween.moderate.exit }}
                transition={tween.moderate}
              >
                <Report text={r.report?.trim() ? r.report : labels.noReport} />
              </motion.div>
            </AnimatePresence>
          </section>
          {r.instruction && (
            <p className={cn(size.type.body, 'm-0 text-muted-foreground')}>{r.instruction}</p>
          )}
          {onScheduleSave && (
            <ScheduleEditor
              schedule={r.schedule}
              name={r.name}
              onSave={onScheduleSave}
              labels={labels}
            />
          )}
        </div>
      </Collapse>
    </motion.li>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Scheduled agents with live countdowns, run history, pause, schedule editing and sentence-to-routine creation. */
const AgentRoutines = forwardRef<HTMLDivElement, AgentRoutinesProps>(({ size, ...props }, ref) => (
  <SizeScope size={size}>
    <AgentRoutinesInner ref={ref} {...props} />
  </SizeScope>
));
AgentRoutines.displayName = 'AgentRoutines';

const AgentRoutinesInner = forwardRef<HTMLDivElement, Omit<AgentRoutinesProps, 'size'>>(
  (
    {
      routines,
      title = 'Routines',
      openId: openProp,
      defaultOpenId = null,
      onOpenChange,
      onEnabledChange,
      onRun,
      onStop,
      onScheduleChange,
      onCreate,
      parseDraft,
      creating: creatingProp,
      defaultCreating = false,
      onCreatingChange,
      createPlaceholder = 'Weekdays at 9, read Linear and Sentry, post to #triage',
      createSuggestion,
      historyLength = 14,
      labels: labelOverrides,
      className,
      ...props
    },
    ref,
  ) => {
    const labels = useMemo(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides]);
    const size = useSize();
    const shape = useShape();
    const icons = useIcons();
    const uid = useId();

    // Open row and composer: controlled or internal.
    const [openId, setOpen] = useControllable<string | null>(openProp, defaultOpenId, onOpenChange);
    const [creating, setCreating] = useControllable(
      creatingProp,
      defaultCreating,
      onCreatingChange,
    );
    const [text, setText] = useState('');
    const draft = parseDraft && text.trim() ? parseDraft(text) : null;

    const anyScheduled = routines.some((r) => r.enabled && r.nextRunAt !== undefined);
    const now = useNow(1000, anyScheduled);
    const onSchedule = routines.filter((r) => r.enabled).length;

    // Live region: clear, then set next frame, so a repeated message is read again.
    const [message, setMessage] = useState('');
    const announce = useCallback((next: string) => {
      setMessage('');
      requestAnimationFrame(() => setMessage(next));
    }, []);

    // Focus targets.
    const newButtonRef = useRef<HTMLButtonElement>(null);
    const composerRef = useRef<HTMLDivElement>(null);
    const toggles = useRef(new Map<string, HTMLButtonElement>());
    const pendingCreate = useRef(false);

    useEffect(() => {
      if (!creating) return;
      const id = requestAnimationFrame(() =>
        composerRef.current?.querySelector('textarea')?.focus(),
      );
      return () => cancelAnimationFrame(id);
    }, [creating]);

    // Watch the data for runs that start (open the row) or finish (announce),
    // and for the routine a create just added (focus it).
    const seen = useRef(new Map<string, { live: boolean; last?: number }>());
    useEffect(() => {
      const prev = seen.current;
      const next = new Map<string, { live: boolean; last?: number }>();
      for (const r of routines) {
        const live = r.run !== undefined;
        const last = r.history[r.history.length - 1]?.at;
        const before = prev.get(r.id);
        if (before) {
          if (live && !before.live) setOpen(r.id);
          if (!live && before.live && last !== before.last) announce(labels.finished(r.name));
        }
        next.set(r.id, { live, last });
      }
      if (pendingCreate.current) {
        const added = routines.find((r) => !prev.has(r.id));
        if (added) {
          pendingCreate.current = false;
          const count = routines.filter((r) => r.enabled).length;
          announce(labels.added(added.name, count, routines.length));
          requestAnimationFrame(() => toggles.current.get(added.id)?.focus());
        }
      }
      seen.current = next;
    }, [routines, setOpen, announce, labels]);

    const closeComposer = (focusButton: boolean) => {
      setCreating(false);
      setText('');
      if (focusButton) requestAnimationFrame(() => newButtonRef.current?.focus());
    };

    const submit = (value: string) => {
      const sentence = value.trim();
      if (!sentence || !onCreate) return;
      pendingCreate.current = true;
      onCreate(sentence, parseDraft ? parseDraft(sentence) : null);
      setCreating(false);
      setText('');
    };

    const onComposerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeComposer(true);
      }
    };

    // One hover highlight across the row summaries. The folds opt out, so the
    // editor never lights the row above it.
    const listRef = useRef<HTMLUListElement>(null);
    const hover = useFluidHover(listRef, { gapClick: false });
    const foldHover = {
      onMouseEnter: () => hover.handlers.onMouseLeave(),
      onMouseLeave: () => hover.handlers.onMouseEnter(),
      onMouseMove: (e: MouseEvent<HTMLDivElement>) => e.stopPropagation(),
    };

    return (
      <AgentCard
        ref={ref}
        role="region"
        aria-labelledby={`${uid}-title`}
        className={cn('@container', className)}
        {...props}
      >
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 @max-[600px]:px-4">
          <div className="grid min-w-0">
            <h2
              id={`${uid}-title`}
              className={cn(size.type.title, 'm-0 truncate text-foreground')}
              style={semibold}
            >
              {title}
            </h2>
            <p className={cn(size.type.body, 'm-0 text-muted-foreground')}>
              {labels.scheduleSummary(<RollNumber value={onSchedule} />, routines.length)}
            </p>
          </div>
          {onCreate && (
            <Button
              ref={newButtonRef}
              variant="tertiary"
              leadingIcon={icons.plus}
              active={creating}
              aria-expanded={creating}
              aria-controls={`${uid}-new`}
              onClick={() => (creating ? closeComposer(false) : setCreating(true))}
              className="shrink-0"
            >
              {labels.newRoutine}
            </Button>
          )}
        </header>

        {onCreate && (
          <Collapse open={creating} id={`${uid}-new`} lift>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape from the composer inside closes it; the composer owns input. */}
            <div
              ref={composerRef}
              className="px-5 pb-4 @max-[600px]:px-4"
              onKeyDown={onComposerKeyDown}
            >
              <InputMessage
                value={text}
                onValueChange={setText}
                onSend={(value) => submit(value)}
                placeholder={createPlaceholder}
                placeholderSuggestion={createSuggestion}
                sendLabel={labels.addRoutine}
                minRows={1}
                maxRows={4}
                textareaProps={{ 'aria-label': labels.describeRoutine }}
                leftSlot={
                  parseDraft ? (
                    <DraftChips draft={draft} hasText={text.trim().length > 0} labels={labels} />
                  ) : undefined
                }
                rightSlot={
                  <Button variant="ghost" size="compact" onClick={() => closeComposer(true)}>
                    {labels.cancel}
                  </Button>
                }
              />
            </div>
          </Collapse>
        )}

        {routines.length === 0 ? (
          <p
            className={cn(size.type.body, 'm-0 px-5 pb-5 text-muted-foreground @max-[600px]:px-4')}
          >
            {labels.empty(onCreate !== undefined)}
          </p>
        ) : (
          <ul
            ref={listRef}
            className="relative m-0 list-none px-2 pb-2 @max-[600px]:px-1"
            onMouseEnter={hover.handlers.onMouseEnter}
            onMouseMove={hover.handlers.onMouseMove}
            onMouseLeave={hover.handlers.onMouseLeave}
          >
            <FluidHoverHighlight hover={hover} className={shape.bg} />
            <AnimatePresence initial={false}>
              {routines.map((r, i) => {
                const open = openId === r.id;
                return (
                  <RoutineRow
                    key={r.id}
                    routine={r}
                    index={i}
                    register={hover.registerItem}
                    open={open}
                    foldId={`${uid}-${r.id}`}
                    now={now}
                    historyLength={historyLength}
                    onToggle={() => setOpen(open ? null : r.id)}
                    toggleRef={(el) => {
                      if (el) toggles.current.set(r.id, el);
                      else toggles.current.delete(r.id);
                    }}
                    onRun={
                      onRun
                        ? () => {
                            announce(labels.running(r.name));
                            onRun(r.id);
                          }
                        : undefined
                    }
                    onStop={
                      onStop
                        ? () => {
                            announce(labels.stopped(r.name));
                            onStop(r.id);
                          }
                        : undefined
                    }
                    onEnabledChange={
                      onEnabledChange
                        ? () => {
                            const enabled = !r.enabled;
                            const count = onSchedule + (enabled ? 1 : -1);
                            announce(
                              labels.enabledChanged(r.name, enabled, count, routines.length),
                            );
                            onEnabledChange(r.id, enabled);
                          }
                        : undefined
                    }
                    onScheduleSave={
                      onScheduleChange
                        ? (schedule) => {
                            announce(labels.rescheduled(r.name, schedule));
                            onScheduleChange(r.id, schedule);
                          }
                        : undefined
                    }
                    foldHover={foldHover}
                    labels={labels}
                  />
                );
              })}
            </AnimatePresence>
          </ul>
        )}

        <div className="sr-only" role="status" aria-live="polite">
          {message}
        </div>
      </AgentCard>
    );
  },
);
AgentRoutinesInner.displayName = 'AgentRoutinesInner';

export type {
  AgentRoutine,
  AgentRoutinesLabels,
  AgentRoutinesProps,
  RoutineActiveRun,
  RoutineDestination,
  RoutineDraft,
  RoutineFrequency,
  RoutineModel,
  RoutineRun,
  RoutineRunStatus,
  RoutineSchedule,
  RoutineSource,
};
export { AgentRoutines, describeSchedule };
