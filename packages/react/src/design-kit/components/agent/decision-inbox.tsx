'use client';

// The stack of open decisions an agent team is waiting on. Each row asks one
// question with a primary and an optional secondary answer; answering shows a
// confirmation pill in place of the buttons, and the row leaves once the
// parent drops it from `decisions`. With nothing left, the empty line shows.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { forwardRef, type HTMLAttributes, type ReactNode, useState } from 'react';
import { focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { AgentCard, AgentStatusIcon, SizeScope, toneFill } from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Which of a decision's two answers was picked. */
type DecisionChoice = 'primary' | 'secondary';

interface DecisionAction {
  /** Button text (`Roll out`). */
  label: string;
  /** Pill text after it's picked (`Rolled out`). Default: the label. */
  doneLabel?: string;
}

interface Decision {
  id: string;
  /** The question (`Renew Figma for the design team?`). */
  title: string;
  /** Supporting facts under the question. Newlines are kept. */
  detail?: string;
  primary: DecisionAction;
  secondary?: DecisionAction;
  /** Show folded to its title until clicked. Default false (open). */
  folded?: boolean;
  /** Mark as answered from outside: shows the pill with this text. */
  resolution?: string;
  /** An answer was sent and its receipt is awaited: both buttons wait, unpressable. */
  pending?: boolean;
}

interface DecisionInboxLabels {
  /** Accessible name of the decisions region. */
  region: string;
}

const defaultLabels: DecisionInboxLabels = { region: 'Decisions' };

interface DecisionInboxProps extends HTMLAttributes<HTMLDivElement> {
  /** Open decisions, top first. Drop a decision to animate its row out. */
  decisions: Decision[];
  /**
   * Show the pill as soon as an answer is picked. Default true. False sends
   * `onDecide` only: the pill then comes from the decision's `resolution`.
   */
  optimistic?: boolean;
  /** An answer was picked. The row shows its pill until you remove it. */
  onDecide?: (id: string, choice: DecisionChoice) => void;
  /** Header text for N open decisions. Default `N need(s) your input`. */
  heading?: (count: number) => ReactNode;
  /** Header text with nothing open. Default `Nothing waiting on you`. */
  clearHeading?: ReactNode;
  /** Line in the card with nothing open. */
  emptyLabel?: ReactNode;
  /** Localized accessible name of the decisions region. */
  labels?: Partial<DecisionInboxLabels>;
  /** Density for the whole inbox; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
}

// ─── Component ───────────────────────────────────────────────────────────────

const defaultHeading = (n: number) => `${n} ${n === 1 ? 'needs' : 'need'} your input`;

const DecisionInboxBody = forwardRef<HTMLDivElement, Omit<DecisionInboxProps, 'size'>>(
  (
    {
      decisions,
      onDecide,
      optimistic = true,
      heading = defaultHeading,
      clearHeading = 'Nothing waiting on you',
      emptyLabel = 'Nothing waiting on you – new decisions show up here.',
      labels: labelOverrides,
      className,
      ...props
    },
    ref,
  ) => {
    const labels = { ...defaultLabels, ...labelOverrides };
    const sizeClasses = useSize();
    const reduce = useReducedMotion() ?? false;
    // Answers picked here, shown as pills until the parent removes the row.
    const [picked, setPicked] = useState<Record<string, string>>({});
    // Folded rows the user has opened.
    const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());

    const resolutionOf = (d: Decision) => d.resolution ?? picked[d.id];
    const open = decisions.filter((d) => resolutionOf(d) === undefined).length;
    const clear = decisions.length === 0;

    const decide = (d: Decision, choice: DecisionChoice) => {
      const action = choice === 'primary' ? d.primary : d.secondary;
      if (!action) return;
      if (optimistic) setPicked((p) => ({ ...p, [d.id]: action.doneLabel ?? action.label }));
      onDecide?.(d.id, choice);
    };

    return (
      <AgentCard
        ref={ref}
        className={cn('@container', className)}
        data-clear={clear || undefined}
        {...props}
      >
        <section aria-label={labels.region}>
          <header
            className={cn(
              sizeClasses.type.body,
              'flex h-11 items-center gap-2 border-b border-border px-4 text-foreground',
            )}
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-live="polite"
          >
            <motion.span
              key={clear ? 'clear' : 'open'}
              className="grid place-items-center"
              style={{ color: clear ? 'var(--success)' : 'var(--warning)' }}
              initial={reduce ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={spring.slow}
            >
              <AgentStatusIcon status={clear ? 'done' : 'failed'} size={16} colored={false} />
            </motion.span>
            <motion.span
              key={clear ? 'clear-text' : `open-${open}`}
              initial={reduce ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring.moderate}
            >
              {clear ? clearHeading : heading(open)}
            </motion.span>
          </header>
          <ul className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
              {decisions.map((d, i) => (
                <motion.li
                  key={d.id}
                  layout={!reduce}
                  className={cn('relative', i > 0 && 'border-t border-border')}
                  exit={{ opacity: 0, transition: spring.moderate.exit }}
                  transition={spring.moderate}
                >
                  <DecisionRow
                    decision={d}
                    resolution={resolutionOf(d)}
                    folded={!!d.folded && !unfolded.has(d.id)}
                    onUnfold={() => setUnfolded((s) => new Set(s).add(d.id))}
                    onDecide={(choice) => decide(d, choice)}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <AnimatePresence initial={false}>
            {clear && (
              <motion.p
                key="empty"
                className={cn(sizeClasses.type.body, 'px-4 py-3.5 text-muted-foreground')}
                initial={reduce ? false : { opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: spring.moderate.exit }}
                transition={{ ...spring.moderate, delay: reduce ? 0 : 0.3 }}
              >
                {emptyLabel}
              </motion.p>
            )}
          </AnimatePresence>
        </section>
      </AgentCard>
    );
  },
);
DecisionInboxBody.displayName = 'DecisionInboxBody';

/** The open decisions an agent team is waiting on, answered in place. */
const DecisionInbox = forwardRef<HTMLDivElement, DecisionInboxProps>(({ size, ...props }, ref) => (
  <SizeScope size={size}>
    <DecisionInboxBody ref={ref} {...props} />
  </SizeScope>
));
DecisionInbox.displayName = 'DecisionInbox';

// ─── Row ─────────────────────────────────────────────────────────────────────

interface DecisionRowProps {
  decision: Decision;
  resolution?: string;
  folded: boolean;
  onUnfold: () => void;
  onDecide: (choice: DecisionChoice) => void;
}

function DecisionRow({ decision, resolution, folded, onUnfold, onDecide }: DecisionRowProps) {
  const sizeClasses = useSize();
  const shape = useShape();
  const icons = useIcons();
  const reduce = useReducedMotion() ?? false;
  const Check = icons.check;

  if (folded) {
    return (
      <button
        type="button"
        dir="auto"
        aria-expanded={false}
        onClick={onUnfold}
        className={cn(
          sizeClasses.type.body,
          'block w-full truncate px-4 py-3.5 text-start text-muted-foreground transition-colors duration-160 hover:bg-hover hover:text-foreground',
          focusRingInset,
        )}
      >
        {decision.title}
      </button>
    );
  }

  return (
    <div
      className="px-4 pt-3.5 pb-4 @max-[340px]:px-3.5 @max-[340px]:pt-3 @max-[340px]:pb-3.5"
      data-open="true"
    >
      <p
        dir="auto"
        className={cn(sizeClasses.type.body, 'text-foreground [overflow-wrap:anywhere]')}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {decision.title}
      </p>
      {decision.detail && (
        <p
          dir="auto"
          className={cn(
            sizeClasses.type.body,
            'mt-0.5 whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]',
          )}
        >
          {decision.detail}
        </p>
      )}
      <div className="mt-3 flex min-h-7 flex-wrap items-center gap-2 pointer-coarse:min-h-9">
        <AnimatePresence mode="popLayout" initial={false}>
          {resolution === undefined ? (
            <motion.div
              key="actions"
              className="flex flex-wrap items-center gap-2"
              exit={{ opacity: 0, transition: spring.fast.exit }}
            >
              <Button
                variant="primary"
                size="compact"
                dir="auto"
                disabled={decision.pending}
                onClick={() => onDecide('primary')}
              >
                {decision.primary.label}
              </Button>
              {decision.secondary && (
                <Button
                  variant="tertiary"
                  size="compact"
                  dir="auto"
                  disabled={decision.pending}
                  onClick={() => onDecide('secondary')}
                >
                  {decision.secondary.label}
                </Button>
              )}
            </motion.div>
          ) : (
            <motion.span
              key="done"
              role="status"
              className={cn(
                sizeClasses.type.body,
                shape.button,
                'inline-flex min-h-7 max-w-full items-center gap-1.5 py-1 pr-2.5 pl-2 [overflow-wrap:anywhere]',
              )}
              style={{
                backgroundColor: toneFill('green', 12),
                color: 'var(--success)',
                fontVariationSettings: fontWeights.semibold,
              }}
              initial={reduce ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring.moderate}
            >
              <Check size={14} strokeWidth={2} />
              {resolution}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export type { Decision, DecisionAction, DecisionChoice, DecisionInboxLabels, DecisionInboxProps };
export { DecisionInbox };
