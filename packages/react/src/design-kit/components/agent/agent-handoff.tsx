'use client';

// Handoff board: one card per agent in a row (role, cost, Working/Idle, the
// current task or the up-next queue), and under each pair of neighbours the
// queue of work handed from one to the next. Elbow lines run from each agent
// down into the queue it feeds and back up to the agent it hands to; they are
// measured from the rendered cards, so they follow any width.

import { AnimatePresence, motion } from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { formatCost } from '../../lib/agent-format.ts';
import { focusRing, focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { type IconName, useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Tooltip } from '../ui/tooltip.tsx';
import {
  AgentAvatar,
  AgentCard,
  type AgentMark,
  AgentStatusIcon,
  resolveMark,
  SizeScope,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A task as it appears on an agent card. */
interface HandoffTask {
  title: string;
  /** Tool or app mark shown before the title. */
  logo?: AgentMark;
  /** What the agent is doing on it right now ("Reading sources"). Working only. */
  note?: string;
}

interface HandoffAgent {
  id: string;
  /** Role name ("Researcher"). */
  name: string;
  /** Model label ("Opus 5.5"). */
  model?: string;
  /** Avatar mark: brand logo name or icon component. */
  logo?: AgentMark;
  /** Spend so far, in dollars. */
  cost?: number;
  /** One or two lines on what this agent does. */
  description?: string;
  /** Working (has a current task) or Idle. */
  working?: boolean;
  /** Hosts can omit navigation for a destination with no observed execution. */
  selectable?: boolean;
  /** Actual runtime state, when the host has more than working/idle. */
  statusLabel?: string;
  /** Observed state below the identity when there is no queued task. */
  idleLabel?: string;
  /** The task in progress. Shown while `working`. */
  task?: HandoffTask;
  /** Tasks waiting for this agent. The first is shown as "Up next" while idle. */
  queue?: HandoffTask[];
}

type HandoffItemKind = 'file' | 'data' | 'note' | 'link' | 'image';

/** One thing passed along with a card (a file, a dataset, an instruction). */
interface HandoffItem {
  id: string;
  label: string;
  kind?: HandoffItemKind;
  /** Dropped in the handoff: struck through in red. */
  lost?: boolean;
  /** Why it was dropped, shown on hover/focus of a lost item. */
  lostReason?: string;
}

type HandoffCardStatus = 'done' | 'warning' | 'running';

/** A unit of work sitting in a handoff queue. */
interface HandoffCard {
  id: string;
  title: string;
  /** Leading mark. Defaults to a document glyph. */
  logo?: AgentMark;
  status?: HandoffCardStatus;
  /** Footer text. Defaults per status ("Looks good", "Check before use", "Handing off"). */
  stateLabel?: string;
  items: HandoffItem[];
  /** Host details/actions, outside the disclosure button. */
  detail?: ReactNode;
}

/** The queue between two agents. */
interface HandoffLane {
  /** Agent id handing off. */
  from: string;
  /** Agent id receiving. */
  to: string;
  cards: HandoffCard[];
  /** Work has flowed through this lane: lines draw in the active color. */
  passed?: boolean;
  /** Names the precise observed relationship (read, input, question…). */
  label?: string;
}

interface AgentHandoffProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** Agents in flow order, left to right. */
  agents: HandoffAgent[];
  /** Queues between neighbouring agents. */
  lanes: HandoffLane[];
  /** Expanded card id (controlled). */
  expandedCardId?: string | null;
  /** Initially expanded card id (uncontrolled). */
  defaultExpandedCardId?: string | null;
  /** Called when a card is expanded or collapsed (null). */
  onExpandedCardChange?: (cardId: string | null, laneIndex: number) => void;
  /** Called when an agent card is clicked or activated with the keyboard. */
  onAgentSelect?: (agentId: string) => void;
  /** Text for an empty lane. */
  emptyLaneLabel?: string;
  labels?: { working?: string; idle?: string; upNext?: string; ready?: string };
  /** Density step for the whole board; omitted, inherits the nearest SizeProvider. */
  size?: SizeVariant;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const kindIcon: Record<HandoffItemKind, IconName> = {
  file: 'folder',
  data: 'square-library',
  note: 'pencil',
  link: 'link',
  image: 'image',
};

const stateLabels: Record<HandoffCardStatus, string> = {
  done: 'Looks good',
  warning: 'Check before use',
  running: 'Handing off',
};

const stateColor: Record<HandoffCardStatus, string> = {
  done: 'var(--success)',
  warning: 'var(--warning)',
  running: 'var(--emphasis)',
};

/** Vertical, then horizontal, then vertical, with rounded corners at mid height. */
function elbow(x1: number, y1: number, x2: number, y2: number, midY: number, r = 10): string {
  const sx = Math.sign(x2 - x1) || 1;
  const sy1 = Math.sign(midY - y1) || 1;
  const sy2 = Math.sign(y2 - midY) || 1;
  const rr = Math.min(r, Math.abs(x2 - x1) / 2, Math.abs(midY - y1), Math.abs(y2 - midY));
  return [
    `M${x1} ${y1}`,
    `V${midY - sy1 * rr}`,
    `Q${x1} ${midY} ${x1 + sx * rr} ${midY}`,
    `H${x2 - sx * rr}`,
    `Q${x2} ${midY} ${x2} ${midY + sy2 * rr}`,
    `V${y2}`,
  ].join('');
}

interface LaneGeometry {
  inPath: string;
  outPath: string;
  dots: [number, number][];
}

// ─── Agent card ──────────────────────────────────────────────────────────────

function AgentTile({
  agent,
  index,
  onSelect,
  tileRef,
  labels,
}: {
  agent: HandoffAgent;
  index: number;
  onSelect?: (id: string) => void;
  tileRef: (el: HTMLDivElement | null) => void;
  labels?: AgentHandoffProps['labels'];
}) {
  const size = useSize();
  const shape = useShape();
  const working = !!agent.working && !!agent.task;
  const upNext = agent.queue?.[0];
  const more = (agent.queue?.length ?? 0) - 1;
  const nowKey = working ? `task:${agent.task?.title}` : upNext ? `next:${upNext.title}` : 'ready';
  const label =
    working && agent.task
      ? `${agent.name} – ${agent.task.title}`
      : upNext
        ? `${agent.name} – ${upNext.title}`
        : agent.name;
  const swap = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: spring.moderate },
    exit: { opacity: 0, y: -10, transition: spring.moderate.exit },
  };

  return (
    <AgentCard
      ref={tileRef}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={label}
      data-status={working ? 'working' : 'idle'}
      onClick={() => onSelect?.(agent.id)}
      onKeyDown={(e) => {
        if (onSelect && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect?.(agent.id);
        }
      }}
      style={{ '--c': 2 * index + 1 } as CSSProperties}
      className={cn(
        '@container/agent z-10 row-start-1 grid w-[calc(100%-16px)] max-w-[300px] gap-2.5 justify-self-center p-3.5 pb-3',
        onSelect && 'cursor-pointer',
        onSelect && focusRing,
        '[grid-column:var(--c)/span_2] @max-[620px]/handoff:[grid-column:1] @max-[620px]/handoff:row-auto @max-[620px]/handoff:w-full @max-[620px]/handoff:max-w-none @max-[620px]/handoff:[order:var(--c)]',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AgentAvatar name={agent.name} logo={agent.logo} size={26} decorative />
        <span className="grid min-w-[3em] flex-1">
          <span
            className={cn('truncate text-foreground', size.type.body)}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {agent.name}
          </span>
          {agent.model && (
            <span className={cn('truncate text-muted-foreground', size.type.caption)}>
              {agent.model}
            </span>
          )}
        </span>
        {agent.cost != null && (
          <span
            className={cn(
              'shrink-0 tabular-nums text-muted-foreground',
              size.type.caption,
              working && 'sheen',
            )}
          >
            {formatCost(agent.cost)}
          </span>
        )}
        <span
          className={cn(
            'inline-flex h-[18px] shrink-0 items-center gap-1 overflow-hidden px-1.5',
            shape.chip,
            '@max-[200px]/agent:w-5 @max-[200px]/agent:justify-center @max-[200px]/agent:px-0',
            !working && '@max-[200px]/agent:hidden',
            size.type.caption,
          )}
          style={{
            fontVariationSettings: fontWeights.semibold,
            color: working ? 'var(--emphasis)' : 'var(--foreground)',
            background: working
              ? 'color-mix(in srgb, var(--emphasis) 12%, transparent)'
              : 'var(--accent)',
          }}
        >
          {working && <AgentStatusIcon status="running" size={11} colored={false} />}
          <span className="relative grid @max-[200px]/agent:hidden">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={working ? 'w' : 'i'} {...swap} className="[grid-area:1/1]">
                {agent.statusLabel ??
                  (working ? (labels?.working ?? 'Working') : (labels?.idle ?? 'Idle'))}
              </motion.span>
            </AnimatePresence>
          </span>
        </span>
      </span>

      {agent.description && (
        <span className={cn('line-clamp-2 h-9 text-muted-foreground', size.type.caption)}>
          {agent.description}
        </span>
      )}

      <span
        className={cn(
          'grid h-8 min-w-0 items-center overflow-hidden bg-muted px-2.5',
          shape.bg,
          size.type.caption,
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={nowKey}
            {...swap}
            className="flex min-w-0 items-center gap-1.5 [grid-area:1/1]"
          >
            {working && agent.task ? (
              <>
                <TaskMark logo={agent.task.logo} />
                <span
                  className="max-w-[55%] shrink-0 truncate text-foreground"
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {agent.task.title}
                </span>
                {agent.task.note && (
                  <span className="shimmer-text min-w-0 truncate">{agent.task.note}</span>
                )}
              </>
            ) : upNext ? (
              <>
                <span className="shrink-0 text-muted-foreground">
                  {labels?.upNext ?? 'Up next'}
                </span>
                <TaskMark logo={upNext.logo} />
                <span
                  className="max-w-[55%] shrink-0 truncate text-foreground"
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {upNext.title}
                </span>
                {more > 0 && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">+{more}</span>
                )}
              </>
            ) : (
              <span className="text-foreground">
                {agent.idleLabel ?? labels?.ready ?? 'Ready for a task'}
              </span>
            )}
          </motion.span>
        </AnimatePresence>
      </span>
    </AgentCard>
  );
}

function TaskMark({ logo }: { logo?: AgentMark }) {
  const shape = useShape();
  const Icon = resolveMark(logo);
  if (!Icon) return null;
  return (
    <span
      className={cn(
        'grid size-4 shrink-0 place-items-center bg-background text-muted-foreground shadow-surface-2',
        shape.chip,
      )}
    >
      <Icon size={11} aria-hidden />
    </span>
  );
}

// ─── Handoff card ────────────────────────────────────────────────────────────

function QueueCard({
  card,
  expanded,
  onToggle,
}: {
  card: HandoffCard;
  expanded: boolean;
  onToggle: () => void;
}) {
  const size = useSize();
  const shape = useShape();
  const icons = useIcons();
  const status = card.status ?? 'done';
  const Mark = resolveMark(card.logo) ?? icons.pencil;
  const kept = card.items
    .filter((i) => !i.lost)
    .map((i) => i.label)
    .join(', ');
  const LostIcon = icons.x;

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: spring.moderate }}
      exit={{ opacity: 0, transition: spring.moderate.exit }}
      data-status={status}
      data-lost={card.items.some((i) => i.lost) || undefined}
      className={cn('bg-background shadow-surface-2', shape.bg)}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn('grid w-full gap-[3px] py-2 pl-2.5 pr-3 text-left', focusRingInset, shape.bg)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-[18px] w-3.5 shrink-0 place-items-center"
            style={{ color: 'var(--emphasis)' }}
          >
            <Mark size={14} aria-hidden />
          </span>
          <span
            className={cn('truncate text-foreground', size.type.body)}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {card.title}
          </span>
        </span>
        {kept && (
          <span className={cn('truncate pl-[22px] text-muted-foreground', size.type.caption)}>
            {kept}
          </span>
        )}
        <span
          className={cn(
            'mt-[3px] flex min-w-0 items-center gap-1.5 pl-[22px] text-muted-foreground',
            size.type.caption,
          )}
        >
          {status === 'running' ? (
            <AgentStatusIcon status="running" size={11} />
          ) : (
            <AgentStatusIcon
              status={status === 'done' ? 'done' : 'failed'}
              size={11}
              className="shrink-0"
            />
          )}
          <span
            className={cn(status === 'running' && 'shimmer-text')}
            style={{ color: status === 'warning' ? stateColor.warning : undefined }}
          >
            {card.stateLabel ?? stateLabels[status]}
          </span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ul
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: spring.moderate }}
            exit={{ opacity: 0, y: -4, transition: spring.moderate.exit }}
            className="mx-2.5 mb-2.5 grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-border pt-2"
          >
            {card.detail && <li>{card.detail}</li>}
            {card.items.map((item) => {
              const KindIcon = item.lost ? LostIcon : icons[kindIcon[item.kind ?? 'file']];
              const row = (
                <span
                  tabIndex={item.lost ? 0 : undefined}
                  data-lost={item.lost || undefined}
                  className={cn(
                    'flex h-6 w-full items-center gap-1.5 whitespace-nowrap px-2',
                    focusRingInset,
                    shape.bg,
                    size.type.caption,
                    item.lost ? 'text-muted-foreground' : 'bg-muted text-foreground',
                  )}
                  style={
                    item.lost
                      ? {
                          background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
                          boxShadow:
                            'inset 0 0 0 0.5px color-mix(in srgb, var(--destructive) 40%, transparent)',
                        }
                      : { fontVariationSettings: fontWeights.semibold }
                  }
                >
                  <span
                    className="grid shrink-0 place-items-center"
                    style={{ color: item.lost ? 'var(--destructive)' : 'var(--muted-foreground)' }}
                  >
                    <KindIcon size={12} aria-hidden />
                  </span>
                  <span
                    className="truncate"
                    style={
                      item.lost
                        ? {
                            textDecoration: 'line-through',
                            textDecorationColor: 'var(--destructive)',
                          }
                        : undefined
                    }
                  >
                    {item.lost && <span className="sr-only">Lost in handoff: </span>}
                    {item.label}
                  </span>
                </span>
              );
              return (
                <li key={item.id}>
                  {item.lost && item.lostReason ? (
                    <Tooltip content={item.lostReason}>{row}</Tooltip>
                  ) : (
                    row
                  )}
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

// ─── Board ───────────────────────────────────────────────────────────────────

const AgentHandoff = forwardRef<HTMLDivElement, AgentHandoffProps>(
  (
    {
      agents,
      lanes,
      expandedCardId,
      defaultExpandedCardId = null,
      onExpandedCardChange,
      onAgentSelect,
      emptyLaneLabel = 'Nothing handed off yet',
      labels,
      size: sizeProp,
      className,
      style,
      ...props
    },
    ref,
  ) => {
    const size = useSize(sizeProp);
    const shape = useShape();
    const icons = useIcons();
    const ArrowRight = icons['arrow-right'];

    const [innerExpanded, setInnerExpanded] = useState<string | null>(defaultExpandedCardId);
    const expanded = expandedCardId !== undefined ? expandedCardId : innerExpanded;
    // Cards can share a title across lanes, so key expansion by lane too.
    const toggle = (laneIndex: number, cardId: string) => {
      const key = `${laneIndex}:${cardId}`;
      const next = expanded === key || expanded === cardId ? null : key;
      setInnerExpanded(next);
      onExpandedCardChange?.(next === null ? null : cardId, laneIndex);
    };
    const isExpanded = (laneIndex: number, cardId: string) =>
      expanded === `${laneIndex}:${cardId}` ||
      (expandedCardId !== undefined && expanded === cardId);

    // Geometry for the connector lines, measured from the rendered cards.
    const flowRef = useRef<HTMLDivElement>(null);
    const agentEls = useRef(new Map<string, HTMLDivElement>());
    const laneEls = useRef(new Map<number, HTMLElement>());
    const [geo, setGeo] = useState<LaneGeometry[]>([]);

    const measure = useCallback(() => {
      const flow = flowRef.current;
      if (!flow) return;
      const base = flow.getBoundingClientRect();
      const next: LaneGeometry[] = [];
      lanes.forEach((lane, i) => {
        const a = agentEls.current.get(lane.from)?.getBoundingClientRect();
        const b = agentEls.current.get(lane.to)?.getBoundingClientRect();
        const l = laneEls.current.get(i)?.getBoundingClientRect();
        if (!a || !b || !l || l.top < a.bottom) {
          next.push({ inPath: '', outPath: '', dots: [] });
          return;
        }
        const ax = a.left + a.width / 2 - base.left;
        const bx = b.left + b.width / 2 - base.left;
        const ay = a.bottom - base.top;
        const by = b.bottom - base.top;
        const lc = l.left + l.width / 2 - base.left;
        const ly = l.top - base.top;
        const midY = (Math.max(ay, by) + ly) / 2;
        next.push({
          inPath: elbow(ax, ay, lc - 14, ly, midY),
          outPath: elbow(lc + 14, ly, bx, by, midY),
          dots: [
            [ax, ay],
            [bx, by],
            [lc - 14, ly],
            [lc + 14, ly],
          ],
        });
      });
      setGeo(next);
    }, [lanes]);

    useLayoutEffect(() => {
      measure();
      const flow = flowRef.current;
      if (!flow) return;
      const ro = new ResizeObserver(measure);
      ro.observe(flow);
      return () => ro.disconnect();
    }, [measure]);

    const indexOf = (id: string) => agents.findIndex((a) => a.id === id);

    return (
      <SizeScope size={sizeProp}>
        <div
          ref={ref}
          className={cn('@container/handoff relative', className)}
          style={{ ...style }}
          {...props}
        >
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible @max-[620px]/handoff:hidden"
          >
            {geo.map((g, i) => {
              // Work handing off right now flows (CSS `.flow-dash`, still under
              // reduced motion); a lane that has passed work draws in once.
              const live = !!lanes[i]?.cards.some((c) => c.status === 'running');
              return (
                <g
                  key={`${lanes[i]?.from}:${lanes[i]?.to}`}
                  stroke={lanes[i]?.passed || live ? 'var(--emphasis)' : 'var(--border)'}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  fill="none"
                >
                  {[
                    { id: 'in', path: g.inPath },
                    { id: 'out', path: g.outPath },
                  ].map(({ id, path: d }) =>
                    d ? (
                      live ? (
                        <path key={`${id}:${d}:live`} d={d} className="flow-dash" />
                      ) : (
                        <motion.path
                          key={`${id}:${d}`}
                          d={d}
                          initial={lanes[i]?.passed ? { pathLength: 0 } : false}
                          animate={{ pathLength: 1, transition: spring.slow }}
                        />
                      )
                    ) : null,
                  )}
                </g>
              );
            })}
          </svg>

          <div
            ref={flowRef}
            className="relative z-[1] grid grid-cols-1 gap-y-[72px] @min-[621px]/handoff:[grid-template-columns:var(--handoff-columns)] @max-[620px]/handoff:gap-y-3"
            style={
              {
                '--handoff-columns': `repeat(${Math.max(1, agents.length) * 2}, minmax(0, 1fr))`,
              } as CSSProperties
            }
          >
            {agents.map((agent, i) => (
              <AgentTile
                key={agent.id}
                agent={agent}
                index={i}
                labels={labels}
                onSelect={agent.selectable === false ? undefined : onAgentSelect}
                tileRef={(el) => {
                  if (el) agentEls.current.set(agent.id, el);
                  else agentEls.current.delete(agent.id);
                }}
              />
            ))}

            {lanes.map((lane, li) => {
              const from = agents[indexOf(lane.from)];
              const to = agents[indexOf(lane.to)];
              const slot = Math.max(0, indexOf(lane.from));
              return (
                <section
                  key={`${lane.from}-${lane.to}`}
                  ref={(el) => {
                    if (el) laneEls.current.set(li, el);
                    else laneEls.current.delete(li);
                  }}
                  aria-label={
                    lane.label ?? `Handed from ${from?.name ?? lane.from} to ${to?.name ?? lane.to}`
                  }
                  style={{ '--c': 2 * slot + 2 } as CSSProperties}
                  className={cn(
                    'row-start-2 h-[228px] w-[calc(100%-16px)] max-w-[360px] justify-self-center overflow-y-auto bg-muted p-1 pb-16 [mask-image:linear-gradient(#000_calc(100%-64px),transparent)] [scrollbar-width:none]',
                    shape.container,
                    '[grid-column:var(--c)/span_2] @max-[620px]/handoff:[grid-column:1] @max-[620px]/handoff:row-auto @max-[620px]/handoff:h-[220px] @max-[620px]/handoff:[order:var(--c)]',
                  )}
                >
                  <span className="flex h-[30px] items-center justify-between gap-2 pl-2 pr-1.5">
                    <span
                      className={cn(
                        'flex min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap text-foreground',
                        size.type.caption,
                      )}
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {from && (
                        <AgentAvatar name={from.name} logo={from.logo} size={16} decorative />
                      )}
                      <span className="truncate">{from?.name}</span>
                      <ArrowRight size={12} aria-hidden className="mx-0.5 shrink-0" />
                      {to && <AgentAvatar name={to.name} logo={to.logo} size={16} decorative />}
                      <span className="truncate">{to?.name}</span>
                    </span>
                    <span
                      className={cn(
                        'grid h-[18px] min-w-5 shrink-0 place-items-center bg-hover px-[5px] tabular-nums text-muted-foreground',
                        shape.chip,
                        size.type.caption,
                      )}
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {lane.cards.length}
                    </span>
                  </span>
                  {lane.cards.length === 0 ? (
                    <p
                      className={cn(
                        'm-0 pb-5 pt-[18px] text-center text-muted-foreground',
                        size.type.caption,
                      )}
                    >
                      {emptyLaneLabel}
                    </p>
                  ) : (
                    <ul className="m-0 grid list-none gap-1 p-0">
                      <AnimatePresence initial={false}>
                        {lane.cards.map((card) => (
                          <QueueCard
                            key={card.id}
                            card={card}
                            expanded={isExpanded(li, card.id)}
                            onToggle={() => toggle(li, card.id)}
                          />
                        ))}
                      </AnimatePresence>
                    </ul>
                  )}
                </section>
              );
            })}
          </div>

          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[2] size-full overflow-visible @max-[620px]/handoff:hidden"
          >
            {geo.flatMap((g, i) =>
              g.dots.map(([cx, cy], j) => (
                <circle
                  // biome-ignore lint/suspicious/noArrayIndexKey: four fixed connector endpoints
                  key={`${lanes[i]?.from}:${lanes[i]?.to}:${cx}:${cy}:${j}`}
                  cx={cx}
                  cy={cy}
                  r={3.25}
                  fill="var(--background)"
                  stroke={
                    lanes[i]?.passed || lanes[i]?.cards.some((c) => c.status === 'running')
                      ? 'var(--emphasis)'
                      : 'var(--border)'
                  }
                  strokeWidth={1.5}
                />
              )),
            )}
          </svg>
        </div>
      </SizeScope>
    );
  },
);
AgentHandoff.displayName = 'AgentHandoff';

export type {
  AgentHandoffProps,
  HandoffAgent,
  HandoffCard,
  HandoffCardStatus,
  HandoffItem,
  HandoffItemKind,
  HandoffLane,
  HandoffTask,
};
export { AgentHandoff };
