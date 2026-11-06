'use client';

// Steering card for a running agent: the plan with per-step status and
// durations, messages queued for the next step, and a compose box
// (↵ queues for the next step, Ctrl/⌘ ↵ interrupts now).

import { AnimatePresence, motion } from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useState,
} from 'react';
import { useNow } from '../../hooks/use-now.ts';
import { formatDuration, formatLatency } from '../../lib/agent-format.ts';
import { focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import {
  AgentCard,
  type AgentMark,
  AgentStatusIcon,
  Keycap,
  LiveDot,
  MetaDot,
  resolveMark,
  SizeScope,
} from './agent-primitives.tsx';

export type SteeringRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'done'
  | 'failed'
  | 'stopped';
export type SteerStepStatus = 'done' | 'active' | 'pending';

export interface SteerStep {
  id: string;
  title: string;
  status: SteerStepStatus;
  /** Finished duration (done steps). */
  durationMs?: number;
  /** Epoch ms the active step started; drives a live counter. */
  startedAt?: number;
  /** Steer messages that landed on this step. */
  notes?: SteerNote[];
}

export interface SteerNote {
  id: string;
  text: string;
  /** `next` = applied at the step boundary; `now` = interrupted mid-step. */
  mode: 'next' | 'now';
  /** Just arrived: flashes once. */
  landed?: boolean;
}

export interface SteerMessage {
  id: string;
  text: string;
  /** The host's committed delivery state; this is not an optimistic applied label. */
  status?: ReactNode;
  /** Receipt or request evidence, rendered separately from the instruction. */
  detail?: ReactNode;
  domId?: string;
}

export interface AgentSteeringLabels {
  activity: string;
  plan: string;
  steps: (current: number, total: number) => string;
  queued: string;
  pause: string;
  resume: string;
  now: string;
  remove: (text: string) => string;
  instruction: string;
  placeholder: string;
  send: string;
  nextHint: string;
  interruptHint: string;
  steered: string;
  interrupted: string;
  queuedAnnouncement: (text: string) => string;
  interruptAnnouncement: (text: string) => string;
}

const defaultLabels: AgentSteeringLabels = {
  activity: 'Activity',
  plan: 'Plan',
  steps: (current, total) => `Step ${current} of ${total}`,
  queued: 'Queued for the next step',
  pause: 'Pause the run',
  resume: 'Resume the run',
  now: 'Now',
  remove: (text) => `Remove “${text}”`,
  instruction: 'Steer the agent',
  placeholder: 'Steer the agent…',
  send: 'Queue for the next step',
  nextHint: 'next step',
  interruptHint: 'interrupt now',
  steered: 'Steered',
  interrupted: 'Interrupted',
  queuedAnnouncement: (text) => `Queued for the next step: ${text}`,
  interruptAnnouncement: (text) => `Interrupting now: ${text}`,
};

export interface AgentSteeringProps extends HTMLAttributes<HTMLDivElement> {
  /** Run title, e.g. `Migrate users table`. */
  title: string;
  /** Agent or model name shown under the title. */
  agent: string;
  /** Header mark. Defaults to the spark logo. */
  mark?: AgentMark;
  /** Omit when the host has not observed a status yet. */
  status?: SteeringRunStatus;
  statusLabel?: string;
  /** Replaces the source model/step subtitle without changing the header layout. */
  subtitle?: ReactNode;
  steps: SteerStep[];
  /** Host-owned plan disclosure; replaces only the default plan list. */
  planSlot?: ReactNode;
  /** Epoch ms the run (re)started; live while running. */
  startedAt?: number;
  /** Elapsed time accumulated before `startedAt` (or the total when paused/done). */
  elapsedMs?: number;
  /** Messages queued for the next step (controlled). */
  queued: SteerMessage[];
  /** ↵ or the send button: queue text for the next step. */
  onQueue?: (text: string) => void;
  /** Ctrl/⌘ ↵: interrupt the current step with this text. */
  onInterrupt?: (text: string) => void;
  /** "Now" on a queued chip. */
  onSendNow?: (id: string) => void;
  /** × on a queued chip. */
  onRemove?: (id: string) => void;
  /** Header pause/resume button. */
  onPauseToggle?: () => void;
  /** Host-owned input and actions. When present, no source textarea or shortcut is mounted. */
  compose?: ReactNode;
  /** Scoped host actions, such as a confirmed whole-Run stop control. */
  headerActions?: ReactNode;
  /** Optional host constraint; only plan, activity and instructions scroll, never the composer. */
  activityMaxHeight?: CSSProperties['maxHeight'];
  /** Content for an empty instruction list; omitted, the empty list stays hidden. */
  emptyQueued?: ReactNode;
  queueFooter?: ReactNode;
  labels?: Partial<AgentSteeringLabels>;
  /** Density for the whole card; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
}

const STATE_COLOR: Record<SteeringRunStatus, string> = {
  queued: 'var(--muted-foreground)',
  running: 'var(--emphasis)',
  waiting: 'var(--warning)',
  paused: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--destructive)',
  stopped: 'var(--muted-foreground)',
};
const STATE_LABEL: Record<SteeringRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs you',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

export interface AgentSteeringPlanProps {
  steps: SteerStep[];
  status?: SteeringRunStatus;
  labels?: Partial<AgentSteeringLabels>;
  /** Host accessibility label for the recorded item state. */
  statusLabel?: (status: SteerStepStatus) => string;
  /** Allow complete plan titles to wrap in a constrained composer. */
  wrapTitles?: boolean;
  className?: string;
}

/** The source steering plan rows, reusable inside a host-owned plan disclosure. */
export function AgentSteeringPlan({
  steps,
  status,
  labels: labelOverrides,
  statusLabel,
  wrapTitles = false,
  className,
}: AgentSteeringPlanProps) {
  const shape = useShape();
  const size = useSize();
  const icons = useIcons();
  const CornerIcon = icons['corner-down-right'];
  const labels = { ...defaultLabels, ...labelOverrides };
  const now = useNow(
    1000,
    status === 'running' &&
      steps.some((step) => step.status === 'active' && step.startedAt !== undefined),
  );
  const semi = { fontVariationSettings: fontWeights.semibold };
  return steps.length > 0 ? (
    <ol aria-label={labels.plan} className={cn('grid gap-0.5 px-3.5 pb-3', className)}>
      {steps.map((s) => {
        const time =
          s.status === 'done' && s.durationMs !== undefined
            ? formatLatency(s.durationMs)
            : s.status === 'active' && s.startedAt
              ? formatLatency(Math.max(0, now - s.startedAt))
              : '';
        return (
          <li
            key={s.id}
            data-status={s.status}
            data-plan-item={s.id}
            aria-current={s.status === 'active' ? 'step' : undefined}
          >
            <div className="flex min-h-7 items-center gap-2.5">
              <span className="grid w-4 shrink-0 place-items-center text-muted-foreground">
                <AgentStatusIcon
                  status={
                    s.status === 'done'
                      ? 'done'
                      : s.status === 'active'
                        ? status === 'running'
                          ? 'running'
                          : 'waiting'
                        : 'queued'
                  }
                  colored={s.status !== 'pending'}
                />
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1',
                  wrapTitles ? 'whitespace-normal break-words' : 'truncate',
                  size.type.body,
                  s.status === 'active' && status === 'running'
                    ? 'shimmer-text'
                    : s.status === 'pending'
                      ? 'text-muted-foreground'
                      : 'text-foreground',
                )}
                style={s.status === 'active' ? semi : undefined}
              >
                {s.title}
                {statusLabel ? <span className="sr-only"> · {statusLabel(s.status)}</span> : null}
              </span>
              <span
                className={cn('shrink-0 tabular-nums text-muted-foreground', size.type.caption)}
              >
                {time}
              </span>
            </div>
            {s.notes?.map((n) => (
              <div
                key={n.id}
                className={cn(
                  'relative mt-1 mb-0.5 ml-[26px] flex items-start gap-1.5 overflow-hidden bg-muted py-1 pr-2 pl-1.5 text-foreground',
                  shape.item,
                  size.type.caption,
                )}
              >
                {n.landed && (
                  <motion.span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 bg-selected"
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0 }}
                    transition={{ ...spring.slow, delay: 0.4 }}
                  />
                )}
                <CornerIcon
                  className="relative mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  strokeWidth={1.5}
                  aria-hidden
                />
                <span className="relative min-w-0 flex-1 whitespace-pre-line [overflow-wrap:anywhere]">
                  {n.text}
                </span>
                <span
                  className="relative shrink-0 whitespace-nowrap"
                  style={{ ...semi, color: 'var(--emphasis)' }}
                >
                  {n.mode === 'now' ? labels.interrupted : labels.steered}
                </span>
              </div>
            ))}
          </li>
        );
      })}
    </ol>
  ) : null;
}

const AgentSteeringBody = forwardRef<HTMLDivElement, Omit<AgentSteeringProps, 'size'>>(
  (
    {
      title,
      agent,
      mark = 'spark',
      status,
      statusLabel,
      subtitle,
      steps,
      planSlot,
      startedAt,
      elapsedMs,
      queued,
      onQueue,
      onInterrupt,
      onSendNow,
      onRemove,
      onPauseToggle,
      compose,
      headerActions,
      activityMaxHeight,
      emptyQueued,
      queueFooter,
      children,
      labels: labelOverrides,
      className,
      ...props
    },
    ref,
  ) => {
    const shape = useShape();
    const size = useSize();
    const icons = useIcons();
    const now = useNow(1000, status === 'running' && startedAt !== undefined);
    const Mark = resolveMark(mark);
    const hintId = useId();
    const [draft, setDraft] = useState('');
    const [announce, setAnnounce] = useState('');
    const elapsed =
      (elapsedMs ?? 0) + (status === 'running' && startedAt !== undefined ? now - startedAt : 0);
    const hasTime = elapsedMs !== undefined || startedAt !== undefined;
    const color = STATE_COLOR[status ?? 'queued'];
    const stateLabel = statusLabel ?? (status ? STATE_LABEL[status] : null);
    const labels = { ...defaultLabels, ...labelOverrides };
    const activeIndex = steps.findIndex((s) => s.status === 'active');
    const semi = { fontVariationSettings: fontWeights.semibold };

    const submit = (interrupt: boolean) => {
      const text = draft.trim();
      if (!text) return;
      if (interrupt) {
        if (!onInterrupt) return;
        onInterrupt(text);
        setAnnounce(labels.interruptAnnouncement(text));
      } else {
        if (!onQueue) return;
        onQueue(text);
        setAnnounce(labels.queuedAnnouncement(text));
      }
      setDraft('');
    };
    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        submit(e.ctrlKey || e.metaKey);
      }
    };
    const disabled = status === 'done';

    return (
      <div ref={ref} className={cn('relative', className)} data-status={status} {...props}>
        <AgentCard>
          <header className="flex min-w-0 items-center gap-2.5 py-3 pr-3 pl-3.5">
            <span className="grid w-4 shrink-0 place-items-center" style={{ color }} aria-hidden>
              {Mark && <Mark className="size-4" />}
            </span>
            <div className="grid min-w-0 flex-1">
              <span className={cn('truncate text-foreground', size.type.body)} style={semi}>
                {title}
              </span>
              <span
                className={cn('flex items-center gap-1.5 text-muted-foreground', size.type.caption)}
              >
                {subtitle ?? (
                  <>
                    <span>{agent}</span>
                    {steps.length > 0 ? (
                      <>
                        <MetaDot />
                        <span>
                          {labels.steps(Math.max(1, activeIndex + 1 || steps.length), steps.length)}
                        </span>
                      </>
                    ) : null}
                  </>
                )}
              </span>
            </div>
            {stateLabel || hasTime ? (
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-2 whitespace-nowrap tabular-nums text-muted-foreground',
                  size.type.caption,
                )}
              >
                {stateLabel ? (
                  <>
                    <LiveDot color={color} live={status === 'running'} />
                    {stateLabel}
                  </>
                ) : null}
                {hasTime ? (
                  <>
                    {stateLabel ? ' · ' : ''}
                    {formatDuration(elapsed)}
                  </>
                ) : null}
              </span>
            ) : null}
            {headerActions}
            {onPauseToggle && (status === 'running' || status === 'paused') && (
              <Button
                variant="secondary"
                size="compact"
                leadingIcon={status === 'running' ? icons.pause : icons.play}
                aria-label={status === 'running' ? labels.pause : labels.resume}
                onClick={onPauseToggle}
              />
            )}
          </header>

          <section
            data-slot="agent-steering-activity"
            aria-label={labels.activity}
            tabIndex={activityMaxHeight ? 0 : undefined}
            className={
              activityMaxHeight
                ? cn('overflow-y-auto overscroll-contain', focusRingInset)
                : undefined
            }
            style={activityMaxHeight ? { maxHeight: activityMaxHeight } : undefined}
          >
            {planSlot !== undefined ? (
              planSlot
            ) : (
              <AgentSteeringPlan steps={steps} status={status} labels={labels} />
            )}

            {children}

            {(queued.length > 0 || emptyQueued || queueFooter) && (
              <div className="border-t border-border px-3.5 pt-2.5 pb-0.5">
                <div
                  className={cn(
                    'mb-1.5 flex items-center gap-1.5 text-muted-foreground',
                    size.type.caption,
                  )}
                >
                  {labels.queued}
                  <span
                    className={cn(
                      'grid h-4 min-w-4 place-items-center bg-muted px-1 tabular-nums text-foreground',
                      shape.chip,
                    )}
                  >
                    {queued.length}
                  </span>
                </div>
                {queued.length > 0 ? (
                  <ul className="grid gap-1.5">
                    <AnimatePresence initial={false}>
                      {queued.map((q) => (
                        <motion.li
                          key={q.id}
                          id={q.domId}
                          layout
                          initial={{ opacity: 0, scale: 0.96 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.96, transition: spring.fast.exit }}
                          transition={spring.moderate}
                          className={cn(
                            'relative flex min-h-8 items-center gap-1.5 border border-border py-1 pr-1 pl-2.5',
                            shape.item,
                          )}
                        >
                          <span
                            aria-hidden
                            className="absolute top-2 bottom-2 left-0 w-0.5 rounded-r"
                            style={{ backgroundColor: 'var(--emphasis)' }}
                          />
                          <div
                            className={cn(
                              'grid min-w-0 flex-1 gap-1 whitespace-pre-line text-foreground [overflow-wrap:anywhere]',
                              size.type.caption,
                            )}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <span className="min-w-0 flex-1">{q.text}</span>
                              {q.status}
                            </div>
                            {q.detail}
                          </div>
                          {onSendNow ? (
                            <Button
                              variant="ghost"
                              size="compact"
                              leadingIcon={icons['skip-forward']}
                              onClick={() => onSendNow?.(q.id)}
                            >
                              {labels.now}
                            </Button>
                          ) : null}
                          {onRemove ? (
                            <Button
                              variant="ghost"
                              size="compact"
                              leadingIcon={icons.x}
                              aria-label={labels.remove(q.text)}
                              onClick={() => onRemove?.(q.id)}
                            />
                          ) : null}
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                ) : (
                  emptyQueued
                )}
                {queueFooter}
              </div>
            )}
          </section>

          {compose !== undefined ? (
            compose
          ) : onQueue || onInterrupt ? (
            <div
              className="mt-2.5 border-t border-border py-2.5 pr-3 pl-3.5"
              data-disabled={disabled || undefined}
            >
              <div className={cn('flex items-end gap-2', disabled && 'opacity-60')}>
                <textarea
                  aria-label={labels.instruction}
                  aria-describedby={hintId}
                  placeholder={labels.placeholder}
                  rows={1}
                  disabled={disabled}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKey}
                  className={cn(
                    'my-1 min-w-0 flex-1 resize-none border-0 bg-transparent p-0 text-foreground outline-none placeholder:text-muted-foreground',
                    size.field,
                  )}
                />
                <Button
                  size="compact"
                  leadingIcon={icons['arrow-up']}
                  aria-label={labels.send}
                  disabled={disabled || !draft.trim() || !onQueue}
                  onClick={() => submit(false)}
                />
              </div>
              <div
                id={hintId}
                className={cn(
                  'mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-muted-foreground',
                  size.type.caption,
                )}
              >
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Keycap>↵</Keycap> {labels.nextHint}
                </span>
                {onInterrupt ? (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <Keycap>Ctrl</Keycap>
                    <Keycap>↵</Keycap> {labels.interruptHint}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </AgentCard>
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
      </div>
    );
  },
);
AgentSteeringBody.displayName = 'AgentSteeringBody';

/** Steering card for a running agent: plan, queued steers, and a compose box. */
export const AgentSteering = forwardRef<HTMLDivElement, AgentSteeringProps>(
  ({ size, ...props }, ref) => (
    <SizeScope size={size}>
      <AgentSteeringBody ref={ref} {...props} />
    </SizeScope>
  ),
);
AgentSteering.displayName = 'AgentSteering';
