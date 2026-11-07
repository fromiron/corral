'use client';

// Swimlanes of agents over a shared time window: one lane per agent, task
// spans with their tool marks, dashed hand-off curves between tasks, a live
// "now" edge on the right, a minute axis, and a footer for tasks that need
// the user. Positions derive from timestamps and `now`, so the board scrolls
// on its own while anything is live.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNow } from '../../hooks/use-now.ts';
import { agentLogos } from '../../lib/agent-logos.tsx';
import { Elevated } from '../../lib/elevated.tsx';
import { focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import {
  AgentAvatar,
  AgentCard,
  type AgentMark,
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabels,
  LiveDot,
  resolveMark,
  SizeScope,
  toneFill,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A question a waiting task puts to the user. */
interface LaneAsk {
  /** Short question (`Rotate the live Stripe keys?`). */
  title: string;
  /** One or two lines of context. */
  text?: string;
  /** Approve button label. Default `Approve`. */
  approveLabel?: string;
  /** Deny button label. Default `Deny`. */
  denyLabel?: string;
}

/** One span on an agent's lane. */
interface LaneTask {
  id: string;
  label: string;
  status: AgentStatus;
  /** Start time, ms since epoch. */
  startedAt: number;
  /** End time; omit while running or waiting (the span grows to `now`). */
  endedAt?: number;
  /** Tool marks drawn at the start of the span. */
  tools?: AgentMark[];
  /** Tool or step lines listed in the detail popover. */
  details?: string[];
  /** For `waiting` tasks: what the agent is asking. */
  ask?: LaneAsk;
  /** Status word shown instead of the kit's default label. */
  statusLabel?: string;
  /** Waiting stretches inside the span, drawn as tinted bands. */
  waits?: { startedAt: number; endedAt: number }[];
  /**
   * Stretches when the work was elsewhere (waiting on another agent). The span is drawn as
   * separate blocks around them and stays one selectable task.
   */
  gaps?: { startedAt: number; endedAt: number }[];
  /** Attributes for the span's button (ids, test hooks, data attributes). */
  buttonProps?: Record<`data-${string}`, string | undefined>;
}

/** One lane. */
interface LaneAgent {
  id: string;
  name: string;
  /** Model line under the name (`Opus 5.5`). */
  model?: string;
  logo?: AgentMark;
  tasks: LaneTask[];
}

/** A dashed curve from the end of one task to the start of another. */
interface LaneHandoff {
  from: string;
  to: string;
  /** Where the curve leaves `from`, ms. Default its end (a delegation leaves when the child starts). */
  fromAt?: number;
  /** Where the curve reaches `to`, ms. Default its start (work picked up mid-span lands there). */
  toAt?: number;
}

/** Words the board shows; every default is the kit's English text. */
interface AgentLanesLabels {
  running: (count: number) => string;
  needsYou: (count: number) => string;
  needsYouChip: string;
  idle: string;
  now: string;
  /** Header chip for the visible span. */
  window: (ms: number) => string;
  /** An axis tick: minutes before now, or time since `startAt` when it is set. */
  tick: (ms: number) => string;
  lane: (name: string) => string;
  timing: (task: LaneTask, now: number) => string;
  /** After the agent's name in the footer. */
  needsYouLine: (what: string) => string;
  review: string;
  close: string;
  open: string;
  approve: string;
  deny: string;
  announce: (count: number) => string;
}

interface AgentLanesProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Lanes, top to bottom. */
  agents: LaneAgent[];
  /** Hand-offs between task ids. Live (animated) while the target is running. */
  handoffs?: LaneHandoff[];
  /** Visible span, ms. Default 30 minutes. */
  windowMs?: number;
  /** Minutes between axis ticks. Default 5. */
  tickMinutes?: number;
  /** Fixed clock (ms). Omitted, the board ticks itself while anything is live. */
  now?: number;
  /** Header title. Default `Agents`. */
  title?: string;
  /** Lane height in px. Default 48. */
  rowHeight?: number;
  /** Open task (controlled). `null` closes. */
  openTaskId?: string | null;
  /** Initially open task (uncontrolled). */
  defaultOpenTaskId?: string | null;
  onOpenTaskChange?: (taskId: string | null) => void;
  /** Approve a waiting task's ask. */
  onApprove?: (taskId: string) => void;
  /** Deny a waiting task's ask. */
  onDeny?: (taskId: string) => void;
  /** "Open" in a task's detail popover; omitted, the link is hidden. */
  onOpenTask?: (taskId: string) => void;
  /** Density step for the whole board; omitted, inherits the nearest SizeProvider. */
  size?: SizeVariant;
  /** Fixed window start (ms): the board spans `startAt`..`now` with ticks counted from it. */
  startAt?: number;
  /** Fixed window end (ms) with `startAt`; omitted, the window ends at `now`. */
  endAt?: number;
  /** The selected span; it is `aria-pressed` and outlined. */
  selectedTaskId?: string | null;
  /** Makes each span select its task instead of opening the detail popover. */
  onSelectTask?: (taskId: string) => void;
  /** Localized words; missing entries keep the kit's English. */
  labels?: Partial<AgentLanesLabels>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pixels between a span's edge and the trunk of a connector that turns into it. */
const ELBOW_GAP = 10;

interface ElbowEnd {
  /** Where the hand-off happens on this span, px. */
  x: number;
  /** The span's vertical centre, px. */
  y: number;
  start: number;
  end: number;
}

/**
 * A hand-off between overlapping spans at nearly one moment, drawn as a rounded elbow: a span
 * that begins here is entered from the left at its middle, one that ends here is left to the
 * right at its middle, and the other span is touched at its edge facing the gap. Several
 * hand-offs at one moment share the vertical trunk, like branches of a tree.
 */
function elbow({ from, to, half }: { from: ElbowEnd; to: ElbowEnd; half: number }) {
  const down = to.y > from.y ? 1 : -1;
  const near = (a: number, b: number) => Math.abs(a - b) < 8;
  if (near(to.x, to.start)) {
    // Into a span that starts here: drop from the source's facing edge, then turn right.
    const trunk = Math.max(2, to.start - ELBOW_GAP);
    const top = from.y + down * half;
    const r = Math.min(6, Math.abs(to.y - top) / 2);
    return `M ${trunk} ${top} L ${trunk} ${to.y - down * r} Q ${trunk} ${to.y} ${trunk + r} ${to.y} L ${to.start} ${to.y}`;
  }
  if (from.end >= from.x - 1 && from.end <= to.x + 8) {
    // Out of a span that ends here: leave to the right, then turn into the target's facing edge.
    const trunk = from.end + ELBOW_GAP;
    const edge = to.y - down * half;
    const r = Math.min(6, Math.abs(edge - from.y) / 2);
    return `M ${from.end} ${from.y} L ${trunk - r} ${from.y} Q ${trunk} ${from.y} ${trunk} ${from.y + down * r} L ${trunk} ${edge}`;
  }
  // Mid-span on both sides: a short S between the facing edges.
  const top = from.y + down * half;
  const bottom = to.y - down * half;
  const mid = (top + bottom) / 2;
  return `M ${from.x} ${top} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${bottom}`;
}

const MIN = 60_000;

function minutes(ms: number) {
  return `${Math.max(0, Math.round(ms / MIN))}m`;
}

function isLive(status: AgentStatus) {
  return status === 'running' || status === 'waiting';
}

function taskTiming(task: LaneTask, now: number) {
  const end = task.endedAt ?? now;
  const dur = minutes(end - task.startedAt);
  return task.status === 'done' ? `took ${dur}` : dur;
}

const defaultLabels: AgentLanesLabels = {
  running: (n) => `${n} running`,
  needsYou: (n) => `${n} needs you`,
  needsYouChip: 'Needs you',
  idle: 'Idle',
  now: 'now',
  window: (ms) => `Last ${Math.round(ms / MIN)}m`,
  tick: (ms) => `−${Math.round(ms / MIN)}m`,
  lane: (name) => `${name}'s tasks`,
  timing: taskTiming,
  needsYouLine: (what) => `needs you: ${what}`,
  review: 'Review',
  close: 'Close',
  open: 'Open',
  approve: 'Approve',
  deny: 'Deny',
  announce: (n) => (n ? `${n} ${n === 1 ? 'task needs' : 'tasks need'} you` : ''),
};

/** A round axis step giving at most about six ticks over `span` ms. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map(
  (s) => s * 1000,
);
/** A span's height: the lane's 10px insets above and below one track. */
function blockHeight(rowHeight: number) {
  return rowHeight - 20;
}

function tickStep(span: number) {
  return STEPS.find((step) => span / step <= 6) ?? Math.ceil(span / 6 / 3_600_000) * 3_600_000;
}

function agentState(agent: LaneAgent): 'running' | 'waiting' | 'idle' {
  if (agent.tasks.some((t) => t.status === 'waiting')) return 'waiting';
  if (agent.tasks.some((t) => t.status === 'running')) return 'running';
  return 'idle';
}

/** Tinted fill for the live accent, matching `toneFill`. */
const EMPHASIS_FILL = 'color-mix(in srgb, var(--emphasis) 14%, var(--background))';

const blockTone: Partial<Record<AgentStatus, { bg: string; fg: string }>> = {
  running: { bg: EMPHASIS_FILL, fg: 'var(--foreground)' },
  waiting: { bg: toneFill('amber'), fg: 'var(--warning)' },
  failed: { bg: toneFill('red'), fg: 'var(--destructive)' },
};

// ─── Component ───────────────────────────────────────────────────────────────

/** Agents as swimlanes over a shared, live time window. */
const AgentLanes = forwardRef<HTMLDivElement, AgentLanesProps>(
  (
    {
      agents,
      handoffs = [],
      windowMs = 30 * MIN,
      tickMinutes = 5,
      now: nowProp,
      title = 'Agents',
      rowHeight = 48,
      openTaskId: openProp,
      defaultOpenTaskId = null,
      onOpenTaskChange,
      onApprove,
      onDeny,
      onOpenTask,
      size: sizeProp,
      startAt,
      endAt,
      selectedTaskId = null,
      onSelectTask,
      labels: labelOverrides,
      className,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const uid = useId();
    const shape = useShape();
    // Hand-offs are drawn in pixels, so their corners and offsets keep their shape at any width.
    const spansRef = useRef<HTMLDivElement>(null);
    const [laneWidth, setLaneWidth] = useState(1000);
    useLayoutEffect(() => {
      const el = spansRef.current;
      if (!el) return;
      const measure = () => setLaneWidth(el.clientWidth || 1000);
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }, []);
    const size = useSize(sizeProp);
    const reduce = useReducedMotion() ?? false;

    const anyLive = agents.some((a) => a.tasks.some((t) => isLive(t.status)));
    const ticking = useNow(1000, nowProp === undefined && anyLive);
    const now = nowProp ?? ticking;
    const labels = useMemo(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides]);
    // A fixed start spans the whole record; otherwise the window trails `now`.
    const span = startAt === undefined ? windowMs : Math.max(1, (endAt ?? now) - startAt);
    const start = startAt ?? now - windowMs;
    const pct = useCallback((t: number) => ((t - start) / span) * 100, [start, span]);

    const [openInner, setOpenInner] = useState<string | null>(defaultOpenTaskId);
    const openId = openProp !== undefined ? openProp : openInner;
    const setOpen = (id: string | null) => {
      if (openProp === undefined) setOpenInner(id);
      onOpenTaskChange?.(id);
    };

    // Overlapping spans of one lane stack on their own tracks, and the lane grows to fit them,
    // so a concurrent span never covers another.
    const layout = useMemo(() => {
      const map = new Map<
        string,
        { task: LaneTask; agent: LaneAgent; row: number; track: number }
      >();
      const tops: number[] = [];
      const heights: number[] = [];
      let top = 0;
      for (const [row, agent] of agents.entries()) {
        const ends: number[] = [];
        for (const task of [...agent.tasks].sort((a, b) => a.startedAt - b.startedAt)) {
          const end = task.endedAt ?? now;
          let track = ends.findIndex((last) => last <= task.startedAt);
          if (track === -1) track = ends.length;
          ends[track] = end;
          map.set(task.id, { task, agent, row, track });
        }
        const laneHeight = rowHeight + Math.max(0, ends.length - 1) * (blockHeight(rowHeight) + 4);
        tops.push(top);
        heights.push(laneHeight);
        top += laneHeight;
      }
      return { map, tops, heights, total: top };
    }, [agents, rowHeight, now]);
    const index = layout.map;
    const rowTop = (row: number) => layout.tops[row] ?? 0;
    const rowSize = (row: number) => layout.heights[row] ?? rowHeight;
    const spanY = (row: number, track: number) =>
      rowTop(row) + 10 + track * (blockHeight(rowHeight) + 4) + blockHeight(rowHeight) / 2;

    const running = agents.filter((a) => agentState(a) === 'running').length;
    const waitingTasks = agents.flatMap((a) =>
      a.tasks.filter((t) => t.status === 'waiting').map((t) => ({ agent: a, task: t })),
    );

    const ticks: { key: number; left: number; label: string }[] = [];
    if (startAt === undefined) {
      for (let m = tickMinutes; m < windowMs / MIN; m += tickMinutes)
        ticks.push({
          key: m,
          left: 100 - (m / (windowMs / MIN)) * 100,
          label: labels.tick(m * MIN),
        });
    } else {
      const step = tickStep(span);
      for (let at = step; at < span; at += step)
        ticks.push({ key: at, left: (at / span) * 100, label: labels.tick(at) });
    }

    const height = layout.total;
    const open = openId ? index.get(openId) : undefined;
    const SparkMark = agentLogos.spark;

    const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.key === 'Escape' && openId) {
        e.stopPropagation();
        setOpen(null);
      }
    };

    return (
      <SizeScope size={sizeProp}>
        <AgentCard
          ref={ref}
          className={cn('@container', className)}
          onKeyDown={handleKey}
          {...props}
        >
          {/* Header */}
          <header className="flex min-w-0 items-center gap-2.5 border-b border-border px-4 py-3.5">
            <span
              className="grid w-4 shrink-0 place-items-center"
              style={{ color: 'var(--emphasis)' }}
              aria-hidden
            >
              <SparkMark size={16} />
            </span>
            <span
              className={cn(size.type.body, 'truncate text-foreground')}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {title}
            </span>
            <span
              className={cn(
                size.type.caption,
                'flex min-w-0 flex-1 gap-3 overflow-hidden whitespace-nowrap text-muted-foreground',
              )}
            >
              {running > 0 && (
                <span className="inline-flex items-center gap-1.5 @max-[520px]:hidden">
                  <LiveDot />
                  {labels.running(running)}
                </span>
              )}
              {waitingTasks.length > 0 && (
                <span
                  className="inline-flex items-center gap-1.5"
                  style={{ color: 'var(--warning)' }}
                >
                  <LiveDot color="var(--warning)" />
                  {labels.needsYou(waitingTasks.length)}
                </span>
              )}
            </span>
            <span
              className={cn(
                size.type.caption,
                shape.chip,
                'shrink-0 bg-muted px-2 py-0.5 text-foreground',
              )}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {labels.window(span)}
            </span>
          </header>

          {/* Body */}
          <div className="grid grid-cols-[168px_minmax(0,1fr)] pt-[26px] pr-4 pb-3 @max-[520px]:grid-cols-[48px_minmax(0,1fr)]">
            <ul
              className="m-0 grid list-none p-0"
              style={{ gridTemplateRows: layout.heights.map((h) => `${h}px`).join(' ') }}
            >
              {agents.map((agent) => {
                const state = agentState(agent);
                const chip =
                  state === 'waiting' ? labels.needsYouChip : state === 'idle' ? labels.idle : null;
                return (
                  <li key={agent.id} className="flex min-w-0 items-center gap-2.5 pr-3 pl-4">
                    <AgentAvatar name={agent.name} logo={agent.logo} size={24} />
                    <span className="grid min-w-0 @max-[520px]:hidden">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={cn(size.type.body, 'truncate text-foreground')}
                          style={{ fontVariationSettings: fontWeights.semibold }}
                        >
                          {agent.name}
                        </span>
                        <AnimatePresence initial={false}>
                          {chip && (
                            <motion.span
                              key={chip}
                              className={cn(
                                size.type.caption,
                                shape.chip,
                                'shrink-0 px-1.5 whitespace-nowrap',
                              )}
                              style={{
                                fontVariationSettings: fontWeights.semibold,
                                background:
                                  state === 'waiting' ? toneFill('amber') : 'var(--muted)',
                                color:
                                  state === 'waiting'
                                    ? 'var(--warning)'
                                    : 'var(--muted-foreground)',
                              }}
                              initial={{ opacity: 0, scale: 0.9 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.9, transition: spring.fast.exit }}
                              transition={spring.fast}
                            >
                              {chip}
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                      {agent.model && (
                        <span className={cn(size.type.caption, 'truncate text-muted-foreground')}>
                          {agent.model}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>

            {/* Track */}
            <div className="relative" style={{ height }}>
              {/* Row rules */}
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                {agents.map((a, row) => (
                  <div
                    key={a.id}
                    className="absolute inset-x-0 border-b border-border"
                    style={{ top: rowTop(row), height: rowSize(row) }}
                  />
                ))}
              </div>
              {/* Axis */}
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                {ticks.map(({ key, left, label }) => {
                  return (
                    <span
                      key={key}
                      className="absolute inset-y-0 w-0 border-l border-dashed border-border"
                      style={{ left: `${left}%` }}
                    >
                      <span
                        className={cn(
                          size.type.caption,
                          'absolute bottom-full left-0 mb-1.5 -translate-x-1/2 whitespace-nowrap text-muted-foreground tabular-nums',
                        )}
                      >
                        {label}
                      </span>
                    </span>
                  );
                })}
              </div>

              {/* Spans */}
              <div
                ref={spansRef}
                className={cn(
                  'absolute inset-0 overflow-hidden',
                  // A trailing window fades its oldest edge; a fixed one starts at its first record.
                  startAt === undefined &&
                    '[mask-image:linear-gradient(to_right,transparent_0,black_40px)]',
                )}
              >
                <svg
                  className="pointer-events-none absolute inset-0 size-full overflow-visible"
                  viewBox={`0 0 ${laneWidth} ${height}`}
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  {handoffs.map((h) => {
                    const a = index.get(h.from);
                    const b = index.get(h.to);
                    if (!a || !b) return null;
                    const px = (at: number) => (pct(at) / 100) * laneWidth;
                    const x1 = px(h.fromAt ?? a.task.endedAt ?? now);
                    const x2 = px(h.toAt ?? b.task.startedAt);
                    const y1 = spanY(a.row, a.track);
                    const y2 = spanY(b.row, b.track);
                    const d =
                      y1 !== y2 && Math.abs(x2 - x1) < 40
                        ? elbow({
                            from: {
                              x: x1,
                              y: y1,
                              start: px(a.task.startedAt),
                              end: px(a.task.endedAt ?? now),
                            },
                            to: {
                              x: x2,
                              y: y2,
                              start: px(b.task.startedAt),
                              end: px(b.task.endedAt ?? now),
                            },
                            half: blockHeight(rowHeight) / 2,
                          })
                        : (() => {
                            const dx = Math.max(12, Math.abs(x2 - x1) * 0.7);
                            return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
                          })();
                    const live = isLive(b.task.status);
                    // A live hand-off flows (CSS `.flow-dash`, still under reduced
                    // motion); a settled one draws in once.
                    return (
                      <motion.path
                        key={`${h.from}-${h.to}`}
                        data-handoff={`${h.from}>${h.to}`}
                        d={d}
                        fill="none"
                        stroke={live ? 'var(--emphasis)' : 'var(--muted-foreground)'}
                        strokeWidth={1}
                        strokeDasharray="3 3"
                        vectorEffect="non-scaling-stroke"
                        className={live ? 'flow-dash' : undefined}
                        initial={
                          reduce ? false : live ? { opacity: 0 } : { pathLength: 0, opacity: 0 }
                        }
                        animate={live ? { opacity: 0.8 } : { pathLength: 1, opacity: 0.6 }}
                        transition={spring.slow}
                      />
                    );
                  })}
                </svg>
                {agents.map((agent, row) => (
                  <ul
                    key={agent.id}
                    className="absolute inset-x-0 m-0 list-none p-0"
                    aria-label={labels.lane(agent.name)}
                    style={{ top: rowTop(row), height: rowSize(row) }}
                  >
                    {agent.tasks.map((task) => (
                      <LaneBlock
                        key={task.id}
                        agent={agent}
                        task={task}
                        now={now}
                        left={pct(task.startedAt)}
                        width={pct(task.endedAt ?? now) - pct(task.startedAt)}
                        open={openId === task.id}
                        popupId={`${uid}-${task.id}`}
                        onToggle={() => setOpen(openId === task.id ? null : task.id)}
                        selected={selectedTaskId === task.id}
                        onSelect={onSelectTask ? () => onSelectTask(task.id) : undefined}
                        labels={labels}
                        pct={pct}
                        top={10 + (index.get(task.id)?.track ?? 0) * (blockHeight(rowHeight) + 4)}
                        height={blockHeight(rowHeight)}
                      />
                    ))}
                  </ul>
                ))}
              </div>

              {/* Now marker */}
              {anyLive && (
                <span
                  className="pointer-events-none absolute -top-1.5 w-0"
                  style={{ left: `${Math.min(100, pct(now))}%` }}
                  aria-hidden
                >
                  <span
                    className={cn(
                      size.type.micro,
                      shape.chip,
                      'absolute right-0 bottom-full px-1.5',
                    )}
                    style={{
                      background: EMPHASIS_FILL,
                      color: 'var(--emphasis)',
                      fontVariationSettings: fontWeights.semibold,
                    }}
                  >
                    {labels.now}
                  </span>
                </span>
              )}

              {/* Popover */}
              <AnimatePresence>
                {open && (
                  <LanePopover
                    key={open.task.id}
                    id={`${uid}-${open.task.id}`}
                    agent={open.agent}
                    task={open.task}
                    now={now}
                    left={Math.max(0, pct(open.task.startedAt))}
                    top={rowTop(open.row)}
                    rowHeight={rowSize(open.row)}
                    up={open.row >= agents.length / 2}
                    onClose={() => setOpen(null)}
                    onApprove={onApprove}
                    onDeny={onDeny}
                    onOpenTask={onOpenTask}
                    labels={labels}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Needs-you footer */}
          <AnimatePresence initial={false}>
            {waitingTasks.length > 0 && (
              <motion.div
                className="grid gap-1 border-t border-border px-4 py-2.5"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: spring.moderate.exit }}
                transition={spring.moderate}
              >
                {waitingTasks.map(({ agent, task }) => (
                  <div key={task.id} className="flex min-w-0 items-center gap-2">
                    <AgentStatusIcon status="waiting" />
                    <span
                      className={cn(
                        size.type.body,
                        'min-w-0 flex-1 truncate text-muted-foreground',
                      )}
                    >
                      <span
                        className="text-foreground"
                        style={{ fontVariationSettings: fontWeights.semibold }}
                      >
                        {agent.name}
                      </span>{' '}
                      {labels.needsYouLine(task.ask?.title ?? task.label)}
                    </span>
                    <Button
                      variant="secondary"
                      size="compact"
                      {...(onSelectTask
                        ? { 'aria-pressed': selectedTaskId === task.id }
                        : {
                            'aria-expanded': openId === task.id,
                            'aria-controls': `${uid}-${task.id}`,
                          })}
                      onClick={() =>
                        onSelectTask
                          ? onSelectTask(task.id)
                          : setOpen(openId === task.id ? null : task.id)
                      }
                    >
                      {labels.review}
                    </Button>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <span className="sr-only" aria-live="polite">
            {labels.announce(waitingTasks.length)}
          </span>
        </AgentCard>
      </SizeScope>
    );
  },
);
AgentLanes.displayName = 'AgentLanes';

// ─── Block ───────────────────────────────────────────────────────────────────

/** The worked stretches of [start, end] around its gaps, in order; empty gaps are ignored. */
function blockPieces(start: number, end: number, gaps: LaneTask['gaps'] = []): [number, number][] {
  const pieces: [number, number][] = [];
  let from = start;
  for (const gap of [...gaps].sort((a, b) => a.startedAt - b.startedAt)) {
    const gapStart = Math.max(start, gap.startedAt);
    const gapEnd = Math.min(end, gap.endedAt);
    if (gapEnd <= gapStart || gapEnd <= from) continue;
    if (gapStart > from) pieces.push([from, gapStart]);
    from = gapEnd;
  }
  if (end > from || !pieces.length) pieces.push([from, Math.max(from, end)]);
  return pieces;
}

function LaneBlock({
  agent,
  task,
  now,
  left,
  width,
  open,
  popupId,
  onToggle,
  selected,
  onSelect,
  labels,
  pct,
  top,
  height,
}: {
  agent: LaneAgent;
  task: LaneTask;
  now: number;
  left: number;
  width: number;
  open: boolean;
  popupId: string;
  onToggle: () => void;
  selected: boolean;
  onSelect: (() => void) | undefined;
  labels: AgentLanesLabels;
  pct: (t: number) => number;
  top: number;
  height: number;
}) {
  const shape = useShape();
  const size = useSize();
  const tone = blockTone[task.status];
  const live = isLive(task.status);
  const statusLabel = task.statusLabel ?? agentStatusLabels[task.status];
  const end = task.endedAt ?? now;
  const length = Math.max(1, pct(end) - pct(task.startedAt));
  const at = (t: number) => ((pct(t) - pct(task.startedAt)) / length) * 100;
  const pieces = blockPieces(task.startedAt, end, task.gaps).map(([from, to]) => ({
    left: at(from),
    width: at(to) - at(from),
  }));
  const split = pieces.length > 1;
  // A split span names itself in its widest block, where the name has the most room.
  const widest = split ? pieces.reduce((a, b) => (b.width > a.width ? b : a)) : undefined;
  const edge = [
    task.status === 'running' && 'inset -2px 0 0 var(--emphasis)',
    selected && 'inset 0 0 0 1.5px var(--emphasis)',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <li
      className={cn('absolute', !live && 'min-w-1.5', task.status === 'waiting' && 'z-[2]')}
      style={{ left: `${left}%`, width: `${width}%`, top, height }}
    >
      <button
        type="button"
        {...task.buttonProps}
        className={cn(
          size.type.caption,
          shape.bg,
          'group relative flex size-full items-center overflow-hidden px-2 whitespace-nowrap',
          focusRingInset,
          task.status === 'running' && !split && 'sheen',
          !tone && 'text-muted-foreground',
          !tone && !split && 'bg-active hover:bg-hover',
          open && 'brightness-[0.97]',
        )}
        style={{
          fontVariationSettings: fontWeights.semibold,
          ...(tone && { color: tone.fg }),
          ...(tone && !split && { background: tone.bg }),
          // Selection uses the kit's one accent, inside the span edge (each block's when split).
          ...(edge && !split && { boxShadow: edge }),
        }}
        title={task.label}
        {...(onSelect
          ? { 'aria-pressed': selected }
          : { 'aria-expanded': open, 'aria-controls': popupId })}
        aria-label={`${agent.name}: ${task.label} – ${statusLabel}, ${labels.timing(task, now)}`}
        onClick={onSelect ?? onToggle}
      >
        {split &&
          pieces.map((piece, i) => (
            <span
              key={piece.left}
              data-lane-piece
              aria-hidden
              className={cn(
                shape.bg,
                'pointer-events-none absolute inset-y-0',
                !tone && 'bg-active group-hover:bg-hover',
                task.status === 'running' && i === pieces.length - 1 && 'sheen',
              )}
              style={{
                left: `${piece.left}%`,
                width: `${piece.width}%`,
                ...(tone && { background: tone.bg }),
                ...((selected || (task.status === 'running' && i === pieces.length - 1)) && {
                  boxShadow: selected
                    ? 'inset 0 0 0 1.5px var(--emphasis)'
                    : 'inset -2px 0 0 var(--emphasis)',
                }),
              }}
            />
          ))}
        {task.waits?.map((wait) => (
          <span
            key={wait.startedAt}
            aria-hidden
            className="pointer-events-none absolute inset-y-0"
            style={{
              left: `${((pct(wait.startedAt) - pct(task.startedAt)) / length) * 100}%`,
              width: `${((pct(wait.endedAt) - pct(wait.startedAt)) / length) * 100}%`,
              background: toneFill('amber'),
            }}
          />
        ))}
        <span
          data-lane-label
          className={cn(
            'flex min-w-0 items-center overflow-hidden',
            split ? 'absolute inset-y-0 px-2' : 'relative',
          )}
          style={
            split && widest ? { left: `${widest.left}%`, width: `${widest.width}%` } : undefined
          }
        >
          {task.tools && task.tools.length > 0 && (
            <span className="mr-1.5 flex shrink-0 gap-1" aria-hidden>
              {task.tools.map((tool, i) => {
                const Mark = resolveMark(tool);
                // biome-ignore lint/suspicious/noArrayIndexKey: tool marks may repeat and never reorder.
                return Mark ? <Mark key={i} size={12} /> : null;
              })}
            </span>
          )}
          <span className="relative min-w-0 overflow-hidden text-start">{task.label}</span>
        </span>
      </button>
      {task.status === 'waiting' && (
        <Elevated
          offset={1}
          className={cn(
            size.type.caption,
            shape.chip,
            'pulse-soft pointer-events-none absolute top-1/2 right-1 inline-flex -translate-y-1/2 items-center gap-1 px-1.5 whitespace-nowrap',
          )}
          style={{ color: 'var(--warning)', fontVariationSettings: fontWeights.semibold }}
          aria-hidden
        >
          <AgentStatusIcon status="waiting" size={12} />
          {labels.needsYouChip}
        </Elevated>
      )}
    </li>
  );
}

// ─── Popover ─────────────────────────────────────────────────────────────────

function LanePopover({
  id,
  agent,
  task,
  now,
  left,
  top,
  rowHeight,
  up,
  onClose,
  onApprove,
  onDeny,
  onOpenTask,
  labels,
}: {
  id: string;
  agent: LaneAgent;
  task: LaneTask;
  now: number;
  left: number;
  top: number;
  rowHeight: number;
  up: boolean;
  onClose: () => void;
  onApprove?: (taskId: string) => void;
  onDeny?: (taskId: string) => void;
  onOpenTask?: (taskId: string) => void;
  labels: AgentLanesLabels;
}) {
  const shape = useShape();
  const size = useSize();
  const ask = task.status === 'waiting' ? task.ask : undefined;
  const width = ask ? 280 : 240;
  return (
    <motion.div
      id={id}
      role={ask ? 'dialog' : 'group'}
      aria-label={`${agent.name}: ${task.label}`}
      className="absolute z-[5]"
      style={{
        left: `min(${left}%, calc(100% - ${width}px))`,
        top: up ? top + 10 : top + rowHeight - 6,
        width,
        maxWidth: 'calc(100cqw - 24px)',
        translateY: up ? '-100%' : 0,
      }}
      initial={{ opacity: 0, y: up ? 3 : -3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: spring.fast.exit }}
      transition={spring.fast}
    >
      <Elevated
        offset={2}
        className={cn(shape.container, 'grid gap-1 p-3 [overflow-wrap:anywhere]')}
      >
        <span
          className={cn(
            size.type.caption,
            'flex min-w-0 gap-1 whitespace-nowrap text-muted-foreground',
          )}
        >
          <span className="truncate">{agent.name}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">
            {task.statusLabel ?? agentStatusLabels[task.status]}, {labels.timing(task, now)}
          </span>
        </span>
        <span
          className={cn(size.type.body, 'text-foreground')}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {ask?.title ?? task.label}
        </span>
        {ask?.text && (
          <p className={cn(size.type.caption, 'm-0 text-muted-foreground')}>{ask.text}</p>
        )}
        {!ask && task.details && task.details.length > 0 && (
          <ul
            className={cn(
              size.type.caption,
              'm-0 grid list-disc gap-0.5 pl-4 text-muted-foreground',
            )}
          >
            {task.details.map((d, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: detail lines may repeat and never reorder.
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex justify-end gap-1.5">
          {ask ? (
            <>
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  onDeny?.(task.id);
                  onClose();
                }}
              >
                {ask.denyLabel ?? labels.deny}
              </Button>
              <Button
                variant="primary"
                size="compact"
                onClick={() => {
                  onApprove?.(task.id);
                  onClose();
                }}
              >
                {ask.approveLabel ?? labels.approve}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="compact" onClick={onClose}>
                {labels.close}
              </Button>
              {onOpenTask && (
                <Button variant="secondary" size="compact" onClick={() => onOpenTask(task.id)}>
                  {labels.open}
                </Button>
              )}
            </>
          )}
        </div>
      </Elevated>
    </motion.div>
  );
}

export type { AgentLanesLabels, AgentLanesProps, LaneAgent, LaneAsk, LaneHandoff, LaneTask };
export { AgentLanes };
