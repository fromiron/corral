'use client';

// A compact status pill for an ongoing agent session, sized for a header: the
// agent's mark inside a progress ring, the current tool glyph and activity, an
// elapsed clock, inline Deny / Approve while the agent needs you, and a
// disclosure that folds out the step list with run controls. State, label and
// steps come in as props; the clock derives from `startedAt` via `useNow`, so it
// keeps counting through an approval prompt. The pill springs to each label's
// width (Motion `layout`) while the label crossfades.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
} from 'react';
import { useControllable } from '../../hooks/use-controllable.ts';
import { useNow } from '../../hooks/use-now.ts';
import { formatClock, formatSpokenDuration, initials } from '../../lib/agent-format.ts';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { type IconComponent, useIcons } from '../../lib/icon-context.tsx';
import { nestedRadius, useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { loop, spring } from '../../lib/springs.ts';
import { surfaceClasses } from '../../lib/surface-classes.ts';
import { SurfaceProvider, useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import {
  AgentCard,
  type AgentMark,
  AgentStatusIcon,
  Collapse,
  DisclosureChevron,
  DrawnCheck,
  resolveMark,
  SizeScope,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Session state as the pill shows it. `waiting` means the agent needs the user
 * (inline Deny / Approve); `denied` means the user turned the request down.
 */
type AgentStatusPillState =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'done'
  | 'denied'
  | 'failed'
  | 'stopped';

/** State of one step in the fold-out list. */
type AgentStatusPillStepState = 'pending' | 'active' | 'waiting' | 'done' | 'denied';

interface AgentStatusPillStep {
  id: string;
  /** Past tense once done (`Read 12 files`), present while live (`Waiting for your approval to run git push`). */
  label: string;
  state: AgentStatusPillStepState;
}

/** What the toggle's accessible name is built from. */
interface AgentStatusPillToggleInfo {
  state: AgentStatusPillState;
  label: string;
  /** `detail` as text, when it is a string or a number. */
  detail?: string;
  /** Elapsed ms, when the clock shows. */
  elapsed?: number;
  open: boolean;
  panelTitle: string;
}

interface AgentStatusPillLabels {
  /** Visible activity while paused (`Paused · Reading 12 files`). */
  paused: (label: string) => string;
  /** The toggle's accessible name: state, activity, elapsed time and the panel action. */
  toggle: (info: AgentStatusPillToggleInfo) => string;
  /** Live announcement. `choices` holds the approval actions shown, if any. */
  announcement: (info: { state: AgentStatusPillState; label: string; choices: string[] }) => string;
  /** Accessible name of the panel. */
  panel: (name: string, panelTitle: string) => string;
  /** Step count beside the panel title. */
  stepCount: (done: number, total: number) => string;
  /** Beside the panel title when there are no steps. */
  noSteps: string;
  /** Accessible name of the step progress bar. */
  progress: (panelTitle: string) => string;
  /** Value text of the step progress bar. */
  progressValue: (done: number, total: number) => string;
  pause: string;
  resume: string;
  stop: string;
  openRun: string;
}

const defaultLabels: AgentStatusPillLabels = {
  paused: (label) => `Paused · ${label}`,
  toggle: ({ state, label, detail, elapsed, open, panelTitle }) => {
    const stateWord =
      state === 'paused'
        ? `Paused, ${label}`
        : state === 'done'
          ? `Done, ${label}`
          : state === 'failed'
            ? `Failed, ${label}`
            : detail
              ? `${label}, ${detail}`
              : label;
    return `${stateWord}.${elapsed !== undefined ? ` Elapsed ${formatSpokenDuration(elapsed)}.` : ''} ${open ? 'Hide' : 'Show'} ${panelTitle.toLowerCase()} details.`;
  },
  announcement: ({ state, label, choices }) =>
    state === 'paused'
      ? 'Paused. The timer stopped.'
      : state === 'done'
        ? `Done. ${label}.`
        : state === 'failed'
          ? `Failed. ${label}.`
          : choices.length
            ? `${label}. ${choices.join(' or ')} available.`
            : label,
  panel: (name, panelTitle) => `${name} ${panelTitle.toLowerCase()}`,
  stepCount: (done, total) => `${done} of ${total} steps`,
  noSteps: 'No steps yet',
  progress: (panelTitle) => `${panelTitle} progress`,
  progressValue: (done, total) => `${done} of ${total} steps done`,
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  openRun: 'Open run',
};

interface AgentStatusPillProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Agent name: the initials fallback for the disc and the panel's accessible name. */
  name?: string;
  /** Brand mark (`"claude"`) or icon inside the ring. Omitted, shows initials. */
  logo?: AgentMark;
  state: AgentStatusPillState;
  /** Current activity (`Reading 12 files`). Each new label crossfades and the pill springs to its width. */
  label: string;
  /** Trailing detail after the label (`8 of 12`). Updates in place: no crossfade and no announcement. */
  detail?: ReactNode;
  /** Tool glyph for the current activity. Done, denied, failed, stopped, and paused show their own glyph. */
  icon?: IconComponent;
  /** Session start (ms epoch). Drives the elapsed clock; omitted, the clock hides. */
  startedAt?: number;
  /** Session end, or the moment it paused (ms epoch); freezes the clock. Leave unset while waiting. */
  endedAt?: number;
  /** Steps in run order, listed in the fold-out panel with a progress bar. Without steps the panel shows no progress bar. */
  steps?: AgentStatusPillStep[];
  /** Panel heading. */
  panelTitle?: string;
  /** What the approval is for, completing the buttons' accessible names (`running git push` → "Approve running git push"). */
  approvalSubject?: string;
  approveLabel?: string;
  denyLabel?: string;
  /** Shown inline while `waiting`. Focus returns to the pill after a choice. */
  onApprove?: () => void;
  onDeny?: () => void;
  /** Panel run controls: Pause while running, Resume while paused, Stop until the run ends. */
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  /** Panel link to the full run view. */
  onOpenRun?: () => void;
  /** Panel expanded (controlled). Escape closes it. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Density step for this pill and its panel. Omitted, follows the nearest `SizeProvider`. */
  size?: SizeVariant;
  /** `false` drops the pill's own polite live region, for a host that already announces the run. */
  announce?: boolean;
  /** Localized names, announcements and panel text; the source English is the default. */
  labels?: Partial<AgentStatusPillLabels>;
}

// ─── State styling ───────────────────────────────────────────────────────────

const ringColor: Record<AgentStatusPillState, string> = {
  running: 'var(--emphasis)',
  waiting: 'var(--warning)',
  paused: 'var(--muted-foreground)',
  done: 'var(--success)',
  denied: 'var(--destructive)',
  failed: 'var(--destructive)',
  stopped: 'var(--muted-foreground)',
};

const glyphColor: Record<AgentStatusPillState, string> = {
  running: 'var(--muted-foreground)',
  waiting: 'var(--warning)',
  paused: 'var(--muted-foreground)',
  done: 'var(--success)',
  denied: 'var(--muted-foreground)',
  failed: 'var(--destructive)',
  stopped: 'var(--muted-foreground)',
};

const labelTone: Record<AgentStatusPillState, string> = {
  running: 'shimmer-text',
  waiting: 'text-foreground',
  paused: 'text-muted-foreground',
  done: 'text-foreground',
  denied: 'text-muted-foreground',
  failed: 'text-foreground',
  stopped: 'text-muted-foreground',
};

/** Pill edge: a hairline that only shows when the state asks for attention. */
const edgeColor: Record<AgentStatusPillState, string> = {
  running: 'transparent',
  waiting: 'color-mix(in srgb, var(--warning) 40%, var(--border))',
  paused: 'var(--border)',
  done: 'transparent',
  denied: 'color-mix(in srgb, var(--destructive) 40%, var(--border))',
  failed: 'color-mix(in srgb, var(--destructive) 40%, var(--border))',
  stopped: 'transparent',
};

const barColor: Record<AgentStatusPillState, string> = {
  running: 'var(--emphasis)',
  waiting: 'var(--emphasis)',
  paused: 'var(--muted-foreground)',
  done: 'var(--success)',
  denied: 'var(--destructive)',
  failed: 'var(--destructive)',
  stopped: 'var(--muted-foreground)',
};

const stepTone: Record<AgentStatusPillStepState, string> = {
  pending: 'text-muted-foreground',
  active: 'text-foreground',
  waiting: '',
  done: 'text-muted-foreground',
  denied: 'text-destructive',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A stable key per icon component, so a glyph swap crossfades only when the icon changes. */
const glyphIds = new WeakMap<object, number>();
let glyphSeq = 0;
function glyphKey(icon: IconComponent): number {
  let id = glyphIds.get(icon);
  if (id === undefined) {
    glyphSeq += 1;
    id = glyphSeq;
    glyphIds.set(icon, id);
  }
  return id;
}

// ─── Component ───────────────────────────────────────────────────────────────

const AgentStatusPill = forwardRef<HTMLDivElement, AgentStatusPillProps>(
  ({ size, ...props }, ref) => (
    <SizeScope size={size}>
      <AgentStatusPillInner ref={ref} {...props} />
    </SizeScope>
  ),
);
AgentStatusPill.displayName = 'AgentStatusPill';

const AgentStatusPillInner = forwardRef<HTMLDivElement, Omit<AgentStatusPillProps, 'size'>>(
  (
    {
      name = 'Agent',
      logo,
      state,
      label,
      detail,
      icon,
      startedAt,
      endedAt,
      steps = [],
      panelTitle = 'Activity',
      approvalSubject,
      approveLabel = 'Approve',
      denyLabel = 'Deny',
      onApprove,
      onDeny,
      onPause,
      onResume,
      onStop,
      onOpenRun,
      open: openProp,
      defaultOpen = false,
      onOpenChange,
      announce = true,
      labels: labelOverrides,
      className,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const labels = { ...defaultLabels, ...labelOverrides };
    const size = useSize();
    const shape = useShape();
    const icons = useIcons();
    const reduce = useReducedMotion() ?? false;
    const panelId = useId();
    const toggleRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const compact = size.variant === 'compact';

    const [open, setOpen] = useControllable(openProp, defaultOpen, onOpenChange);

    // ── Clock: one session timer, frozen by `endedAt` (pause or finish).
    const ticking = startedAt !== undefined && endedAt === undefined;
    const now = useNow(500, ticking);
    const elapsed = startedAt === undefined ? undefined : Math.max(0, (endedAt ?? now) - startedAt);

    // ── Surface: the pill is raised like a card on its substrate.
    const level = Math.min(useSurface() + 2, 8);
    const radius = shape.containerRadius;
    const innerRadius = nestedRadius(radius, 6);

    const discPx = compact ? 22 : 26;
    const glyphPx = compact ? 13 : 15;

    // ── Glyph: the state's own mark once the activity is no longer live.
    const Glyph: IconComponent | undefined =
      state === 'done'
        ? icons.check
        : state === 'denied'
          ? icons.x
          : state === 'failed'
            ? icons['alert-triangle']
            : state === 'stopped'
              ? icons.stop
              : state === 'paused'
                ? icons.pause
                : icon;

    const shownLabel = state === 'paused' ? labels.paused(label) : label;
    const detailText =
      typeof detail === 'string' || typeof detail === 'number' ? String(detail) : undefined;

    const showApproval = state === 'waiting' && (onApprove !== undefined || onDeny !== undefined);
    const subject = approvalSubject ? ` ${approvalSubject}` : '';

    const doneCount = steps.filter((s) => s.state === 'done').length;
    const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;

    // ── Accessible name and live announcement.
    const toggleName = labels.toggle({
      state,
      label,
      detail: detailText,
      elapsed,
      open,
      panelTitle,
    });
    const choices = showApproval
      ? [onDeny && denyLabel, onApprove && approveLabel].filter((c): c is string => !!c)
      : [];
    const liveText = labels.announcement({ state, label, choices });

    const returnFocus = () => toggleRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || e.key !== 'Escape' || !open) return;
      e.preventDefault();
      if (panelRef.current?.contains(document.activeElement)) returnFocus();
      setOpen(false);
    };

    const live = state === 'running' || state === 'waiting' || state === 'paused';
    const showPause =
      (state === 'running' && onPause !== undefined) ||
      (state === 'paused' && onResume !== undefined);
    const showStop = live && onStop !== undefined;

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Escape here closes the panel; the toggle and panel controls own activation.
      <div
        ref={ref}
        data-state={state}
        className={cn('relative grid justify-items-center', className)}
        onKeyDown={handleKeyDown}
        {...props}
      >
        <SurfaceProvider value={level}>
          {/* The pill: wraps the approval actions onto a second line when the row runs out of room. */}
          <motion.div
            layout
            transition={spring.moderate}
            className={cn(
              'group/pill relative flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5 overflow-x-clip border',
              'border-[color:var(--pill-edge)] transition-[border-color] duration-240',
              edgeColor[state] === 'transparent' && 'has-[[data-pill-toggle]:hover]:border-border',
              surfaceClasses(level, Math.min(level, 3)),
              compact ? 'min-h-9 py-0.5' : 'min-h-10 py-1',
              showApproval ? 'pr-1 pl-1.5' : 'pr-4 pl-1.5',
            )}
            style={{ borderRadius: radius, '--pill-edge': edgeColor[state] } as CSSProperties}
          >
            <motion.button
              ref={toggleRef}
              layout
              transition={spring.moderate}
              type="button"
              data-pill-toggle=""
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={toggleName}
              onClick={() => setOpen(!open)}
              className={cn(
                'relative flex min-w-0 grow cursor-pointer items-center gap-2 bg-transparent text-left whitespace-nowrap',
                focusRing,
              )}
              style={{ borderRadius: innerRadius }}
            >
              <Disc state={state} logo={logo} name={name} px={discPx} />

              {Glyph && (
                <motion.span
                  layout="position"
                  transition={spring.moderate}
                  aria-hidden
                  className="relative grid shrink-0 place-items-center transition-colors duration-240"
                  style={{ width: glyphPx, height: glyphPx, color: glyphColor[state] }}
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={glyphKey(Glyph)}
                      className="grid place-items-center"
                      initial={{ opacity: 0, scale: reduce ? 1 : 0.6 }}
                      animate={{ opacity: 1, scale: 1, transition: spring.fast }}
                      exit={{ opacity: 0, scale: reduce ? 1 : 0.6, transition: spring.fast.exit }}
                    >
                      <Glyph size={glyphPx} strokeWidth={1.5} />
                    </motion.span>
                  </AnimatePresence>
                </motion.span>
              )}

              {/* Label: crossfades per activity; `detail` ticks in place. */}
              <motion.span
                layout
                transition={spring.moderate}
                aria-hidden
                className={cn(
                  size.type.body,
                  'relative flex min-w-0 max-w-[34ch] grow overflow-hidden',
                )}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={shownLabel}
                    layout="position"
                    transition={spring.moderate}
                    className={cn(size.type.body, 'block min-w-0 truncate', labelTone[state])}
                    initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                    animate={{ opacity: 1, y: 0, transition: spring.moderate }}
                    exit={{ opacity: 0, y: reduce ? 0 : -6, transition: spring.moderate.exit }}
                  >
                    {shownLabel}
                    {detail !== undefined && detail !== null && (
                      <span className="tabular-nums"> · {detail}</span>
                    )}
                  </motion.span>
                </AnimatePresence>
              </motion.span>

              {elapsed !== undefined && (
                <motion.span
                  layout="position"
                  transition={spring.moderate}
                  aria-hidden
                  className={cn(
                    size.type.caption,
                    'ml-1 shrink-0 font-mono tabular-nums text-muted-foreground',
                  )}
                >
                  {formatClock(elapsed)}
                </motion.span>
              )}

              {/* Disclosure cue: revealed on hover / focus (always on touch) so it adds no resting weight. */}
              <motion.span
                layout="position"
                transition={spring.moderate}
                aria-hidden
                className={cn(
                  '-ml-1 grid shrink-0 place-items-center transition-[opacity,color] duration-160',
                  open
                    ? 'text-foreground opacity-100'
                    : 'text-muted-foreground opacity-0 group-hover/pill:opacity-100 group-focus-within/pill:opacity-100 [@media(hover:none)]:opacity-100',
                )}
              >
                <DisclosureChevron open={open} size={compact ? 12 : 13} className="text-current" />
              </motion.span>
            </motion.button>

            <AnimatePresence mode="popLayout" initial={false}>
              {showApproval && (
                <motion.span
                  key="approval"
                  layout="position"
                  transition={spring.moderate}
                  className="ml-auto flex shrink-0 items-center gap-1.5"
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.92 }}
                  animate={{ opacity: 1, scale: 1, transition: spring.moderate }}
                  exit={{ opacity: 0, scale: reduce ? 1 : 0.92, transition: spring.moderate.exit }}
                >
                  {onDeny && (
                    <Button
                      size="compact"
                      variant="tertiary"
                      aria-label={subject ? `${denyLabel}${subject}` : undefined}
                      onClick={() => {
                        onDeny();
                        returnFocus();
                      }}
                    >
                      {denyLabel}
                    </Button>
                  )}
                  {onApprove && (
                    <Button
                      size="compact"
                      variant="primary"
                      aria-label={subject ? `${approveLabel}${subject}` : undefined}
                      onClick={() => {
                        onApprove();
                        returnFocus();
                      }}
                    >
                      {approveLabel}
                    </Button>
                  )}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        </SurfaceProvider>

        <Collapse open={open} id={panelId} hideWhenClosed className="w-full">
          {/* Side and bottom room so the fold's clip doesn't shave the card's shadow. */}
          <div ref={panelRef} className="flex justify-center px-1 pt-3 pb-2">
            <AgentCard
              role="region"
              aria-label={labels.panel(name, panelTitle)}
              className={cn(
                'grid w-[min(100%,420px)] gap-2.5',
                compact ? 'px-3 pt-2.5 pb-3' : 'px-3.5 pt-3 pb-3.5',
              )}
            >
              <div className="flex items-baseline justify-between gap-2.5">
                <span
                  className={cn(size.type.caption, 'text-muted-foreground')}
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {panelTitle}
                </span>
                <span className={cn(size.type.caption, 'tabular-nums text-muted-foreground')}>
                  {steps.length ? labels.stepCount(doneCount, steps.length) : labels.noSteps}
                </span>
              </div>

              {/* Progress only from steps: without them there is nothing to measure. */}
              {steps.length > 0 && (
                <div
                  role="progressbar"
                  aria-label={labels.progress(panelTitle)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-valuetext={labels.progressValue(doneCount, steps.length)}
                  className="relative h-1 overflow-hidden rounded-full bg-active"
                >
                  <motion.span
                    className="absolute inset-0 origin-left overflow-hidden rounded-full transition-colors duration-240"
                    style={{ backgroundColor: barColor[state] }}
                    initial={false}
                    animate={{ scaleX: pct / 100 }}
                    transition={spring.moderate}
                  >
                    {state === 'running' && <span className="sheen block size-full" />}
                  </motion.span>
                </div>
              )}

              {steps.length > 0 && (
                <ol className="grid gap-0.5">
                  {steps.map((step) => (
                    <motion.li
                      key={step.id}
                      data-state={step.state}
                      aria-current={step.state === 'active' ? 'step' : undefined}
                      className={cn(
                        size.type.body,
                        'grid min-h-[26px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2',
                        stepTone[step.state],
                      )}
                      style={step.state === 'waiting' ? { color: 'var(--warning)' } : undefined}
                      initial={{ opacity: 0, y: reduce ? 0 : -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={spring.moderate}
                    >
                      <StepIcon state={step.state} paused={state === 'paused'} />
                      <span className="truncate">{step.label}</span>
                    </motion.li>
                  ))}
                </ol>
              )}

              {(showPause || showStop || onOpenRun) && (
                <div className="flex flex-wrap justify-end gap-2 pt-0.5">
                  {showPause && (
                    <Button
                      size="compact"
                      variant="tertiary"
                      leadingIcon={state === 'paused' ? icons.play : icons.pause}
                      onClick={state === 'paused' ? onResume : onPause}
                    >
                      {state === 'paused' ? labels.resume : labels.pause}
                    </Button>
                  )}
                  {showStop && (
                    <Button
                      size="compact"
                      variant="tertiary"
                      leadingIcon={icons.stop}
                      onClick={() => {
                        onStop?.();
                        returnFocus();
                      }}
                    >
                      {labels.stop}
                    </Button>
                  )}
                  {onOpenRun && (
                    <Button size="compact" variant="ghost" onClick={onOpenRun}>
                      {labels.openRun}
                    </Button>
                  )}
                </div>
              )}
            </AgentCard>
          </div>
        </Collapse>

        {announce && (
          <span className="sr-only" role="status" aria-live="polite">
            {liveText}
          </span>
        )}
      </div>
    );
  },
);
AgentStatusPillInner.displayName = 'AgentStatusPillInner';

// ─── Parts ───────────────────────────────────────────────────────────────────

/**
 * The agent's mark in a ring: a fixed quarter arc under the mark while the run is
 * live (it breathes while running, pulses while waiting) that closes into a full
 * success ring when the run is done. Real progress lives in the panel's bar.
 */
function Disc({
  state,
  logo,
  name,
  px,
}: {
  state: AgentStatusPillState;
  logo?: AgentMark;
  name: string;
  px: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const Mark = resolveMark(logo);
  const breathing = state === 'running' && !reduce;
  return (
    <motion.span
      layout="position"
      transition={spring.moderate}
      aria-hidden
      className="relative grid shrink-0 place-items-center rounded-full"
      style={{ width: px, height: px }}
    >
      <motion.svg
        viewBox="0 0 24 24"
        className={cn(
          'absolute inset-0 size-full overflow-visible',
          state === 'waiting' && 'pulse-soft',
        )}
        initial={false}
        animate={breathing ? { opacity: [1, 0.5, 1] } : { opacity: 1 }}
        transition={breathing ? loop.breathe : spring.moderate}
      >
        <circle
          cx="12"
          cy="12"
          r="10.4"
          fill="none"
          strokeWidth="1.7"
          style={{ stroke: 'var(--border)' }}
        />
        {/* Rotated so the quarter arc sits under the mark, from the lower right. */}
        <g transform="rotate(51 12 12)">
          <motion.circle
            cx="12"
            cy="12"
            r="10.4"
            fill="none"
            strokeWidth="1.7"
            strokeLinecap="round"
            className="transition-[stroke] duration-240"
            style={{ stroke: ringColor[state] }}
            initial={reduce ? false : { pathLength: 0 }}
            animate={{ pathLength: state === 'done' ? 1 : 0.25 }}
            transition={spring.slow}
          />
        </g>
      </motion.svg>
      <span className="relative grid place-items-center text-muted-foreground">
        {Mark ? (
          <Mark size={Math.round(px / 2)} />
        ) : (
          <span
            className={typeClass('micro')}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {initials(name)}
          </span>
        )}
      </span>
    </motion.span>
  );
}

/** Step glyph: drawn check, spinner, raised hand, cross, or a pending dot. */
function StepIcon({ state, paused }: { state: AgentStatusPillStepState; paused: boolean }) {
  const icons = useIcons();
  const cell = 'grid size-[18px] place-items-center';
  if (state === 'done') {
    return (
      <span className={cell} aria-hidden style={{ color: 'var(--success)' }}>
        <DrawnCheck size={14} strokeWidth={2.25} />
      </span>
    );
  }
  if (state === 'active') {
    const Pause = icons.pause;
    return (
      <span className={cn(cell, paused && 'text-muted-foreground')} aria-hidden>
        {paused ? (
          <Pause size={13} strokeWidth={1.5} />
        ) : (
          <AgentStatusIcon status="running" size={14} />
        )}
      </span>
    );
  }
  if (state === 'waiting') {
    const Hand = icons.hand;
    return (
      <span className={cn(cell, 'pulse-soft')} aria-hidden style={{ color: 'var(--warning)' }}>
        <Hand size={14} strokeWidth={1.5} />
      </span>
    );
  }
  if (state === 'denied') {
    const X = icons.x;
    return (
      <span className={cn(cell, 'text-destructive')} aria-hidden>
        <X size={14} strokeWidth={1.5} />
      </span>
    );
  }
  const Dot = icons.dot;
  return (
    <span className={cn(cell, 'text-muted-foreground')} aria-hidden>
      <Dot size={14} strokeWidth={1.5} />
    </span>
  );
}

export type {
  AgentStatusPillLabels,
  AgentStatusPillProps,
  AgentStatusPillState,
  AgentStatusPillStep,
  AgentStatusPillStepState,
  AgentStatusPillToggleInfo,
};
export { AgentStatusPill };
