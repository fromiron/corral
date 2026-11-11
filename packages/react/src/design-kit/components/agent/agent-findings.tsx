'use client';

// Verification panel: a header with checks progress and severity totals, one
// progress row per agent (pressing a row filters the feed to that agent), and
// a feed of the latest findings with their severity. Counts derive from the
// `findings` list; relative times tick from `useNow`.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { forwardRef, type HTMLAttributes, type ReactNode, useRef } from 'react';
import { useControllable } from '../../hooks/use-controllable.ts';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { useNow } from '../../hooks/use-now.ts';
import { formatRelative } from '../../lib/agent-format.ts';
import { agentLogos } from '../../lib/agent-logos.tsx';
import { focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { assignRef, cn } from '../../lib/utils.ts';
import { FluidHoverHighlight } from '../ui/fluid-hover-highlight.tsx';
import {
  AgentAvatar,
  AgentCard,
  type AgentMark,
  type AgentStatus,
  MetaDot,
  Meter,
  RollNumber,
  SizeScope,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** How serious a finding is. Notes show in the feed but not in the totals. */
type FindingSeverity = 'critical' | 'warning' | 'note';

interface FindingsAgent {
  id: string;
  name: string;
  /** Brand mark or icon; omitted, the avatar shows initials. */
  logo?: AgentMark;
  status: AgentStatus;
  /** What the agent is doing now (`Tracing calls in Vault.withdraw`). */
  step?: ReactNode;
  /** Checks finished. */
  done: number;
  /** Checks planned. */
  total: number;
}

interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  /** `id` of the agent that reported it. */
  agentId: string;
  /** Source location (`Vault.sol:142`), shown as code. */
  location?: string;
  /** When it was found (epoch ms). */
  at: number;
}

interface AgentFindingsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Header title. */
  title?: ReactNode;
  agents: FindingsAgent[];
  /** Newest first. */
  findings: Finding[];
  /** Rows the feed shows before older findings drop off. */
  maxFindings?: number;
  /** Feed heading. */
  feedLabel?: ReactNode;
  /** Agent whose findings the feed is filtered to (controlled); `null` shows all. */
  selectedAgentId?: string | null;
  /** Initial filter when uncontrolled. */
  defaultSelectedAgentId?: string | null;
  onSelectedAgentChange?: (id: string | null) => void;
  /** Called when a finding row is pressed (open it in the editor, say). Omit
   *  and the rows are plain text, not buttons. */
  onFindingSelect?: (finding: Finding) => void;
  /** Fixed clock for relative times; omitted, ticks live. */
  now?: number;
  /** Density step for the panel and everything inside it. Omitted, follows the nearest `SizeProvider`. */
  size?: SizeVariant;
  /** Localized text and names; the source English is the default. Title and feed heading keep their props. */
  labels?: Partial<AgentFindingsLabels>;
}

interface AgentFindingsLabels {
  /** Checks progress beside the title. */
  checks: (done: number, total: number) => string;
  /** The word after a header total. */
  severityWord: (severity: 'critical' | 'warning', count: number) => string;
  /** Spoken severity totals. */
  counts: (critical: number, warnings: number) => string;
  /** Spoken before a finding's title. */
  severity: Record<FindingSeverity, string>;
  /** Accessible name of the agent list. */
  agents: string;
  /** Accessible name of the chip that clears the agent filter. */
  clearFilter: (agent: string) => string;
  /** Shown when the feed is empty; `agent` while filtered. */
  empty: (agent?: string) => string;
  /** A finding's age. */
  time: (at: number, now: number) => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  critical: 'var(--destructive)',
  warning: 'var(--warning)',
  note: 'var(--info)',
};

const SEVERITY_WORD: Record<FindingSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  note: 'Note',
};

// Cell opacities of the 2×2 severity mark: fuller grid, more severe.
const MARK_CELLS: Record<FindingSeverity, number[]> = {
  critical: [1, 1, 1, 0.6],
  warning: [1, 0.6, 0.6, 0.3],
  note: [0.6, 0.3, 0.3, 0.3],
};

function SeverityMark({ severity, muted = false }: { severity: FindingSeverity; muted?: boolean }) {
  const cells = MARK_CELLS[severity];
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 10 10"
      aria-hidden
      className={cn('shrink-0', muted && 'text-muted-foreground')}
      style={muted ? undefined : { color: SEVERITY_COLOR[severity] }}
    >
      {[
        [0, 0],
        [5.5, 0],
        [0, 5.5],
        [5.5, 5.5],
      ].map(([x, y], i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: four fixed cells, never reordered.
          key={i}
          x={x}
          y={y}
          width={4.5}
          height={4.5}
          rx={1}
          fill="currentColor"
          opacity={cells[i]}
        />
      ))}
    </svg>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function countLabel(critical: number, warnings: number) {
  return `${plural(critical, 'critical', 'critical')}, ${plural(warnings, 'warning', 'warnings')}`;
}

function shortRelative(at: number, now: number) {
  return formatRelative(at, now).replace(/ ago$/, '');
}

const defaultLabels: AgentFindingsLabels = {
  checks: (done, total) => `${done} of ${total} checks`,
  severityWord: (severity, n) =>
    severity === 'critical' ? 'critical' : n === 1 ? 'warning' : 'warnings',
  counts: countLabel,
  severity: SEVERITY_WORD,
  agents: 'Agents',
  clearFilter: (agent) => `Show findings from all agents (filtered to ${agent})`,
  empty: (agent) => (agent ? `No findings from ${agent} yet` : 'No findings yet'),
  time: shortRelative,
};

// ─── Component ───────────────────────────────────────────────────────────────

const AgentFindings = forwardRef<HTMLDivElement, AgentFindingsProps>(({ size, ...props }, ref) => (
  <SizeScope size={size}>
    <AgentFindingsInner ref={ref} {...props} />
  </SizeScope>
));
AgentFindings.displayName = 'AgentFindings';

const AgentFindingsInner = forwardRef<HTMLDivElement, Omit<AgentFindingsProps, 'size'>>(
  (
    {
      title = 'Verification',
      agents,
      findings,
      maxFindings = 3,
      feedLabel = 'Latest findings',
      selectedAgentId,
      defaultSelectedAgentId = null,
      onSelectedAgentChange,
      onFindingSelect,
      now: nowProp,
      labels: labelOverrides,
      className,
      ...props
    },
    ref,
  ) => {
    const sizeClasses = useSize();
    const shape = useShape();
    const icons = useIcons();
    const CloseIcon = icons.x;
    const liveNow = useNow(5000, nowProp === undefined);
    const now = nowProp ?? liveNow;
    const labels = { ...defaultLabels, ...labelOverrides };

    const [selected, select] = useControllable(
      selectedAgentId,
      defaultSelectedAgentId,
      onSelectedAgentChange,
    );

    const checksDone = agents.reduce((sum, a) => sum + a.done, 0);
    const checksTotal = agents.reduce((sum, a) => sum + a.total, 0);
    const count = (severity: FindingSeverity, agentId?: string) =>
      findings.filter(
        (f) => f.severity === severity && (agentId === undefined || f.agentId === agentId),
      ).length;
    const totalCritical = count('critical');
    const totalWarnings = count('warning');

    const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
    const selectedAgent = selected ? agents.find((a) => a.id === selected) : undefined;
    const feed = findings.filter((f) => !selected || f.agentId === selected).slice(0, maxFindings);

    const agentsRef = useRef<HTMLUListElement>(null);
    const agentsHover = useFluidHover(agentsRef);
    const feedRef = useRef<HTMLOListElement>(null);
    const feedHover = useFluidHover(feedRef);

    return (
      <AgentCard
        ref={ref}
        className={cn('@container', sizeClasses.type.body, className)}
        {...props}
      >
        <header className="flex min-w-0 items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="grid shrink-0 place-items-center text-emphasis">
            <agentLogos.spark size={14} />
          </span>
          <span
            className="min-w-0 truncate text-foreground"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {title}
          </span>
          <span
            className={cn(
              sizeClasses.type.caption,
              'min-w-0 flex-1 truncate text-muted-foreground tabular-nums',
            )}
          >
            {labels.checks(checksDone, checksTotal)}
          </span>
          <span
            role="img"
            className={cn(sizeClasses.type.caption, 'flex shrink-0 items-center gap-3')}
            aria-label={labels.counts(totalCritical, totalWarnings)}
          >
            {(
              [
                ['critical', totalCritical],
                ['warning', totalWarnings],
              ] as const
            ).map(([severity, n]) => (
              <span
                key={severity}
                aria-hidden
                className={cn(
                  'inline-flex items-baseline gap-1',
                  n === 0 && 'text-muted-foreground',
                )}
                style={n === 0 ? undefined : { color: SEVERITY_COLOR[severity] }}
              >
                <b style={{ fontVariationSettings: fontWeights.semibold }}>
                  <RollNumber value={n} />
                </b>
                {labels.severityWord(severity, n)}
              </span>
            ))}
          </span>
        </header>

        <ul
          ref={agentsRef}
          aria-label={labels.agents}
          className="relative grid p-1.5"
          {...agentsHover.handlers}
        >
          <FluidHoverHighlight hover={agentsHover} className={shape.bg} />
          {agents.map((agent, i) => (
            <AgentRow
              key={agent.id}
              index={i}
              register={agentsHover.registerItem}
              agent={agent}
              critical={count('critical', agent.id)}
              warnings={count('warning', agent.id)}
              countsLabel={labels.counts}
              pressed={selected === agent.id}
              onPress={() => select(selected === agent.id ? null : agent.id)}
            />
          ))}
        </ul>

        <div className="mt-1 flex h-10 items-center gap-2 border-t border-border px-4">
          <span className={cn(sizeClasses.type.caption, 'text-muted-foreground')}>{feedLabel}</span>
          <AnimatePresence initial={false}>
            {selectedAgent && (
              <motion.button
                key={selectedAgent.id}
                type="button"
                onClick={() => select(null)}
                aria-label={labels.clearFilter(selectedAgent.name)}
                className={cn(
                  sizeClasses.type.caption,
                  shape.bg,
                  'inline-flex h-5 items-center gap-1 bg-active pr-1.5 pl-2 text-foreground',
                )}
                style={{ fontVariationSettings: fontWeights.semibold }}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: spring.fast.exit }}
                transition={spring.moderate}
              >
                {selectedAgent.name}
                <CloseIcon size={12} strokeWidth={1.5} className="text-muted-foreground" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        <ol
          ref={feedRef}
          aria-live="polite"
          className="relative mx-1.5 grid pb-2"
          {...feedHover.handlers}
        >
          <FluidHoverHighlight hover={feedHover} className={shape.bg} />
          {feed.length === 0 && (
            <li
              className={cn(
                sizeClasses.type.caption,
                'grid h-10 place-items-center text-muted-foreground',
              )}
            >
              {labels.empty(selectedAgent?.name)}
            </li>
          )}
          <AnimatePresence initial={false} mode="popLayout">
            {feed.map((finding, i) => (
              <FindingRow
                key={finding.id}
                index={i}
                register={feedHover.registerItem}
                finding={finding}
                agentName={nameOf(finding.agentId)}
                time={labels.time(finding.at, now)}
                severityWord={labels.severity[finding.severity]}
                onSelect={onFindingSelect}
              />
            ))}
          </AnimatePresence>
        </ol>
      </AgentCard>
    );
  },
);
AgentFindingsInner.displayName = 'AgentFindingsInner';

// ─── Rows ────────────────────────────────────────────────────────────────────

interface AgentRowProps {
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  agent: FindingsAgent;
  critical: number;
  warnings: number;
  countsLabel: AgentFindingsLabels['counts'];
  pressed: boolean;
  onPress: () => void;
}

function AgentRow({
  index,
  register,
  agent,
  critical,
  warnings,
  countsLabel,
  pressed,
  onPress,
}: AgentRowProps) {
  const ref = useRef<HTMLLIElement>(null);
  useRegisterFluidHoverItem(register, index, ref);
  const sizeClasses = useSize();
  const shape = useShape();
  const reduce = useReducedMotion() ?? false;
  const progress = agent.total > 0 ? agent.done / agent.total : 0;
  const fill =
    agent.status === 'failed'
      ? 'var(--destructive)'
      : agent.status === 'running'
        ? 'var(--emphasis)'
        : 'var(--muted-foreground)';

  return (
    <li ref={ref} data-fluid-hover-index={index} className="relative z-10">
      <button
        type="button"
        aria-pressed={pressed}
        data-status={agent.status}
        onClick={onPress}
        className={cn(
          shape.bg,
          'grid h-12 w-full grid-cols-[24px_minmax(0,1fr)_128px_40px_60px] items-center gap-3 px-2.5 text-left',
          '@max-[480px]:grid-cols-[24px_minmax(0,1fr)_52px_60px] @max-[480px]:gap-2.5',
          focusRingInset,
          pressed && 'bg-selected',
        )}
      >
        <AgentAvatar name={agent.name} logo={agent.logo} size={24} />
        <span className="grid min-w-0">
          <span
            className="truncate text-foreground"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {agent.name}
          </span>
          {agent.step !== undefined && (
            <motion.span
              key={typeof agent.step === 'string' ? agent.step : undefined}
              className={cn(sizeClasses.type.caption, 'truncate text-muted-foreground')}
              initial={reduce ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring.moderate}
            >
              {agent.step}
            </motion.span>
          )}
        </span>
        <Meter
          value={progress}
          color={fill}
          live={agent.status === 'running'}
          className="h-1.5 @max-[480px]:hidden"
        />
        <span
          className={cn(sizeClasses.type.caption, 'text-right text-muted-foreground tabular-nums')}
        >
          {agent.done}/{agent.total}
        </span>
        <span
          role="img"
          className={cn(sizeClasses.type.caption, 'flex items-center justify-end gap-2.5')}
          aria-label={countsLabel(critical, warnings)}
        >
          {(
            [
              ['critical', critical],
              ['warning', warnings],
            ] as const
          ).map(([severity, n]) => (
            <span key={severity} aria-hidden className="inline-flex items-center gap-1">
              <SeverityMark severity={severity} muted={n === 0} />
              <b
                className={n === 0 ? 'text-muted-foreground' : undefined}
                style={{
                  fontVariationSettings: fontWeights.semibold,
                  ...(n === 0 ? undefined : { color: SEVERITY_COLOR[severity] }),
                }}
              >
                <RollNumber value={n} />
              </b>
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}

interface FindingRowProps {
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  finding: Finding;
  agentName: string;
  time: string;
  /** Spoken severity before the title. */
  severityWord: string;
  onSelect?: (finding: Finding) => void;
}

const FindingRow = forwardRef<HTMLLIElement, FindingRowProps>(
  ({ index, register, finding, agentName, time, severityWord, onSelect }, forwardedRef) => {
    const ref = useRef<HTMLLIElement>(null);
    useRegisterFluidHoverItem(register, index, ref);
    const sizeClasses = useSize();
    const shape = useShape();
    const reduce = useReducedMotion() ?? false;
    const setRef = (el: HTMLLIElement | null) => {
      ref.current = el;
      assignRef(forwardedRef, el);
    };
    const rowClass = cn(
      shape.bg,
      'flex size-full min-w-0 items-center gap-2.5 px-2.5 text-left',
      focusRingInset,
    );
    const content = (
      <>
        <SeverityMark severity={finding.severity} />
        <span className="sr-only">{severityWord}:</span>
        <span className="min-w-0 shrink truncate text-foreground">{finding.title}</span>
        <span
          className={cn(
            sizeClasses.type.caption,
            'flex min-w-0 flex-1 basis-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground',
          )}
        >
          <span className="truncate">{agentName}</span>
          {finding.location && (
            <>
              <MetaDot />
              <code className="truncate font-mono">{finding.location}</code>
            </>
          )}
        </span>
        <span
          className={cn(
            sizeClasses.type.caption,
            'min-w-7 shrink-0 text-right text-muted-foreground tabular-nums',
          )}
        >
          {time}
        </span>
      </>
    );

    return (
      <motion.li
        ref={setRef}
        layout="position"
        data-fluid-hover-index={index}
        className="relative z-10 h-10"
        initial={reduce ? false : { opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: spring.moderate.exit }}
        transition={spring.slow}
      >
        {/* Without a select callback the row is text, not a button that does nothing. */}
        {onSelect ? (
          <button type="button" onClick={() => onSelect(finding)} className={rowClass}>
            {content}
          </button>
        ) : (
          <div className={rowClass}>{content}</div>
        )}
      </motion.li>
    );
  },
);
FindingRow.displayName = 'FindingRow';

export type { AgentFindingsLabels, AgentFindingsProps, Finding, FindingSeverity, FindingsAgent };
export { AgentFindings, SeverityMark };
