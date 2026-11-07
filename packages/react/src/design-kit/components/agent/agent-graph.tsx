'use client';

import { motion, useReducedMotion } from 'motion/react';
import { type MouseEventHandler, type ReactElement, type ReactNode, useId } from 'react';
import { initials } from '../../lib/agent-format.ts';
import { Elevated } from '../../lib/elevated.tsx';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { loop, spring } from '../../lib/springs.ts';
import { SURFACE_BG } from '../../lib/surface-classes.ts';
import { useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';
import {
  type AgentMark,
  type AgentStatus,
  AgentStatusLabel,
  resolveMark,
  toneFill,
} from './agent-primitives.tsx';

export interface AgentGraphNodeProps {
  name: string;
  model?: string;
  logo?: AgentMark;
  status: AgentStatus;
  statusLabel: string;
  detail?: string;
  label: string;
  description?: string;
  lead?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Compose the native button with a kit trigger without adding another focus target. */
  renderTrigger?: (button: ReactElement) => ReactNode;
}

/** The source AgentGraph tile, separated from its fixed stage and popup for host composition. */
export function AgentGraphNode({
  name,
  model,
  logo,
  status,
  statusLabel,
  detail,
  label,
  description,
  lead = false,
  selected = false,
  dimmed = false,
  onClick,
  renderTrigger,
}: AgentGraphNodeProps) {
  const reduce = useReducedMotion() ?? false;
  // Labels take the stage's own surface so edges passing behind them stay out of the text.
  const surface = useSurface();
  const descriptionId = useId();
  const diameter = lead ? 56 : 46;
  const Mark = resolveMark(logo);
  const tint =
    status === 'waiting' ? toneFill('amber') : status === 'failed' ? toneFill('red') : undefined;
  const button = (
    <motion.button
      type="button"
      className={cn('relative grid place-items-center rounded-[27%]', focusRing)}
      style={{ width: diameter, height: diameter }}
      whileHover={reduce ? undefined : { scale: 1.06 }}
      animate={{ scale: selected ? 1.06 : 1 }}
      transition={reduce ? { duration: 0 } : spring.fast}
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      aria-pressed={selected}
      title={label}
      onClick={onClick}
    >
      <Elevated
        offset={2}
        className={cn(
          'grid size-full place-items-center rounded-[27%]',
          selected && 'ring-2 ring-[var(--emphasis)]',
        )}
        style={tint ? { background: tint } : undefined}
      >
        {Mark ? (
          <Mark size={Math.round(diameter * 0.45)} />
        ) : (
          <span className="text-caption text-muted-foreground">{initials(name)}</span>
        )}
      </Elevated>
    </motion.button>
  );
  return (
    <div className="grid w-40 justify-items-center gap-1 text-center">
      <div
        className="relative grid h-14 place-items-center"
        style={{ width: diameter, opacity: dimmed ? 0.35 : 1 }}
      >
        {status === 'running' || status === 'waiting' ? (
          // Corral also breathes a waiting (needs you) agent, in the warning colour.
          <motion.span
            className="absolute rounded-[27%]"
            style={{
              width: diameter,
              height: diameter,
              background: `color-mix(in srgb, var(${status === 'waiting' ? '--warning' : '--emphasis'}) 30%, var(--background))`,
            }}
            initial={false}
            animate={
              reduce
                ? { scale: 1.15, opacity: 0.35 }
                : { scale: [1.08, 1.3, 1.08], opacity: [0.5, 0.15, 0.5] }
            }
            transition={reduce ? { duration: 0 } : loop.breathe}
            aria-hidden
          />
        ) : null}
        {renderTrigger ? renderTrigger(button) : button}
      </div>
      <div
        className={cn(
          'pointer-events-none grid max-w-full justify-items-center gap-1 px-1',
          SURFACE_BG[surface] ?? 'bg-background',
        )}
      >
        <span
          className="max-w-full truncate px-1 text-caption text-foreground"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {name}
        </span>
        {model ? (
          <span className="max-w-full truncate text-caption text-muted-foreground">{model}</span>
        ) : null}
        <AgentStatusLabel status={status} label={statusLabel} className="max-w-full" />
        {detail ? (
          <span className="max-w-full text-micro text-muted-foreground">{detail}</span>
        ) : null}
      </div>
      {description ? (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      ) : null}
    </div>
  );
}
