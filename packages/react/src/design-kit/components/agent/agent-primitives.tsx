'use client';

// Shared building blocks for the agent components: the run-status vocabulary
// and its glyphs, the agent/tool identity marks, and the small live readouts
// (meter, sparkline, live dot, keycap). Every agent component imports from
// here, so a status color or avatar change lands everywhere at once.

import { motion, useReducedMotion } from 'motion/react';
import { type CSSProperties, forwardRef, type HTMLAttributes, type ReactNode, useId } from 'react';
import { initials } from '../../lib/agent-format.ts';
import { type AgentLogoName, agentLogos, isAgentLogoName } from '../../lib/agent-logos.tsx';
import { Elevated } from '../../lib/elevated.tsx';
import { fontWeights } from '../../lib/font-weight.ts';
import type { IconComponent } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { loop, spring } from '../../lib/springs.ts';
import { SURFACE_BG } from '../../lib/surface-classes.ts';
import { useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';
import { Badge, type BadgeColor } from '../ui/badge.tsx';

// ─── Status ──────────────────────────────────────────────────────────────────

/** Lifecycle of an agent, run, step, or job. `waiting` means it needs the user. */
type AgentStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

const agentStatusLabels: Record<AgentStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** Glyph color per status, as a CSS color (kit status tokens). */
const agentStatusColor: Record<AgentStatus, string> = {
  queued: 'var(--muted-foreground)',
  running: 'var(--emphasis)',
  waiting: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--destructive)',
  stopped: 'var(--muted-foreground)',
};

/** Badge hue per status. */
const agentStatusBadgeColor: Record<AgentStatus, BadgeColor> = {
  queued: 'gray',
  running: 'blue',
  waiting: 'amber',
  done: 'green',
  failed: 'red',
  stopped: 'gray',
};

/** Named hues the agent components accept for categories (lanes, findings, tools). */
type AgentTone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'purple';

/** A tone as a CSS color, from the Badge palette. */
function toneColor(tone: AgentTone): string {
  return tone === 'gray'
    ? 'var(--muted-foreground)'
    : `var(--agent-tone-${tone}, ${TONE_HEX[tone]})`;
}

const TONE_HEX: Record<Exclude<AgentTone, 'gray'>, string> = {
  blue: '#3b82f6',
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
  purple: '#a855f7',
};

/** A tone mixed into the background: a quiet fill that works in both themes. */
function toneFill(tone: AgentTone, amount = 14): string {
  return tone === 'gray'
    ? 'var(--accent)'
    : `color-mix(in srgb, ${toneColor(tone)} ${amount}%, var(--background))`;
}

interface AgentStatusIconProps {
  status: AgentStatus;
  /** Glyph size in px. Omitted, follows the size step (14 default, 12 compact). */
  size?: number;
  /** Draw in the status color (default) or inherit currentColor. */
  colored?: boolean;
  className?: string;
}

/** The status glyph: dot, spinner, clock, check, warning triangle, or square. */
function AgentStatusIcon({ status, size, colored = true, className }: AgentStatusIconProps) {
  const sizeClasses = useSize();
  const px = size ?? (sizeClasses.variant === 'compact' ? 12 : 14);
  const style: CSSProperties | undefined = colored
    ? { color: agentStatusColor[status] }
    : undefined;
  const common = {
    width: px,
    height: px,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    style,
  } as const;
  const stroke = {
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;

  switch (status) {
    case 'queued':
      return (
        <svg {...common} aria-hidden="true" className={cn('shrink-0', className)}>
          <circle cx="12" cy="12" r="3.5" fill="currentColor" />
        </svg>
      );
    case 'running':
      return (
        <svg
          {...common}
          aria-hidden="true"
          className={cn('shrink-0 motion-safe:animate-spin', className)}
        >
          <circle
            cx="12"
            cy="12"
            r="8.5"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2.5"
          />
          <path d="M12 3.5A8.5 8.5 0 0 1 20.5 12" {...stroke} strokeWidth="2.5" />
        </svg>
      );
    case 'waiting':
      return (
        <svg {...common} aria-hidden="true" className={cn('shrink-0', className)}>
          <circle cx="12" cy="12" r="10" {...stroke} strokeWidth="2" />
          <path d="M12 7.5V12L14.5 14.5" {...stroke} strokeWidth="2" />
        </svg>
      );
    case 'done':
      return (
        <svg {...common} aria-hidden="true" className={cn('shrink-0', className)}>
          <path d="M5 14L8.5 17.5L19 6.5" {...stroke} strokeWidth="2.4" />
        </svg>
      );
    case 'failed':
      return (
        <svg {...common} aria-hidden="true" className={cn('shrink-0', className)}>
          <path
            d="M13.92 21h-3.85c-4.63 0-6.94 0-7.8-1.5-.85-1.5.33-3.5 2.7-7.5l1.93-3.25C9.18 4.92 10.31 3 12 3s2.82 1.92 5.1 5.75l1.92 3.25c2.37 4 3.55 6 2.7 7.5-.85 1.5-3.17 1.5-7.8 1.5Z"
            {...stroke}
            strokeWidth="2"
          />
          <path d="M12 9v4" {...stroke} strokeWidth="2.2" />
          <path d="M12 16.8v.2" {...stroke} strokeWidth="2.6" />
        </svg>
      );
    case 'stopped':
      return (
        <svg {...common} aria-hidden="true" className={cn('shrink-0', className)}>
          <rect
            x="6"
            y="6"
            width="12"
            height="12"
            rx="2.5"
            stroke="currentColor"
            strokeWidth="2.2"
          />
        </svg>
      );
  }
}

interface AgentStatusLabelProps extends HTMLAttributes<HTMLSpanElement> {
  status: AgentStatus;
  /** Overrides the default word for the status (e.g. `Running · 2m 10s`). */
  label?: ReactNode;
  size?: SizeVariant;
}

/** Status glyph plus its word, on the caption role in the muted color. */
const AgentStatusLabel = forwardRef<HTMLSpanElement, AgentStatusLabelProps>(
  ({ status, label, size, className, ...props }, ref) => {
    const sizeClasses = useSize(size);
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex min-w-0 items-center gap-1.5 text-muted-foreground',
          sizeClasses.type.caption,
          className,
        )}
        {...props}
      >
        <AgentStatusIcon status={status} size={sizeClasses.variant === 'compact' ? 11 : 12} />
        <span className="truncate">{label ?? agentStatusLabels[status]}</span>
      </span>
    );
  },
);
AgentStatusLabel.displayName = 'AgentStatusLabel';

interface AgentStatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  status: AgentStatus;
  label?: ReactNode;
  /** Show the glyph before the word. */
  icon?: boolean;
}

/** A Badge tinted by status (`Running`, `Needs you`, `Failed` …). */
const AgentStatusBadge = forwardRef<HTMLSpanElement, AgentStatusBadgeProps>(
  ({ status, label, icon = true, className, ...props }, ref) => (
    <Badge ref={ref} color={agentStatusBadgeColor[status]} className={className} {...props}>
      <span className="inline-flex items-center gap-1">
        {icon && <AgentStatusIcon status={status} size={11} />}
        {label ?? agentStatusLabels[status]}
      </span>
    </Badge>
  ),
);
AgentStatusBadge.displayName = 'AgentStatusBadge';

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * Inline counterpart of `Elevated` (a span, so it can sit inside text). A mark this small takes the
 * next surface's background with only the hairline of the first shadow step: the full drop ladder
 * belongs to cards and popups, and on a 16–28px tile it reads as a heavier object than the card
 * that holds it.
 */
function RaisedSpan({
  offset,
  className,
  style,
  children,
}: {
  offset: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const level = Math.min(useSurface() + offset, 8);
  return (
    <span className={cn(SURFACE_BG[level], 'shadow-surface-1', className)} style={style}>
      {children}
    </span>
  );
}

/** A brand mark by name, or any icon component. */
type AgentMark = AgentLogoName | IconComponent;

function resolveMark(mark: AgentMark | undefined): IconComponent | undefined {
  if (mark === undefined) return undefined;
  if (typeof mark === 'string') return isAgentLogoName(mark) ? agentLogos[mark] : undefined;
  return mark;
}

interface AgentAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** Used for the initials fallback and the accessible label. */
  name: string;
  /** Brand mark (`"claude"`) or an icon component. Omitted, shows initials. */
  logo?: AgentMark;
  /** Tile size in px. Omitted: 28 default, 24 compact. */
  size?: number;
  /** Status dot on the corner. */
  status?: AgentStatus;
  /** Hide from assistive tech when a visible name sits beside it (default). */
  decorative?: boolean;
}

/** A raised square tile with the agent's mark or initials. */
const AgentAvatar = forwardRef<HTMLSpanElement, AgentAvatarProps>(
  ({ name, logo, size, status, decorative = true, className, style, ...props }, ref) => {
    const shape = useShape();
    const sizeClasses = useSize();
    const px = size ?? (sizeClasses.variant === 'compact' ? 24 : 28);
    const Mark = resolveMark(logo);
    const radius = shape.variant === 'pill' ? px / 2 : Math.round(px / 4);
    return (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label is set only with role="img".
      <span
        ref={ref}
        className={cn('relative inline-flex shrink-0', className)}
        style={{ width: px, height: px, ...style }}
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative || undefined}
        {...props}
      >
        <RaisedSpan
          offset={1}
          className="grid size-full place-items-center overflow-hidden text-muted-foreground"
          style={{ borderRadius: radius }}
        >
          {Mark ? (
            <Mark size={Math.round(px * 0.57)} />
          ) : (
            <span
              className={px >= 28 ? typeClass('caption') : typeClass('micro')}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {initials(name)}
            </span>
          )}
        </RaisedSpan>
        {status && (
          <span
            className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-[var(--background)]"
            style={{ backgroundColor: agentStatusColor[status] }}
          />
        )}
      </span>
    );
  },
);
AgentAvatar.displayName = 'AgentAvatar';

interface ToolStackProps extends HTMLAttributes<HTMLSpanElement> {
  tools: AgentMark[];
  /** Marks shown before the `+N` overflow count. */
  max?: number;
  /** Tile size in px. */
  size?: number;
}

/** Overlapping tool marks with a `+N` overflow (e.g. the tools an agent can call). */
const ToolStack = forwardRef<HTMLSpanElement, ToolStackProps>(
  ({ tools, max = 3, size = 18, className, ...props }, ref) => {
    const shown = tools.slice(0, max);
    const rest = tools.length - shown.length;
    return (
      <span ref={ref} className={cn('inline-flex items-center', className)} aria-hidden {...props}>
        {shown.map((tool, i) => {
          const Mark = resolveMark(tool);
          return (
            <RaisedSpan
              // biome-ignore lint/suspicious/noArrayIndexKey: tool marks may repeat and never reorder.
              key={i}
              offset={1}
              className={cn('grid place-items-center rounded-full', i > 0 && '-ml-1')}
              style={{ width: size, height: size }}
            >
              {Mark && <Mark size={Math.round(size * 0.62)} />}
            </RaisedSpan>
          );
        })}
        {rest > 0 && (
          <span className={cn(typeClass('micro'), 'pl-1 text-muted-foreground tabular-nums')}>
            +{rest}
          </span>
        )}
      </span>
    );
  },
);
ToolStack.displayName = 'ToolStack';

interface AgentIdentityProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  /** Model or role line under the name (`Opus 5.5`). */
  model?: ReactNode;
  logo?: AgentMark;
  status?: AgentStatus;
  avatarSize?: number;
  /** Trailing content on the name line (a badge, a cost). */
  trailing?: ReactNode;
}

/** Avatar, name, and model line: the header of most agent cards and rows. */
const AgentIdentity = forwardRef<HTMLDivElement, AgentIdentityProps>(
  ({ name, model, logo, status, avatarSize, trailing, className, ...props }, ref) => {
    const sizeClasses = useSize();
    return (
      <div ref={ref} className={cn('flex min-w-0 items-center gap-2.5', className)} {...props}>
        <AgentAvatar name={name} logo={logo} status={status} size={avatarSize} />
        <div className="grid min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(sizeClasses.type.body, 'truncate text-foreground')}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {name}
            </span>
            {trailing}
          </div>
          {model !== undefined && (
            <span className={cn(sizeClasses.type.caption, 'truncate text-muted-foreground')}>
              {model}
            </span>
          )}
        </div>
      </div>
    );
  },
);
AgentIdentity.displayName = 'AgentIdentity';

// ─── Surfaces ────────────────────────────────────────────────────────────────

interface AgentCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Surface steps above the substrate (2 for a card on the page). */
  offset?: number;
}

/** The raised container every agent component sits in. */
const AgentCard = forwardRef<HTMLDivElement, AgentCardProps>(
  ({ offset = 2, className, ...props }, ref) => {
    const shape = useShape();
    return (
      <Elevated
        ref={ref}
        offset={offset}
        className={cn('relative min-w-0 overflow-hidden', shape.container, className)}
        {...props}
      />
    );
  },
);
AgentCard.displayName = 'AgentCard';

// ─── Live readouts ───────────────────────────────────────────────────────────

interface MeterProps extends HTMLAttributes<HTMLDivElement> {
  /** 0–1. */
  value: number;
  /** Fill color (CSS). Defaults to the foreground. */
  color?: string;
  /** Accessible label; omit to hide the meter from assistive tech. */
  label?: string;
}

/** A thin progress bar; the fill scales (transform only) on the moderate spring. */
const Meter = forwardRef<HTMLDivElement, MeterProps>(
  ({ value, color = 'var(--foreground)', label, className, ...props }, ref) => {
    const v = Math.max(0, Math.min(1, value));
    return (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label is set only with role="progressbar".
      <div
        ref={ref}
        className={cn('relative h-1 overflow-hidden rounded-full bg-active', className)}
        role={label ? 'progressbar' : undefined}
        aria-label={label}
        aria-valuemin={label ? 0 : undefined}
        aria-valuemax={label ? 100 : undefined}
        aria-valuenow={label ? Math.round(v * 100) : undefined}
        aria-hidden={label ? undefined : true}
        {...props}
      >
        <motion.div
          className="absolute inset-0 origin-left rounded-full"
          style={{ backgroundColor: color }}
          initial={false}
          animate={{ scaleX: v }}
          transition={spring.moderate}
        />
      </div>
    );
  },
);
Meter.displayName = 'Meter';

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Fill under the line. */
  area?: boolean;
  className?: string;
}

/** A small line chart; draws in on mount with pathLength. */
function Sparkline({
  values,
  width = 120,
  height = 28,
  color = 'var(--muted-foreground)',
  area = true,
  className,
}: SparklineProps) {
  const uid = useId().replace(/:/g, '');
  const reduce = useReducedMotion() ?? false;
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 1 - (v / max) * (height - 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const fill = `${line} L${width} ${height} L0 ${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
    >
      {area && (
        <>
          <defs>
            <linearGradient id={`${uid}-a`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.18" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fill} fill={`url(#${uid}-a)`} />
        </>
      )}
      <motion.path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={spring.slow}
      />
    </svg>
  );
}

/** A small dot that breathes while something is live. */
function LiveDot({
  color = 'var(--emphasis)',
  live = true,
  className,
}: {
  color?: string;
  live?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <span className={cn('relative inline-flex size-1.5 shrink-0', className)} aria-hidden>
      <span className="absolute inset-0 rounded-full" style={{ backgroundColor: color }} />
      {live && !reduce && (
        <motion.span
          className="absolute -inset-1 rounded-full"
          style={{ backgroundColor: color }}
          initial={{ opacity: 0.35, scale: 0.6 }}
          animate={{ opacity: 0, scale: 1.6 }}
          transition={loop.ping}
        />
      )}
    </span>
  );
}

/** A keyboard key cap on the micro role. */
function Keycap({ children, className }: { children: ReactNode; className?: string }) {
  const shape = useShape();
  return (
    <kbd
      className={cn(
        typeClass('micro'),
        shape.chip,
        'inline-flex h-[18px] min-w-[18px] items-center justify-center border border-border px-1 font-sans text-muted-foreground',
      )}
    >
      <span className={className}>{children}</span>
    </kbd>
  );
}

/**
 * Pins a component's subtree to one size step when `size` is passed, and
 * follows the surrounding SizeProvider otherwise. Agent components wrap
 * their root in it so every one takes the kit's `size` prop.
 */
function SizeScope({ size, children }: { size?: SizeVariant; children: ReactNode }) {
  return size ? <SizeProvider size={size}>{children}</SizeProvider> : <>{children}</>;
}

/** The `·` between meta items. */
function MetaDot() {
  return (
    <span aria-hidden className="text-muted-foreground">
      ·
    </span>
  );
}

export type {
  AgentAvatarProps,
  AgentCardProps,
  AgentIdentityProps,
  AgentMark,
  AgentStatus,
  AgentStatusBadgeProps,
  AgentStatusIconProps,
  AgentStatusLabelProps,
  AgentTone,
  MeterProps,
  SparklineProps,
  ToolStackProps,
};
export {
  AgentAvatar,
  AgentCard,
  AgentIdentity,
  AgentStatusBadge,
  AgentStatusIcon,
  AgentStatusLabel,
  agentStatusBadgeColor,
  agentStatusColor,
  agentStatusLabels,
  Keycap,
  LiveDot,
  MetaDot,
  Meter,
  resolveMark,
  SizeScope,
  Sparkline,
  ToolStack,
  toneColor,
  toneFill,
};
