import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useControllable } from '../design-kit/hooks/use-controllable.ts';
import { Check } from '../design-kit/icons.ts';
import {
  type AgentStatus,
  AgentStatusIcon,
  Button,
  Collapse,
  cn,
  DisclosureChevron,
  focusRing,
  formatClock,
  MetaDot,
  useNow,
} from '../design-kit/index.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { spring } from '../design-kit/lib/springs.ts';
import type { PresenceTone } from '../run/presence.ts';

// The composer's one line about the run (features/composer-flow.md "활동 바"): a mark, one line
// of words and the context at its right end, folding out upward into the roles, the plan, the
// context and the run controls. It takes everything it shows as props; the host decides what the
// line says and which state names are already on screen.

/** What a state's words speak of (features/presence.md "한 화면에 한 번"). */
export type ActivityTarget = `run:${string}` | `execution:${string}`;

export interface ActivityState {
  text: string;
  target: ActivityTarget;
}

export interface ActivityBarLine {
  /** The kit mark; null draws none. */
  glyph: AgentStatus | null;
  tone: PresenceTone;
  /** The state's name in words. The host leaves it out where a row on screen already says it. */
  state?: ActivityState;
  /** The line's words: what waits, or a role's activity. They give way first. */
  text?: string;
  /** After the words: the plan count and step, the change summary. Each part says what of it may shrink or leave. */
  parts?: ReactNode;
  /** Elapsed clock (ms epoch); never announced. */
  startedAt?: number;
  endedAt?: number;
  /** The line speaks of something that went wrong. */
  warning?: boolean;
  /**
   * One waiting approval, decided on the line by its buttons; `action` (View) opens its card.
   * The buttons show only while `text` is on the line whole beside them: cut, the line offers View
   * alone.
   */
  approval?: {
    /** All of what it allows: the buttons' names for assistive technology. */
    subject: string;
    approveLabel: string;
    denyLabel: string;
    onApprove: () => void;
    onDeny: () => void;
    disabled?: boolean;
  };
  /** One action after the words: View, Retry, Review failed steps (a link, `render`). */
  action?: { label: string; onClick?: () => void; render?: ReactElement };
}

export interface ActivityBarRole {
  id: string;
  name: string;
  glyph: AgentStatus | null;
  tone: PresenceTone;
  /** None for a state that has no words: the row says only the name. */
  state?: ActivityState;
  /** The state in words; false where its row on screen says it (the name stays for AT). */
  stateShown: boolean;
  activity?: string;
  startedAt?: number;
  endedAt?: number;
  /** The join target: what an instruction goes to. */
  target: boolean;
  onShow?: () => void;
  onJoin?: () => void;
}

export interface ActivityBarControls {
  paused: boolean;
  disabled?: boolean;
  /** Stop alone; `disabled` when not given. A pausing run can still be stopped. */
  stopDisabled?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  /** Read with the controls: which run they act on. */
  note?: ReactNode;
}

export interface ActivityBarProps {
  /** Null while the session has no run: the bar keeps its height and says nothing. */
  line: ActivityBarLine | null;
  /** The right end: the context pill and the Overview opener. */
  end?: ReactNode;
  roles?: ActivityBarRole[];
  /** The work plan's Todo: the one place the plan is read. */
  plan?: ReactNode;
  /** Context detail and compaction. */
  context?: ReactNode;
  controls?: ActivityBarControls;
  /** Announcements of state changes, from the host's live regions. */
  announcements?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const TONE: Record<PresenceTone, string> = {
  neutral: 'var(--muted-foreground)',
  active: 'var(--emphasis)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--destructive)',
};

function Mark({ glyph, tone }: { glyph: AgentStatus | null; tone: PresenceTone }) {
  // The slot keeps its size without a mark, so the words never shift with the state.
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
      {glyph ? (
        <span className="inline-flex" style={{ color: TONE[tone] }}>
          <AgentStatusIcon status={glyph} size={14} colored={false} />
        </span>
      ) : null}
    </span>
  );
}

function Clock({ startedAt, endedAt }: { startedAt?: number; endedAt?: number }) {
  const ticking = startedAt !== undefined && endedAt === undefined;
  const now = useNow(500, ticking);
  if (startedAt === undefined) return null;
  return (
    <span
      aria-hidden
      className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground"
    >
      {formatClock(Math.max(0, (endedAt ?? now) - startedAt))}
    </span>
  );
}

/** The line's words: the state where no row says it, then what it does. */
function LineWords({ line }: { line: ActivityBarLine }) {
  return (
    <>
      {line.state ? <StateWords state={line.state} /> : null}
      {line.state && line.text ? <MetaDot /> : null}
      {line.text ? (
        // Cut at its end; the whole of it is on the card the line's View goes to.
        <span data-activity-text="" className={cn('min-w-0 truncate', line.approval && 'flex-1')}>
          <span>{line.text}</span>
        </span>
      ) : null}
    </>
  );
}

/**
 * Whether the line's words are whole beside its decision buttons. Shown, the words must fit the
 * room they have; hidden, the room less the buttons they would bring back. Judged with the
 * buttons in place either way, so they never come and go with their own width.
 */
export function decisionsFit({
  shown,
  room,
  words,
  buttons,
  gap,
}: {
  /** The buttons are on the line now. */
  shown: boolean;
  /** The words' box width. */
  room: number;
  /** The words' whole width. */
  words: number;
  /** The decision buttons' width. */
  buttons: number;
  /** The space between the line's parts. */
  gap: number;
}) {
  return words <= (shown ? room : room - buttons - gap);
}

function StateWords({ state }: { state: ActivityState }) {
  return (
    <span data-presence-label={state.target} className="shrink-0 whitespace-nowrap">
      {state.text}
    </span>
  );
}

export function ActivityBar({
  line,
  end,
  roles = [],
  plan,
  context,
  controls,
  announcements,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
}: ActivityBarProps) {
  const t = useTranslations('Activity');
  const reduce = useReducedMotion() ?? false;
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [openState, setOpen] = useControllable(openProp, defaultOpen, onOpenChange);
  const foldable = Boolean(line && (roles.length || plan || context || controls));
  const open = foldable && openState;
  const back = () => toggle.current?.focus();
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const approval = line?.approval;
  const decisionKey = approval
    ? [line?.text, approval.denyLabel, approval.approveLabel].join('\n')
    : null;
  // The decision buttons, while the words say in full what they decide.
  const [fits, setFits] = useState(false);
  const judge = useCallback(() => {
    const words = [...(row.current?.querySelectorAll<HTMLElement>('[data-activity-text]') ?? [])]
      .filter((element) => element.textContent === line?.text)
      .at(-1);
    if (!decisionKey || !words || !row.current) {
      setFits(false);
      return;
    }
    const buttons = measure.current?.offsetWidth ?? 0;
    const gap = Number.parseFloat(getComputedStyle(row.current).columnGap) || 0;
    // The words' own width, from the run of text inside the box that cuts them.
    const whole = words.firstElementChild?.getBoundingClientRect().width ?? 0;
    const room = words.getBoundingClientRect().width;
    setFits((shown) => decisionsFit({ shown, room, words: whole, buttons, gap }));
  }, [decisionKey, line?.text]);
  useLayoutEffect(() => {
    judge();
    const element = row.current;
    if (!decisionKey || !element || typeof ResizeObserver === 'undefined') return;
    // Again whenever the width changes.
    const observer = new ResizeObserver(() => judge());
    observer.observe(element);
    return () => observer.disconnect();
  }, [decisionKey, judge]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.key !== 'Escape' || !open) return;
    event.preventDefault();
    if (panel.current?.contains(document.activeElement)) back();
    setOpen(false);
  };
  const words = line ? [line.state?.text, line.text].filter(Boolean).join(' · ') : '';
  // New words are pressable only once they are fully in: until then a press meant for what was
  // there does not decide what came.
  const [entered, setEntered] = useState(words);
  const current = useRef(words);
  current.current = words;
  // Should the animation never report its end (a hidden tab), the words count as in after it.
  useEffect(() => {
    if (entered === words) return;
    const timer = setTimeout(() => setEntered(words), 1000);
    return () => clearTimeout(timer);
  }, [entered, words]);
  const settled = reduce || entered === words;
  const decide = Boolean(approval && fits);
  return (
    // biome-ignore lint/a11y/useSemanticElements: the run's status line and its controls, named as one group; not a form's fieldset.
    <div
      role="group"
      aria-label={t('bar')}
      data-activity-bar=""
      data-state={line?.glyph ?? 'none'}
      data-tone={line?.tone}
      className={cn('flex min-w-0 flex-col-reverse', className)}
      onKeyDown={onKeyDown}
    >
      {/* The line comes first in the document, so focus reaches it before the panel it opens
          above itself. One height, whatever it says. */}
      <div ref={row} className="group/activity relative flex h-8 min-w-0 items-center gap-2 px-3">
        {line ? (
          <>
            <span
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 text-ui',
                line.warning ? 'text-warning' : 'text-foreground',
              )}
            >
              <Mark glyph={line.glyph} tone={line.tone} />
              {/* The words crossfade when they change, and swap at once with reduced motion;
                  the clock and counts tick in place. */}
              <span
                className={cn(
                  'relative flex min-w-0 items-center overflow-hidden',
                  // With decisions, the words take the room left, so it can be measured.
                  approval && 'flex-1',
                )}
              >
                {reduce ? (
                  <span
                    key={words}
                    className={cn('flex min-w-0 items-center gap-1.5', approval && 'flex-1')}
                  >
                    <LineWords line={line} />
                  </span>
                ) : (
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={words}
                      className={cn('flex min-w-0 items-center gap-1.5', approval && 'flex-1')}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0, transition: spring.moderate }}
                      exit={{ opacity: 0, y: -6, transition: spring.moderate.exit }}
                      onAnimationComplete={() => {
                        if (current.current === words) setEntered(words);
                      }}
                    >
                      <LineWords line={line} />
                    </motion.span>
                  </AnimatePresence>
                )}
              </span>
              {line.parts ? (
                <span className="relative z-10 flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  {line.state || line.text ? <MetaDot /> : null}
                  {line.parts}
                </span>
              ) : null}
              <Clock startedAt={line.startedAt} endedAt={line.endedAt} />
            </span>
            {line.action ? (
              <Button
                size="compact"
                variant="tertiary"
                className="relative z-10 shrink-0"
                onClick={line.action.onClick}
                {...(line.action.render ? { render: line.action.render } : {})}
              >
                {line.action.label}
              </Button>
            ) : null}
            {approval ? (
              // The buttons' width, measured where nothing sees or reaches it.
              <span
                ref={measure}
                aria-hidden
                inert
                className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1.5 whitespace-nowrap"
              >
                <Button size="compact" variant="tertiary" tabIndex={-1}>
                  {approval.denyLabel}
                </Button>
                <Button size="compact" variant="primary" tabIndex={-1}>
                  {approval.approveLabel}
                </Button>
              </span>
            ) : null}
            {decide && line.approval ? (
              <span className="relative z-10 flex shrink-0 items-center gap-1.5">
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={line.approval.disabled || !settled}
                  aria-label={`${line.approval.denyLabel} · ${line.approval.subject}`}
                  onClick={() => {
                    line.approval?.onDeny();
                    back();
                  }}
                >
                  {line.approval.denyLabel}
                </Button>
                <Button
                  size="compact"
                  variant="primary"
                  disabled={line.approval.disabled || !settled}
                  aria-label={`${line.approval.approveLabel} · ${line.approval.subject}`}
                  onClick={() => {
                    line.approval?.onApprove();
                    back();
                  }}
                >
                  {line.approval.approveLabel}
                </Button>
              </span>
            ) : null}
            {end ? <span className="relative z-10 flex shrink-0 items-center">{end}</span> : null}
            {foldable ? (
              // The whole line is the toggle's hit area; what sits on it stays above.
              <button
                ref={toggle}
                type="button"
                data-activity-toggle=""
                aria-expanded={open}
                aria-controls={panelId}
                aria-label={t('details')}
                onClick={() => setOpen(!open)}
                className={cn(
                  'grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground after:absolute after:inset-0 after:rounded-[inherit] hover:text-foreground',
                  focusRing,
                )}
              >
                <DisclosureChevron open={!open} size={13} className="text-current" />
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <Collapse id={panelId} open={open} hideWhenClosed>
        <section
          ref={panel}
          aria-label={t('details')}
          className="flex max-h-[min(24rem,45dvh)] flex-col gap-3 overflow-y-auto overscroll-contain border-b border-border/60 px-2.5 pt-2.5 pb-3"
        >
          {roles.length ? (
            <ul aria-label={t('roles')} className="flex flex-col gap-0.5">
              {roles.map((role) => (
                <RoleRow key={role.id} role={role} />
              ))}
            </ul>
          ) : null}
          {plan}
          {context}
          {controls ? <Controls controls={controls} /> : null}
        </section>
      </Collapse>
      {announcements}
    </div>
  );
}

function RoleRow({ role }: { role: ActivityBarRole }) {
  const t = useTranslations('Activity');
  return (
    <li data-activity-role={role.id} className="flex min-h-8 min-w-0 items-center gap-2 text-ui">
      <Mark glyph={role.glyph} tone={role.tone} />
      <span className="shrink-0" style={{ fontVariationSettings: fontWeights.semibold }}>
        {role.name}
      </span>
      {!role.state ? null : role.stateShown ? (
        <span className="shrink-0 text-muted-foreground">
          <StateWords state={role.state} />
        </span>
      ) : (
        <span className="sr-only">{role.state.text}</span>
      )}
      {role.activity ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={role.activity}>
          {role.activity}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <Clock startedAt={role.startedAt} endedAt={role.endedAt} />
      {role.onShow ? (
        <Button
          size="compact"
          variant="ghost"
          aria-label={t('viewRole', { name: role.name })}
          onClick={role.onShow}
        >
          {t('view')}
        </Button>
      ) : null}
      {/* One column for joining, so the rows' clocks and buttons line up. */}
      <span className="flex w-28 shrink-0 justify-end">
        {role.target ? (
          <span className="flex h-7 items-center gap-1 px-2 text-caption text-muted-foreground">
            <Check aria-hidden="true" className="size-3.5" />
            {t('joinTarget')}
          </span>
        ) : role.onJoin ? (
          <Button
            size="compact"
            variant="ghost"
            aria-label={t('joinRole', { name: role.name })}
            onClick={role.onJoin}
          >
            {t('join')}
          </Button>
        ) : null}
      </span>
    </li>
  );
}

function Controls({ controls }: { controls: ActivityBarControls }) {
  const t = useTranslations('Activity');
  return (
    <section
      aria-label={t('controls')}
      className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 pt-2.5"
    >
      {controls.note}
      {controls.paused ? (
        controls.onResume ? (
          <Button
            size="compact"
            variant="tertiary"
            disabled={controls.disabled}
            onClick={controls.onResume}
          >
            {t('resume')}
          </Button>
        ) : null
      ) : controls.onPause ? (
        <Button
          size="compact"
          variant="tertiary"
          disabled={controls.disabled}
          onClick={controls.onPause}
        >
          {t('pause')}
        </Button>
      ) : null}
      {controls.onStop ? (
        <Button
          size="compact"
          variant="ghost-destructive"
          disabled={controls.stopDisabled ?? controls.disabled}
          onClick={controls.onStop}
        >
          {t('stop')}
        </Button>
      ) : null}
    </section>
  );
}
