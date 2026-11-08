'use client';

// Planned vs actual timeline for one task: Time/Cost counters, a verdict
// badge, axis ticks, the plan (dashed ghost) against actual and forecast bars
// per step, plan finish vs ETA markers, and a legend. Elapsed values derive
// from `startedAt` + `useNow`.

import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useId,
  useRef,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { useNow } from '../../hooks/use-now.ts';
import { formatClock, formatCost, formatDuration } from '../../lib/agent-format.ts';
import { focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { FluidHoverHighlight } from '../ui/fluid-hover-highlight.tsx';
import { AgentCard, type AgentStatus, AgentStatusIcon, SizeScope } from './agent-primitives.tsx';

interface PlanStep {
  id: string;
  label: string;
  /** `queued` = not started. */
  status: AgentStatus;
  /** Planned start, ms after the run start. Omitted on every step, the board shows actuals only. */
  planStart?: number;
  /** Planned duration in ms. Omitted on every step, the board shows actuals only. */
  planDuration?: number;
  /** Actual start, ms after the run start. */
  start?: number;
  /** Actual end, ms after the run start (done steps). */
  end?: number;
  cost?: number;
  /** Status word for the row's accessible name instead of the kit's default phrasing. */
  statusLabel?: string;
  /** Attributes for the row (ids, test hooks, data attributes). */
  rowProps?: Record<`data-${string}`, string | undefined>;
}

/** Words the board shows; every default is the kit's English text. */
interface PlanVsActualLabels {
  step: string;
  time: string;
  cost: string;
  onPlan: string;
  ahead: (duration: string) => string;
  over: (duration: string) => string;
  plan: string;
  eta: string;
  actual: string;
  overPlan: string;
  /** Accessible name of a step row on an actual-only board. */
  actualStep: (step: PlanStep, took: string | null) => string;
}

const defaultLabels: PlanVsActualLabels = {
  step: 'Step',
  time: 'Time',
  cost: 'Cost',
  onPlan: 'On plan',
  ahead: (duration) => `${duration} ahead`,
  over: (duration) => `${duration} over`,
  plan: 'Plan',
  eta: 'ETA',
  actual: 'Actual',
  overPlan: 'Over plan',
  actualStep: (step, took) =>
    took === null
      ? `${step.label}: ${step.statusLabel ?? step.status}`
      : `${step.label}: ${step.statusLabel ?? step.status}, ${took}`,
};

interface PlanVsActualProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  /** The task being tracked. */
  task?: ReactNode;
  steps: PlanStep[];
  /** Run start (epoch ms). */
  startedAt: number;
  /** Spent so far; omitted, the Cost counter is hidden. */
  cost?: number;
  /** Planned cost. */
  budget?: number;
  /** Fixed clock (epoch ms); omitted, ticks live while any step runs. */
  now?: number;
  /** Density step for the timeline and everything inside it. Omitted, follows the nearest `SizeProvider`. */
  size?: SizeVariant;
  /** Localized words; missing entries keep the kit's English. */
  labels?: Partial<PlanVsActualLabels>;
  /** Selected step (outlined). */
  selectedStepId?: string | null;
  /** Makes each started step a button that selects it; steps not yet started stay plain rows. */
  onSelectStep?: (stepId: string) => void;
}

const NICE = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000,
];
const pct = (v: number, range: number) => `${(v / range) * 100}%`;
const tint = (c: string, n: number) => `color-mix(in srgb, ${c} ${n}%, transparent)`;

const PlanVsActual = forwardRef<HTMLDivElement, PlanVsActualProps>(({ size, ...props }, ref) => (
  <SizeScope size={size}>
    <PlanVsActualInner ref={ref} {...props} />
  </SizeScope>
));
PlanVsActual.displayName = 'PlanVsActual';

const PlanVsActualInner = forwardRef<HTMLDivElement, Omit<PlanVsActualProps, 'size'>>(
  (
    {
      title = 'Plan vs actual',
      task,
      steps,
      startedAt,
      cost,
      budget,
      now: nowProp,
      labels: labelOverrides,
      selectedStepId = null,
      onSelectStep,
      className,
      ...props
    },
    ref,
  ) => {
    const size = useSize();
    const shape = useShape();
    const titleId = useId();
    const labels = { ...defaultLabels, ...labelOverrides };
    const listRef = useRef<HTMLDivElement>(null);
    const hover = useFluidHover(listRef);
    const live = nowProp === undefined && steps.some((s) => s.status === 'running');
    const liveNow = useNow(500, live);
    const elapsed = Math.max(0, (nowProp ?? liveNow) - startedAt);
    // A plan exists only when every step has one; actual-only boards drop every plan mark.
    const planned = steps.every((s) => s.planStart !== undefined && s.planDuration !== undefined);
    const planStart = (s: PlanStep) => s.planStart ?? 0;
    const planDuration = (s: PlanStep) => s.planDuration ?? 0;

    const planEnd = planned ? Math.max(...steps.map((s) => planStart(s) + planDuration(s)), 0) : 0;
    const projEnd = (s: PlanStep) =>
      s.end ??
      (s.start !== undefined
        ? planned
          ? Math.max(elapsed, s.start + planDuration(s))
          : elapsed
        : undefined);
    const drifts = steps.flatMap((s) => {
      const e = projEnd(s);
      return e === undefined ? [] : [e - (planStart(s) + planDuration(s))];
    });
    const drift = planned && drifts.length ? Math.max(...drifts) : 0;
    const eta = Math.max(
      ...steps.map((s) => projEnd(s) ?? planStart(s) + drift + planDuration(s)),
      elapsed,
    );
    const diff = eta - planEnd;
    const state = Math.abs(diff) < 1000 ? 'on' : diff < 0 ? 'early' : 'late';

    const raw = Math.max(planEnd, eta, elapsed) * (planned ? 1.25 : 1.15) || 60_000;
    const tick = NICE.find((n) => raw / n <= 8) ?? (NICE[NICE.length - 1] as number);
    const range = Math.ceil(raw / tick) * tick;
    const ticks = Array.from({ length: range / tick - 1 }, (_, i) => (i + 1) * tick);

    const actualColor = 'var(--emphasis)';
    const overColor = 'var(--destructive)';
    const lane = 'absolute top-0 bottom-0 left-[218px] right-4 pointer-events-none';
    const counters = [
      [
        labels.time,
        formatClock(elapsed),
        planned ? formatClock(planEnd) : null,
        planned && elapsed > planEnd,
      ],
      ...(cost !== undefined
        ? [
            [
              labels.cost,
              formatCost(cost),
              budget !== undefined ? formatCost(budget) : null,
              budget !== undefined && cost > budget,
            ] as const,
          ]
        : []),
    ] as const;

    return (
      <AgentCard ref={ref} className={cn(size.type.body, className)} {...props}>
        <header className="flex min-w-0 items-center gap-2 border-b border-border py-3 pr-3.5 pl-4">
          <span className="grid w-4 shrink-0 place-items-center text-emphasis">
            <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
              <rect x="1.5" y="2.5" width="7" height="3" rx="1.5" fill="currentColor" />
              <rect x="5" y="6.5" width="8" height="3" rx="1.5" fill="currentColor" opacity="0.6" />
              <rect
                x="8.5"
                y="10.5"
                width="6"
                height="3"
                rx="1.5"
                fill="currentColor"
                opacity="0.35"
              />
            </svg>
          </span>
          <span
            id={titleId}
            className="truncate text-foreground"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {title}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{task}</span>
          <dl
            className={cn(
              size.type.caption,
              'mr-1 flex shrink-0 items-center gap-3.5 tabular-nums',
            )}
          >
            {counters.map(([k, v, of, over]) => (
              <div key={k} className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className={over ? 'text-destructive' : 'text-foreground'}>
                  <b
                    className={cn(k === labels.time && live && !over && 'shimmer-text')}
                    style={{ fontVariationSettings: fontWeights.semibold }}
                  >
                    {v}
                  </b>
                  {of !== null ? <span className="text-muted-foreground"> / {of}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          {planned ? (
            <Badge
              color={state === 'early' ? 'green' : state === 'late' ? 'red' : 'gray'}
              className="tabular-nums"
            >
              {state === 'on'
                ? labels.onPlan
                : state === 'early'
                  ? labels.ahead(formatDuration(Math.abs(diff)))
                  : labels.over(formatDuration(Math.abs(diff)))}
            </Badge>
          ) : null}
        </header>

        {/* biome-ignore lint/a11y/useSemanticElements: the list also holds the hover layer, axis and header row, which a native list cannot contain. */}
        <div
          ref={listRef}
          className={cn('relative', !planned && 'pb-2')}
          role="list"
          aria-labelledby={titleId}
          {...hover.handlers}
        >
          <FluidHoverHighlight hover={hover} className="bg-hover" />
          <div className={lane}>
            {ticks.map((v) => (
              <span
                key={v}
                className={cn('absolute top-0 w-px bg-border', planned ? 'bottom-10' : 'bottom-2')}
                style={{ left: pct(v, range) }}
              >
                <span
                  className={cn(
                    size.type.caption,
                    'absolute top-[7px] left-1.5 whitespace-nowrap text-muted-foreground tabular-nums',
                  )}
                >
                  {formatClock(v)}
                </span>
              </span>
            ))}
            {planned && state !== 'on' && (
              <span
                className="absolute top-[30px] bottom-10"
                style={{
                  left: pct(Math.min(eta, planEnd), range),
                  width: pct(Math.abs(diff), range),
                  background: tint(state === 'early' ? 'var(--success)' : overColor, 10),
                }}
              />
            )}
            {planned &&
              (
                [
                  [
                    labels.plan,
                    planEnd,
                    'border-dashed border-muted-foreground',
                    eta < planEnd ? 'left-1' : 'right-1',
                  ],
                  [labels.eta, eta, 'border-solid', eta < planEnd ? 'right-1' : 'left-1'],
                ] as const
              ).map(([k, v, line, side]) => (
                <span
                  key={k}
                  className={cn('absolute top-[30px] bottom-[34px] w-0 border-l', line)}
                  style={{
                    left: pct(v, range),
                    borderColor:
                      k === labels.eta
                        ? state === 'late'
                          ? overColor
                          : 'var(--success)'
                        : undefined,
                  }}
                >
                  <span
                    className={cn(
                      size.type.caption,
                      'absolute -bottom-6 whitespace-nowrap text-muted-foreground tabular-nums',
                      side,
                    )}
                  >
                    {k} {formatClock(v)}
                  </span>
                </span>
              ))}
            {planned || live ? (
              <span
                className={cn(
                  'absolute top-[30px] w-px bg-emphasis',
                  planned ? 'bottom-10' : 'bottom-2',
                )}
                style={{ left: pct(elapsed, range) }}
              >
                <span className="absolute -top-[2.5px] -left-[2px] size-[5px] rounded-full bg-emphasis" />
              </span>
            ) : null}
          </div>

          <div
            className={cn(
              size.type.caption,
              'flex h-[30px] items-center border-b border-border pl-4 text-muted-foreground',
            )}
          >
            {labels.step}
          </div>

          {steps.map((s, i) => {
            const actualEnd = s.end ?? (s.start !== undefined ? elapsed : undefined);
            const took =
              s.start !== undefined && actualEnd !== undefined ? actualEnd - s.start : undefined;
            const overAt = planned && s.start !== undefined ? s.start + planDuration(s) : undefined;
            const isOver = planned && took !== undefined && took > planDuration(s);
            const forecastStart = s.status === 'running' ? elapsed : planStart(s) + drift;
            const forecastEnd =
              s.status === 'running' ? (projEnd(s) ?? elapsed) : forecastStart + planDuration(s);
            const tagAt = planned
              ? Math.max(planStart(s) + planDuration(s), actualEnd ?? forecastEnd)
              : (actualEnd ?? 0);
            const delta = took !== undefined ? took - planDuration(s) : 0;
            const label = !planned
              ? labels.actualStep(s, took !== undefined ? formatClock(took) : null)
              : s.status === 'done'
                ? `${s.label}: took ${formatClock(took ?? 0)}, planned ${formatClock(planDuration(s))}${s.cost !== undefined ? `, ${formatCost(s.cost)}` : ''}`
                : s.status === 'running'
                  ? `${s.label}: running for ${formatClock(took ?? 0)} of ${formatClock(planDuration(s))} planned${s.cost !== undefined ? `, ${formatCost(s.cost)}` : ''}`
                  : `${s.label}: starts in about ${formatClock(Math.max(0, forecastStart - elapsed))}`;
            const selectable = Boolean(onSelectStep) && s.start !== undefined;
            const selected = selectedStepId === s.id;
            return (
              <StepRow
                key={s.id}
                index={i}
                register={hover.registerItem}
                {...(selectable ? { focusable: false } : { 'aria-label': label })}
                data-status={s.status}
                {...s.rowProps}
              >
                {selectable && (
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={selected}
                    className={cn('absolute inset-0 z-[1]', focusRingInset)}
                    onClick={() => onSelectStep?.(s.id)}
                  />
                )}
                <span className="flex min-w-0 items-center gap-2">
                  <AgentStatusIcon status={s.status} size={14} />
                  <span
                    className={cn(
                      'truncate',
                      s.status === 'queued' ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {s.label}
                  </span>
                </span>
                <span className="relative h-8 min-w-0" aria-hidden>
                  {planned && (s.status === 'running' || s.status === 'queued') && (
                    <Bar
                      from={forecastStart}
                      to={forecastEnd}
                      range={range}
                      color="var(--muted-foreground)"
                      fill={12}
                    />
                  )}
                  {s.start !== undefined && actualEnd !== undefined && (
                    <Bar
                      from={s.start}
                      to={isOver && overAt !== undefined ? overAt : actualEnd}
                      range={range}
                      color={actualColor}
                      fill={16}
                      live={s.status === 'running' && live && !isOver}
                      selected={selected}
                    />
                  )}
                  {isOver && overAt !== undefined && actualEnd !== undefined && (
                    <Bar
                      from={overAt}
                      to={actualEnd}
                      range={range}
                      color={overColor}
                      fill={16}
                      flatLeft
                      live={s.status === 'running' && live}
                    />
                  )}
                  {planned && (
                    <span
                      className="absolute top-[calc(50%-7px)] h-3.5 rounded border border-dashed border-muted-foreground"
                      style={{
                        left: pct(planStart(s), range),
                        width: pct(planDuration(s), range),
                      }}
                    />
                  )}
                  {planned || took !== undefined ? (
                    <span
                      className={cn(
                        size.type.caption,
                        'absolute top-[calc(50%-9px)] flex h-[18px] items-center gap-1 px-1 whitespace-nowrap tabular-nums',
                        s.status === 'queued' ? 'text-muted-foreground' : 'text-foreground',
                      )}
                      style={{ left: `calc(${pct(tagAt, range)} + 3px)` }}
                    >
                      {planned && s.status === 'queued'
                        ? formatClock(planDuration(s))
                        : formatClock(took ?? 0)}
                      {planned && s.status === 'done' && delta !== 0 && (
                        <span
                          className={cn('px-1', shape.chip)}
                          style={{
                            background: tint(delta < 0 ? 'var(--success)' : overColor, 16),
                            fontVariationSettings: fontWeights.semibold,
                          }}
                        >
                          {delta < 0 ? '−' : '+'}
                          {formatDuration(Math.abs(delta))}
                        </span>
                      )}
                    </span>
                  ) : null}
                </span>
              </StepRow>
            );
          })}

          {planned ? (
            <div
              className={cn(
                size.type.caption,
                'mt-1 flex h-10 items-center gap-3.5 border-t border-border pl-4 text-muted-foreground',
              )}
            >
              <Key className="border border-dashed border-muted-foreground">{labels.plan}</Key>
              <Key
                style={{
                  background: tint(actualColor, 16),
                  boxShadow: `inset 0 0 0 0.5px ${tint(actualColor, 40)}`,
                }}
              >
                {labels.actual}
              </Key>
              <Key
                style={{
                  background: tint(overColor, 16),
                  boxShadow: `inset 0 0 0 0.5px ${tint(overColor, 40)}`,
                }}
              >
                {labels.overPlan}
              </Key>
            </div>
          ) : null}
        </div>
      </AgentCard>
    );
  },
);
PlanVsActualInner.displayName = 'PlanVsActualInner';

/** One step row; focusable, and registered with the list's shared hover highlight. */
function StepRow({
  index,
  register,
  focusable = true,
  children,
  ...props
}: {
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  /** A selectable row is reached through its own button instead. */
  focusable?: boolean;
} & HTMLAttributes<HTMLDivElement> & {
    'data-status'?: string;
  }) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(register, index, ref);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of the list above, which cannot be a native list.
    <div
      ref={ref}
      role="listitem"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the source makes each step row focusable so its accessible summary can be read by keyboard.
      tabIndex={focusable ? 0 : undefined}
      data-fluid-hover-index={index}
      className={cn(
        'relative grid h-8 grid-cols-[188px_minmax(0,1fr)] gap-x-3.5 px-4',
        focusable && focusRingInset,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** A timeline bar; `live` sweeps a sheen across it while the step runs. */
function Bar({
  from,
  to,
  range,
  color,
  fill,
  flatLeft,
  live,
  selected,
}: {
  from: number;
  to: number;
  range: number;
  color: string;
  fill: number;
  flatLeft?: boolean;
  live?: boolean;
  /** Outlined with the kit's one accent, like a selected lane span. */
  selected?: boolean;
}) {
  return (
    <span
      className={cn('absolute top-[calc(50%-7px)] h-3.5 rounded', flatLeft && 'rounded-l-none')}
      style={{
        left: pct(from, range),
        width: `max(2px, ${pct(Math.max(0, to - from), range)})`,
        background: tint(color, fill),
        boxShadow: selected
          ? 'inset 0 0 0 1.5px var(--emphasis)'
          : `inset 0 0 0 0.5px ${tint(color, 40)}`,
      }}
    >
      {live && <span aria-hidden className="sheen block size-full rounded-[inherit]" />}
    </span>
  );
}

function Key({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('h-2 w-3.5 rounded-[2.5px]', className)} style={style} />
      {children}
    </span>
  );
}

export type { PlanStep, PlanVsActualLabels, PlanVsActualProps };
export { PlanVsActual };
