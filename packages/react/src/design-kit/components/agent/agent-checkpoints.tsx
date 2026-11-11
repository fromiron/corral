'use client';

// A run's checkpoint lane: one row per checkpoint on a vertical rail, newest
// last. The head (where the workspace currently is) gets the solid dot; rows
// after it (left behind by a rewind) dim until you rewind forward to them.
// With `onRewind`, hovering or focusing a row swaps its meta for a Rewind
// button; Enter on a focused row rewinds there too. A rewind only asks the
// host: the head moves when the host passes a new `head`.

import { motion } from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { useNow } from '../../hooks/use-now.ts';
import { formatClock, formatCost } from '../../lib/agent-format.ts';
import { Elevated } from '../../lib/elevated.tsx';
import { focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { FluidHoverHighlight } from '../ui/fluid-hover-highlight.tsx';
import { type AgentStatus, AgentStatusIcon, SizeScope } from './agent-primitives.tsx';

/** One checkpoint on the lane. */
interface AgentCheckpoint {
  id: string;
  /** What the agent had done when the checkpoint was taken (`Wrote the plan copy`). */
  label: string;
  /** `running` is the checkpoint being built now; its label shimmers and its clock runs. */
  status: AgentStatus;
  /** When the checkpoint was taken (ms epoch). Omit on a running checkpoint to show a live clock. */
  at?: number;
  /** Files changed since the previous checkpoint. */
  files?: number;
  /** Retry count; 2+ shows an `Attempt N` chip. */
  attempt?: number;
}

interface AgentCheckpointsLabels {
  /** Header summary count. */
  count: (count: number) => string;
  /** Accessible name of the head row. */
  current: (label: string) => string;
  /** Accessible name of a row that can be rewound to. */
  rewindHint: (label: string) => string;
  attempt: (attempt: number) => string;
  failed: string;
  files: (count: number) => string;
  stopped: string;
  rewind: string;
}

const defaultLabels: AgentCheckpointsLabels = {
  count: (n) => `${n} ${n === 1 ? 'checkpoint' : 'checkpoints'}`,
  current: (label) => `${label}, current`,
  rewindHint: (label) => `${label} – press Enter to rewind here`,
  attempt: (n) => `Attempt ${n}`,
  failed: 'Failed',
  files: (n) => `${n} ${n === 1 ? 'file' : 'files'}`,
  stopped: 'Stopped',
  rewind: 'Rewind',
};

interface AgentCheckpointsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Oldest first. */
  checkpoints: AgentCheckpoint[];
  /** Run start (ms epoch); elapsed times count from here. */
  startedAt: number;
  /** Header title. */
  title?: ReactNode;
  /** The task the run works on, shown muted after the title. */
  task?: ReactNode;
  /** Run cost so far, appended to the header summary. */
  cost?: number;
  /** The checkpoint the workspace is at, as the host reports it. Defaults to
   *  the last checkpoint. A rewind never moves it by itself. */
  head?: string;
  /** Called with the checkpoint id when the user asks to rewind to it. Omit to
   *  hide Rewind. */
  onRewind?: (id: string) => void;
  /** Rows shown before the lane scrolls. */
  maxRows?: number;
  /** Shown when there are no checkpoints. */
  emptyLabel?: ReactNode;
  /** Density for the whole lane; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
  /** Localized row names, chips and counts; the source English is the default. */
  labels?: Partial<AgentCheckpointsLabels>;
}

const ROW = 36;
const GUTTER = 38;
const RAIL_X = 19;

const AgentCheckpointsBody = forwardRef<HTMLDivElement, Omit<AgentCheckpointsProps, 'size'>>(
  (
    {
      checkpoints,
      startedAt,
      title = 'Checkpoints',
      task,
      cost,
      head: headProp,
      onRewind,
      maxRows = 6,
      emptyLabel = 'No checkpoints yet',
      labels: labelOverrides,
      className,
      ...props
    },
    ref,
  ) => {
    const labels = { ...defaultLabels, ...labelOverrides };
    const icons = useIcons();
    const size = useSize();
    const shape = useShape();
    const titleId = useId();
    const headId = headProp ?? checkpoints[checkpoints.length - 1]?.id;
    const headIndex = Math.max(
      0,
      checkpoints.findIndex((c) => c.id === headId),
    );
    const anyRunning = checkpoints.some((c) => c.status === 'running' && c.at === undefined);
    const now = useNow(1000, anyRunning);

    const listRef = useRef<HTMLOListElement>(null);
    const hover = useFluidHover(listRef);
    const scrolls = checkpoints.length > maxRows;
    const Mark = icons['rotate-ccw'];

    const count = checkpoints.length;
    const summary = [labels.count(count), cost !== undefined ? formatCost(cost) : null]
      .filter(Boolean)
      .join(' · ');

    return (
      <div ref={ref} className={cn('@container min-w-0', className)} {...props}>
        <header className="flex min-w-0 items-center gap-2 pt-3 pr-4 pb-1.5 pl-3.5">
          <span className="grid w-4 shrink-0 place-items-center text-muted-foreground" aria-hidden>
            <Mark size={14} strokeWidth={1.5} />
          </span>
          <span
            id={titleId}
            className={cn(size.type.body, 'min-w-0 truncate text-foreground')}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {title}
          </span>
          {task !== undefined && (
            <span
              className={cn(
                size.type.body,
                'min-w-0 flex-1 truncate text-muted-foreground @max-[420px]:hidden',
              )}
            >
              {task}
            </span>
          )}
          <span
            className={cn(
              size.type.caption,
              'ml-auto shrink-0 whitespace-nowrap text-muted-foreground tabular-nums',
            )}
            aria-live="polite"
          >
            {summary}
          </span>
        </header>

        {count === 0 ? (
          <p className={cn(size.type.body, 'm-0 px-4 py-7 text-center text-muted-foreground')}>
            {emptyLabel}
          </p>
        ) : (
          <div
            className={cn('relative', scrolls && 'overflow-y-auto overscroll-contain')}
            style={{ maxHeight: maxRows * ROW + 10 }}
          >
            <ol
              ref={listRef}
              aria-labelledby={titleId}
              className="relative m-0 list-none p-0 pb-2.5"
              {...hover.handlers}
            >
              <FluidHoverHighlight hover={hover} className={cn(shape.bg, 'bg-hover')} />
              {checkpoints.map((c, i) => (
                <CheckpointRow
                  key={c.id}
                  index={i}
                  register={hover.registerItem}
                  checkpoint={c}
                  elapsed={formatClock((c.at ?? now) - startedAt)}
                  live={i <= headIndex}
                  isHead={i === headIndex}
                  isFirst={i === 0}
                  isLast={i === count - 1}
                  nextLive={i + 1 <= headIndex}
                  onRewind={onRewind}
                  labels={labels}
                />
              ))}
            </ol>
          </div>
        )}
      </div>
    );
  },
);
AgentCheckpointsBody.displayName = 'AgentCheckpointsBody';

/** A run's checkpoint lane on a vertical rail, with hover/Enter to ask for a rewind. */
const AgentCheckpoints = forwardRef<HTMLDivElement, AgentCheckpointsProps>(
  ({ size, ...props }, ref) => (
    <SizeScope size={size}>
      <AgentCheckpointsBody ref={ref} {...props} />
    </SizeScope>
  ),
);
AgentCheckpoints.displayName = 'AgentCheckpoints';

interface CheckpointRowProps {
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  checkpoint: AgentCheckpoint;
  elapsed: string;
  live: boolean;
  isHead: boolean;
  isFirst: boolean;
  isLast: boolean;
  nextLive: boolean;
  onRewind?: (id: string) => void;
  labels: AgentCheckpointsLabels;
}

function CheckpointRow({
  index,
  register,
  checkpoint: c,
  elapsed,
  live,
  isHead,
  isFirst,
  isLast,
  nextLive,
  onRewind,
  labels,
}: CheckpointRowProps) {
  const ref = useRef<HTMLLIElement>(null);
  useRegisterFluidHoverItem(register, index, ref);
  const icons = useIcons();
  const size = useSize();
  const shape = useShape();
  const FileIcon = icons.pencil;
  const canRewind = !isHead && onRewind !== undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (canRewind && e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      onRewind?.(c.id);
    }
  };

  const dimmed = live ? '' : 'opacity-50 group-hover:opacity-80 group-focus-visible:opacity-80';
  const nameTone = c.status === 'stopped' ? 'text-muted-foreground' : 'text-foreground';

  return (
    <motion.li
      ref={ref}
      data-fluid-hover-index={index}
      data-status={c.status}
      data-head={isHead || undefined}
      data-live={live || undefined}
      aria-current={isHead ? 'step' : undefined}
      aria-label={
        isHead ? labels.current(c.label) : canRewind ? labels.rewindHint(c.label) : c.label
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.moderate}
      className={cn('group relative z-10 flex items-center gap-2 pr-3.5', focusRingInset)}
      style={{ height: ROW, paddingLeft: GUTTER }}
    >
      <Rail first={isFirst} last={isLast} live={live} nextLive={nextLive} head={isHead} />

      <Elevated
        offset={1}
        aria-hidden
        className={cn('-mr-px grid size-[18px] shrink-0 place-items-center', shape.chip, dimmed)}
      >
        <AgentStatusIcon status={c.status} size={12} />
      </Elevated>

      <span
        className={cn(
          size.type.body,
          'min-w-0 truncate',
          c.status === 'running' ? 'shimmer-text' : nameTone,
          dimmed,
        )}
        style={isHead ? { fontVariationSettings: fontWeights.semibold } : undefined}
      >
        {c.label}
      </span>

      {c.attempt !== undefined && c.attempt > 1 && (
        <Badge color="gray" className={cn('shrink-0', dimmed)}>
          {labels.attempt(c.attempt)}
        </Badge>
      )}
      {c.status === 'failed' && (
        <Badge color="red" className={cn('shrink-0', dimmed)}>
          {labels.failed}
        </Badge>
      )}

      <span
        className={cn(
          size.type.caption,
          'ml-auto flex shrink-0 items-center gap-2.5 whitespace-nowrap text-muted-foreground tabular-nums transition-opacity duration-160',
          canRewind && 'group-hover:opacity-0 group-focus-visible:opacity-0',
          !live && 'opacity-50',
        )}
      >
        {c.files !== undefined && c.files > 0 && (
          <span className="flex items-center gap-1 @max-[420px]:hidden">
            <FileIcon size={12} strokeWidth={1.5} aria-hidden />
            {labels.files(c.files)}
          </span>
        )}
        {c.status === 'stopped' && <span>{labels.stopped}</span>}
        <span>{elapsed}</span>
      </span>

      {canRewind && (
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 scale-95 opacity-0 transition-[opacity,transform] duration-160 group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:scale-100 group-focus-visible:opacity-100">
          <Button
            variant="secondary"
            size="compact"
            leadingIcon={icons['rotate-ccw']}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onRewind?.(c.id);
            }}
          >
            {labels.rewind}
          </Button>
        </span>
      )}
    </motion.li>
  );
}

/** The gutter: line segments to the neighbours and the checkpoint dot. */
function Rail({
  first,
  last,
  live,
  nextLive,
  head,
}: {
  first: boolean;
  last: boolean;
  live: boolean;
  nextLive: boolean;
  head: boolean;
}) {
  const half = ROW / 2;
  const on = 'var(--emphasis)';
  const off = 'var(--border)';
  return (
    <svg
      aria-hidden
      width={GUTTER}
      height={ROW}
      className="pointer-events-none absolute top-0 left-0"
      fill="none"
    >
      {!first && (
        <motion.line
          x1={RAIL_X}
          x2={RAIL_X}
          y1={0}
          y2={half - 5}
          stroke={live ? on : off}
          strokeWidth={1.5}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={spring.moderate}
        />
      )}
      {!last && (
        <motion.line
          x1={RAIL_X}
          x2={RAIL_X}
          y1={half + 5}
          y2={ROW}
          stroke={nextLive ? on : off}
          strokeWidth={1.5}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={spring.moderate}
        />
      )}
      <motion.circle
        cx={RAIL_X}
        cy={half}
        r={head ? 4.5 : 3.5}
        strokeWidth={1.5}
        style={{
          fill: live ? on : 'var(--background)',
          stroke: live ? 'var(--background)' : off,
          opacity: live && !head ? 0.55 : 1,
          transformBox: 'fill-box',
          transformOrigin: 'center',
        }}
        initial={{ scale: 0.4 }}
        animate={{ scale: 1 }}
        transition={spring.fast}
      />
    </svg>
  );
}

export type { AgentCheckpoint, AgentCheckpointsLabels, AgentCheckpointsProps };
export { AgentCheckpoints };
