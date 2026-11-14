'use client';

// A run as a tree of agent cards: the lead on top, its sub-agents hung below
// with connector lines. A summary bar counts the agents, flags the ones that
// need you or failed (each opens a short list with actions), and totals the
// spend. Branches fold. Wide containers lay level 1 out as columns; narrow
// ones indent every level.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNow } from '../../hooks/use-now.ts';
import { formatCost, formatCount, formatDuration } from '../../lib/agent-format.ts';
import { agentLogos } from '../../lib/agent-logos.tsx';
import { Elevated } from '../../lib/elevated.tsx';
import { focusRing, focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import {
  AgentAvatar,
  AgentCard,
  type AgentMark,
  type AgentStatus,
  AgentStatusBadge,
  AgentStatusIcon,
  agentStatusLabels,
  LiveDot,
  SizeScope,
  ToolStack,
  toneFill,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentTreeNode {
  id: string;
  name: string;
  /** Model line under the name (`Opus 5.5`). */
  model?: string;
  /** Brand mark or icon for the avatar; omitted, shows initials. */
  logo?: AgentMark;
  /** Tools the agent can call, shown before the task. */
  tools?: AgentMark[];
  /** What the agent is doing, clamped to two lines. */
  task?: string;
  status: AgentStatus;
  /** This agent's own spend in USD. A card with sub-agents shows the branch rollup. */
  cost?: number;
  /** Epoch ms the agent started. */
  startedAt?: number;
  /** Epoch ms it ended; omitted while running or waiting, the clock runs to `now`. */
  endedAt?: number;
  /** The question shown in the "needs you" list. */
  ask?: string;
  /** The error shown in the "failed" list. */
  error?: string;
  children?: AgentTreeNode[];
  /** Status word shown instead of the kit's default label (Corral: its finer status). */
  statusLabel?: string;
  /** Attributes for the element holding the status word alone (data attributes, test hooks). */
  statusLabelProps?: HTMLAttributes<HTMLSpanElement> & Record<`data-${string}`, string | undefined>;
  /**
   * `'mark'` shows the status glyph without its word, for a card whose state another part of the
   * screen already says. The treeitem's name still carries the word. Default `'word'`.
   */
  statusShown?: 'word' | 'mark';
  /** A short mark after the name, such as what kind of agent this is. */
  tag?: ReactNode;
  /** Extra content under the task, above the footer (links, live text). */
  detail?: ReactNode;
  /** Attributes for the card element (ids, test hooks, data attributes). */
  cardProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  /** `false` keeps a card out of selection (a run root). Default true when `onSelect` is set. */
  selectable?: boolean;
  /** Organizational cards do not count as agents or appear in status lists. */
  summaryExcluded?: boolean;
  /** An agent that watches from outside the flow: it counts as an agent, never as running. */
  outsideFlow?: boolean;
}

/** Words the tree shows; every default is the kit's English text. */
interface AgentTreeLabels {
  /** The summary bar's count; a host may draw it as more than words (one part only read). */
  agents: (count: number) => ReactNode;
  running: (count: number) => string;
  needsYou: (count: number) => string;
  failed: (count: number) => string;
  needsYouList: string;
  failedList: string;
  showBranch: (count: number, name: string) => string;
  foldBranch: (name: string) => string;
  branchCost: string;
  approve: string;
  reject: string;
  retry: string;
  dismiss: string;
  /** Elapsed time on a card. */
  duration: (ms: number) => string;
}

const defaultLabels: AgentTreeLabels = {
  agents: (n) => (n === 1 ? '1 agent' : `${formatCount(n)} agents`),
  running: (n) => `${formatCount(n)} running`,
  needsYou: (n) => `${formatCount(n)} needs you`,
  failed: (n) => `${formatCount(n)} failed`,
  needsYouList: 'Agents that need you',
  failedList: 'Agents that failed',
  showBranch: (n, name) => `Show ${n} sub-agents of ${name}`,
  foldBranch: (name) => `Fold the sub-agents of ${name}`,
  branchCost: 'This branch, with its sub-agents',
  approve: 'Approve',
  reject: 'Reject',
  retry: 'Retry',
  dismiss: 'Dismiss',
  duration: formatDuration,
};

/** `approve`/`reject` answer a waiting agent; `retry`/`dismiss` handle a failed one. */
type AgentTreeAction = 'approve' | 'reject' | 'retry' | 'dismiss';

interface AgentTreeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect'> {
  /** The lead agent; its descendants make the tree. */
  root: AgentTreeNode;
  /** Bar title and the tree's accessible name. */
  title?: string;
  /** Drawn right after the bar's title, on its line (an explanation of the title's term). */
  titleAction?: ReactNode;
  /** Clock for running durations (epoch ms). Omitted, ticks every second while anything runs. */
  now?: number;
  /** Ids of folded branches (controlled). */
  collapsed?: string[];
  /** Initially folded branches (uncontrolled). */
  defaultCollapsed?: string[];
  onCollapsedChange?: (ids: string[]) => void;
  /** Called from the needs-you / failed list. Omitted, the lists show no action buttons. */
  onResolve?: (agent: AgentTreeNode, action: AgentTreeAction) => void;
  /** The selected card's id; its treeitem is `aria-selected`. */
  selectedId?: string | null;
  /** Makes each selectable card a button that reports its node. */
  onSelect?: (agent: AgentTreeNode) => void;
  /** Localized words; missing entries keep the kit's English. */
  labels?: Partial<AgentTreeLabels>;
  /** `auto` picks columns when level 1 fits side by side. */
  layout?: 'auto' | 'wide' | 'narrow';
  /** Card width in the wide layout, px. */
  cardWidth?: number;
  /** Indent per level, px. */
  indent?: number;
  /** Density step for the whole tree; omitted, inherits the nearest SizeProvider. */
  size?: SizeVariant;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flatten(n: AgentTreeNode): AgentTreeNode[] {
  return [n, ...(n.children ?? []).flatMap(flatten)];
}

function rollup(n: AgentTreeNode): number {
  return (n.cost ?? 0) + (n.children ?? []).reduce((a, c) => a + rollup(c), 0);
}

function maxDepth(n: AgentTreeNode): number {
  return Math.max(0, ...(n.children ?? []).map((c) => maxDepth(c) + 1));
}

function hasCost(n: AgentTreeNode): boolean {
  return n.cost !== undefined || (n.children ?? []).some(hasCost);
}

function isLive(s: AgentStatus) {
  return s === 'running' || s === 'waiting';
}

function elapsed(n: AgentTreeNode, now: number): number | undefined {
  if (n.startedAt === undefined) return undefined;
  const end = n.endedAt ?? (isLive(n.status) ? now : n.startedAt);
  return end - n.startedAt;
}

/** Layout position relative to `root`, unaffected by transforms mid-animation. */
function offsetIn(el: HTMLElement, root: HTMLElement) {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== root) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

interface Link {
  id: string;
  d: string;
  muted: boolean;
}
interface Dot {
  x: number;
  y: number;
  muted: boolean;
}

const LINK = 'color-mix(in srgb, var(--emphasis) 55%, var(--background))';
const LINK_MUTED = 'var(--border)';

// ─── Context ─────────────────────────────────────────────────────────────────

interface TreeCtx {
  now: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  register: (id: string, el: HTMLElement | null) => void;
  wide: boolean;
  cardWidth: number;
  indent: number;
  step: number;
  nodeWidth: number | undefined;
  selectedId: string | null;
  onSelect: ((agent: AgentTreeNode) => void) | undefined;
  labels: AgentTreeLabels;
  showCost: boolean;
}
const Ctx = createContext<TreeCtx | null>(null);
function useTree() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AgentTree parts must render inside AgentTree');
  return c;
}

// ─── Component ───────────────────────────────────────────────────────────────

const AgentTree = forwardRef<HTMLDivElement, AgentTreeProps>(
  (
    {
      root,
      title = 'Agents',
      titleAction,
      now,
      collapsed,
      defaultCollapsed,
      onCollapsedChange,
      onResolve,
      selectedId = null,
      onSelect,
      labels: labelOverrides,
      layout = 'auto',
      cardWidth = 216,
      indent = 32,
      size,
      className,
      ...props
    },
    ref,
  ) => {
    const all = useMemo(() => flatten(root), [root]);
    const anyLive = all.some((a) => isLive(a.status));
    const tick = useNow(1000, now === undefined && anyLive);
    const clock = now ?? tick;

    const [innerCollapsed, setInnerCollapsed] = useState<string[]>(defaultCollapsed ?? []);
    const collapsedIds = collapsed ?? innerCollapsed;
    const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds]);
    const toggle = useCallback(
      (id: string) => {
        const next = collapsedSet.has(id)
          ? collapsedIds.filter((x) => x !== id)
          : [...collapsedIds, id];
        if (collapsed === undefined) setInnerCollapsed(next);
        onCollapsedChange?.(next);
      },
      [collapsed, collapsedIds, collapsedSet, onCollapsedChange],
    );

    // ─── width → layout ──────────────────────────────────────────────────────
    const treeRef = useRef<HTMLDivElement>(null);
    const levelRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const kids = root.children ?? [];
    const needed = Math.max(
      560,
      kids.reduce((a, k) => a + cardWidth + indent * Math.max(1, maxDepth(k)), 0) +
        Math.max(0, kids.length - 1) * 8,
    );
    const wide = layout === 'wide' || (layout === 'auto' && width >= needed);
    const depth = maxDepth(root);
    const step = Math.min(indent, Math.max(12, (width - 180) / Math.max(1, depth)));
    const nodeWidth = wide ? cardWidth : width ? Math.max(160, width - depth * step) : undefined;
    const rootOpen = kids.length > 0 && !collapsedSet.has(root.id);

    // ─── connector measurement ───────────────────────────────────────────────
    const nodes = useRef(new Map<string, HTMLElement>());
    const ro = useRef<ResizeObserver | null>(null);
    const latest = useRef({ root, collapsedSet, wide });
    latest.current = { root, collapsedSet, wide };
    const [geo, setGeo] = useState<{
      links: Link[];
      dots: Dot[];
      w: number;
      h: number;
      key: string;
    }>({
      links: [],
      dots: [],
      w: 0,
      h: 0,
      key: '',
    });

    const measure = useCallback(() => {
      const tree = treeRef.current;
      if (!tree) return;
      const { root: r, collapsedSet: folded, wide: isWide } = latest.current;
      const levelY = levelRef.current ? offsetIn(levelRef.current, tree).y : null;
      const links: Link[] = [];
      const walk = (node: AgentTreeNode, d: number) => {
        const pEl = nodes.current.get(node.id);
        if (!pEl || folded.has(node.id)) return;
        for (const child of node.children ?? []) {
          const cEl = nodes.current.get(child.id);
          if (cEl) {
            const p = offsetIn(pEl, tree);
            const c = offsetIn(cEl, tree);
            const muted = child.status === 'queued' || child.status === 'stopped';
            if (isWide && d === 0) {
              const px = p.x + p.w / 2;
              const py = p.y + p.h;
              const cx = c.x + c.w / 2;
              const cy = c.y;
              const midY = Math.round(py + ((levelY ?? cy) - py) / 2);
              const dx = cx - px;
              const rad = Math.max(0, Math.min(8, Math.abs(dx) / 2, (cy - midY) / 2));
              const dir = Math.sign(dx);
              const stem = muted ? `M${px} ${midY}` : `M${px} ${py}V${midY}`;
              const dd =
                Math.abs(dx) < 12
                  ? `${stem}V${cy}`
                  : `${stem}H${cx - dir * rad}Q${cx} ${midY} ${cx} ${midY + rad}V${cy}`;
              links.push({ id: `${node.id}>${child.id}`, d: dd, muted });
              const stemId = `${node.id}>stem`;
              const existing = links.find((l) => l.id === stemId);
              if (existing) existing.muted = existing.muted && muted;
              else links.push({ id: stemId, d: `M${px} ${py}V${midY}`, muted });
            } else {
              const sx = p.x + 21;
              const sy = p.y + p.h;
              const nx = c.x;
              const ny = c.y + 20;
              const rr = Math.max(0, Math.min(8, (nx - sx) / 2, (ny - sy) / 2));
              const dd =
                nx - sx < 2
                  ? `M${sx} ${sy}V${c.y}`
                  : `M${sx} ${sy}V${ny - rr}Q${sx} ${ny} ${sx + rr} ${ny}H${nx}`;
              links.push({ id: `${node.id}>${child.id}`, d: dd, muted });
            }
          }
          walk(child, d + 1);
        }
      };
      walk(r, 0);

      // Dots sit where a link leaves its parent card.
      const dotMap = new Map<string, Dot>();
      const walkDots = (node: AgentTreeNode, d: number) => {
        const pEl = nodes.current.get(node.id);
        if (!pEl || folded.has(node.id)) return;
        const shown = (node.children ?? []).filter((c) => nodes.current.has(c.id));
        if (shown.length) {
          const p = offsetIn(pEl, tree);
          const x = isWide && d === 0 ? p.x + p.w / 2 : p.x + 21;
          const muted = shown.every((c) => c.status === 'queued' || c.status === 'stopped');
          dotMap.set(`${x},${p.y + p.h}`, { x, y: p.y + p.h, muted });
        }
        for (const c of node.children ?? []) walkDots(c, d + 1);
      };
      walkDots(r, 0);

      const w = tree.clientWidth;
      const h = tree.clientHeight;
      const dots = [...dotMap.values()];
      const key = JSON.stringify([links, dots, w, h]);
      setGeo((g) => (g.key === key ? g : { links, dots, w, h, key }));
    }, []);

    const register = useCallback((id: string, el: HTMLElement | null) => {
      const prev = nodes.current.get(id);
      if (prev && prev !== el) ro.current?.unobserve(prev);
      if (el) {
        nodes.current.set(id, el);
        ro.current?.observe(el);
      } else nodes.current.delete(id);
    }, []);

    useLayoutEffect(() => {
      const tree = treeRef.current;
      if (!tree) return;
      setWidth(tree.clientWidth);
      const obs = new ResizeObserver(() => {
        setWidth(tree.clientWidth);
        measure();
      });
      ro.current = obs;
      obs.observe(tree);
      for (const el of nodes.current.values()) obs.observe(el);
      return () => {
        obs.disconnect();
        ro.current = null;
      };
    }, [measure]);

    useLayoutEffect(() => {
      measure();
    });

    const reduce = useReducedMotion() ?? false;
    const labels = useMemo(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides]);
    const ctx: TreeCtx = {
      now: clock,
      collapsed: collapsedSet,
      toggle,
      register,
      wide,
      cardWidth,
      indent,
      step,
      nodeWidth,
      selectedId,
      onSelect,
      labels,
      showCost: hasCost(root),
    };

    return (
      <SizeScope size={size}>
        <Ctx.Provider value={ctx}>
          <div ref={ref} className={cn('grid min-w-0 gap-4', className)} {...props}>
            <SummaryBar
              root={root}
              all={all}
              title={title}
              titleAction={titleAction}
              onResolve={onResolve}
            />
            <div
              ref={treeRef}
              role="tree"
              aria-label={title}
              className={cn(
                'relative grid',
                wide ? 'justify-items-center' : 'justify-items-stretch',
              )}
            >
              <svg
                className="pointer-events-none absolute top-0 left-0 overflow-visible"
                width={geo.w}
                height={geo.h}
                aria-hidden
              >
                {geo.links.map((l) => (
                  <motion.path
                    key={l.id}
                    d={l.d}
                    fill="none"
                    stroke={l.muted ? LINK_MUTED : LINK}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    initial={reduce ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={spring.slow}
                  />
                ))}
              </svg>
              {/* biome-ignore lint/a11y/useFocusableInteractive: the card's own button takes focus; the treeitem gives structure and selection. */}
              <div
                role="treeitem"
                aria-label={`${root.name}: ${root.statusLabel ?? agentStatusLabels[root.status]}`}
                aria-expanded={kids.length ? rootOpen : undefined}
                aria-selected={selectedId === root.id}
                className="relative z-[1]"
                style={wide && rootOpen ? { marginRight: indent } : undefined}
              >
                <NodeCard node={root} depth={0} />
              </div>
              <AnimatePresence initial={false}>
                {rootOpen && (
                  <motion.div
                    key="level"
                    ref={levelRef}
                    role="group"
                    className={cn(
                      'relative z-[1] w-full',
                      wide ? 'mt-10 flex items-start justify-center gap-2' : 'mt-3 grid gap-3',
                    )}
                    style={wide ? undefined : { paddingLeft: step }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: spring.moderate.exit }}
                    transition={spring.moderate}
                  >
                    <AnimatePresence initial={false}>
                      {kids.map((k) => (
                        <Hang key={k.id} node={k} depth={1} />
                      ))}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
              <svg
                className="pointer-events-none absolute top-0 left-0 z-[2] overflow-visible"
                width={geo.w}
                height={geo.h}
                aria-hidden
              >
                {geo.dots.map((d) => (
                  <circle
                    key={`${d.x},${d.y}`}
                    cx={d.x}
                    cy={d.y}
                    r={3.25}
                    fill="var(--background)"
                    stroke={d.muted ? LINK_MUTED : LINK}
                    strokeWidth={1.5}
                  />
                ))}
              </svg>
            </div>
          </div>
        </Ctx.Provider>
      </SizeScope>
    );
  },
);
AgentTree.displayName = 'AgentTree';

// ─── Parts ───────────────────────────────────────────────────────────────────

function Hang({ node, depth }: { node: AgentTreeNode; depth: number }) {
  const ctx = useTree();
  const kids = node.children ?? [];
  const open = kids.length > 0 && !ctx.collapsed.has(node.id);
  return (
    <motion.div
      role="treeitem"
      aria-label={`${node.name}: ${node.statusLabel ?? agentStatusLabels[node.status]}`}
      aria-expanded={kids.length ? open : undefined}
      aria-selected={ctx.selectedId === node.id}
      className="grid content-start gap-3"
      style={
        depth === 1 && ctx.wide
          ? { flex: 'none', width: ctx.cardWidth + ctx.indent * Math.max(1, maxDepth(node)) }
          : undefined
      }
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.97, transition: spring.moderate.exit }}
      transition={spring.moderate}
    >
      <NodeCard node={node} depth={depth} />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="below"
            role="group"
            className="grid gap-3"
            style={{ paddingLeft: ctx.wide ? ctx.indent : ctx.step }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: spring.moderate.exit }}
            transition={spring.moderate}
          >
            <AnimatePresence initial={false}>
              {kids.map((k) => (
                <Hang key={k.id} node={k} depth={depth + 1} />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function NodeCard({ node, depth }: { node: AgentTreeNode; depth: number }) {
  const ctx = useTree();
  const size = useSize();
  const shape = useShape();
  const icons = useIcons();
  const Chevron = icons['chevron-down'];
  const kids = node.children ?? [];
  const folded = ctx.collapsed.has(node.id);
  const total = flatten(node).length - 1;
  const value = kids.length ? rollup(node) : (node.cost ?? 0);
  const live = flatten(node).some((a) => a.status === 'running');
  const time = elapsed(node, ctx.now);
  const quiet = node.status === 'queued' || node.status === 'stopped';
  const tools = node.tools ?? [];
  const register = ctx.register;
  const selectable = !!ctx.onSelect && node.selectable !== false;
  const selected = ctx.selectedId === node.id;
  const statusLabel = node.statusLabel ?? agentStatusLabels[node.status];
  const setRef = useCallback(
    (el: HTMLDivElement | null) => register(node.id, el),
    [register, node.id],
  );

  return (
    <AgentCard
      {...node.cardProps}
      ref={setRef}
      data-status={node.status}
      data-depth={depth}
      data-selected={selected || undefined}
      className="grid gap-1.5 px-2.5 pt-2.5 pb-2"
      style={{
        width: ctx.nodeWidth,
        opacity: quiet && !selected ? 0.6 : undefined,
        // Selection uses the kit's one accent, drawn inside the card edge.
        boxShadow: selected ? 'inset 0 0 0 1.5px var(--emphasis)' : undefined,
      }}
    >
      {selectable && (
        // A stretched button makes the card one target without nesting its links in it.
        <button
          type="button"
          aria-label={`${node.name} · ${node.id} · ${statusLabel}`}
          aria-pressed={selected}
          onClick={() => ctx.onSelect?.(node)}
          className={cn(
            'absolute inset-0 z-[1] cursor-pointer rounded-[inherit] hover:bg-hover',
            focusRingInset,
          )}
        />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 basis-24 items-center gap-2">
          <AgentAvatar name={node.name} logo={node.logo} size={22} />
          <span className="grid min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                dir="auto"
                title={node.name}
                className={cn(size.type.body, 'truncate text-foreground')}
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {node.name}
              </span>
              {node.tag ? <span className="shrink-0">{node.tag}</span> : null}
            </span>
            {node.model && (
              <span
                title={node.model}
                className={cn(size.type.caption, 'truncate text-muted-foreground')}
              >
                {node.model}
              </span>
            )}
          </span>
        </div>
        {node.statusShown === 'mark' ? (
          <span aria-hidden className="inline-flex shrink-0 self-start pt-1">
            <AgentStatusIcon status={node.status} />
          </span>
        ) : (
          <AgentStatusBadge
            status={node.status}
            label={node.statusLabel}
            {...(node.statusLabelProps ? { labelProps: node.statusLabelProps } : {})}
            className="shrink-0 self-start"
          />
        )}
      </div>
      {(node.task || tools.length > 0) && (
        <p
          dir="auto"
          title={node.task}
          className={cn(
            size.type.caption,
            'line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]',
          )}
        >
          {tools.length > 0 && (
            <ToolStack
              tools={tools}
              max={tools.length > 4 ? 3 : 4}
              size={16}
              className="mr-1.5 align-top"
            />
          )}
          {node.task}
        </p>
      )}
      {node.detail ? (
        // Detail sits above the stretched card button; only its own controls take clicks.
        <div
          className={cn(
            size.type.caption,
            'pointer-events-none relative z-[2] grid min-w-0 gap-1 [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto',
          )}
        >
          {node.detail}
        </div>
      ) : null}
      <div className="flex min-h-5 items-center gap-1.5">
        <span
          className={cn(
            size.type.caption,
            'inline-flex min-w-0 flex-1 items-center gap-1.5 truncate tabular-nums text-foreground',
          )}
          title={kids.length && ctx.showCost ? ctx.labels.branchCost : undefined}
        >
          {live && <LiveDot />}
          {ctx.showCost ? (
            <span
              className={cn(live && 'sheen')}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {formatCost(value)}
            </span>
          ) : null}
          {time !== undefined && (
            <span className="text-muted-foreground">
              {ctx.showCost ? '· ' : ''}
              {ctx.labels.duration(time)}
            </span>
          )}
        </span>
        {kids.length > 0 && (
          <button
            type="button"
            onClick={() => ctx.toggle(node.id)}
            aria-expanded={!folded}
            aria-label={
              folded ? ctx.labels.showBranch(total, node.name) : ctx.labels.foldBranch(node.name)
            }
            className={cn(
              size.type.caption,
              shape.bg,
              'relative z-[2] inline-flex h-5 shrink-0 cursor-pointer items-center gap-0.5 pr-1 pl-1.5 tabular-nums text-muted-foreground hover:bg-hover hover:text-foreground pointer-coarse:h-8 pointer-coarse:pr-2 pointer-coarse:pl-2.5',
              focusRing,
            )}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {folded ? `+${total}` : kids.length}
            <motion.span
              className="inline-flex"
              initial={false}
              animate={{ rotate: folded ? -90 : 0 }}
              transition={spring.fast}
            >
              <Chevron size={12} />
            </motion.span>
          </button>
        )}
      </div>
    </AgentCard>
  );
}

function SummaryBar({
  root,
  all,
  title,
  titleAction,
  onResolve,
}: {
  root: AgentTreeNode;
  all: AgentTreeNode[];
  title: string;
  titleAction?: ReactNode;
  onResolve?: (agent: AgentTreeNode, action: AgentTreeAction) => void;
}) {
  const { labels, showCost } = useTree();
  const size = useSize();
  const shape = useShape();
  const icons = useIcons();
  const Chevron = icons['chevron-down'];
  const Spark = agentLogos.spark;
  const barRef = useRef<HTMLElement>(null);
  const popId = useId();
  const [open, setOpen] = useState<'waiting' | 'failed' | null>(null);
  const included = all.filter((node) => !node.summaryExcluded);
  const running = included.filter((a) => a.status === 'running' && !a.outsideFlow).length;
  const waiting = included.filter((a) => a.status === 'waiting').length;
  const failed = included.filter((a) => a.status === 'failed').length;
  const list = open ? included.filter((a) => a.status === open) : [];
  const showPop = open !== null && list.length > 0;

  useEffect(() => {
    if (!showPop) return;
    const down = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [showPop]);

  const flag = (kind: 'waiting' | 'failed', count: number) => (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open === kind && showPop}
      aria-controls={open === kind && showPop ? popId : undefined}
      onClick={() => setOpen((o) => (o === kind ? null : kind))}
      className={cn(
        size.type.caption,
        shape.bg,
        '-my-1 inline-flex h-[22px] cursor-pointer items-center gap-0.5 pr-1 pl-2',
        focusRing,
      )}
      style={{
        backgroundColor: toneFill(kind === 'waiting' ? 'amber' : 'red'),
        color: kind === 'waiting' ? 'var(--warning)' : 'var(--destructive)',
        fontVariationSettings: fontWeights.semibold,
      }}
    >
      {kind === 'waiting' ? labels.needsYou(count) : labels.failed(count)}
      <motion.span
        className="inline-flex"
        initial={false}
        animate={{ rotate: open === kind && showPop ? 180 : 0 }}
        transition={spring.fast}
      >
        <Chevron size={12} />
      </motion.span>
    </button>
  );

  return (
    <header ref={barRef} className="relative z-[3] flex min-w-0 items-center gap-2">
      <span className="grid w-4 shrink-0 place-items-center" style={{ color: 'var(--emphasis)' }}>
        <Spark size={14} />
      </span>
      <span
        dir="auto"
        title={title}
        className={cn(size.type.body, 'min-w-0 truncate text-foreground')}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {title}
      </span>
      {titleAction}
      <span
        aria-live="polite"
        className={cn(
          size.type.caption,
          'ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 tabular-nums text-muted-foreground',
        )}
      >
        <span>{labels.agents(included.length)}</span>
        {running > 0 && <span style={{ color: 'var(--emphasis)' }}>{labels.running(running)}</span>}
        {waiting > 0 && flag('waiting', waiting)}
        {failed > 0 && flag('failed', failed)}
        <span
          className="inline-flex min-w-11 items-center justify-end gap-1.5 text-foreground"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {running > 0 && <LiveDot />}
          {showCost ? (
            <span className={cn(running > 0 && 'sheen')}>{formatCost(rollup(root))}</span>
          ) : null}
        </span>
      </span>
      <AnimatePresence>
        {showPop && (
          <motion.div
            key={open}
            id={popId}
            role="dialog"
            aria-label={open === 'waiting' ? labels.needsYouList : labels.failedList}
            className="absolute top-full right-0 z-[5] mt-2 w-[300px] max-w-full origin-top-right"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: spring.moderate.exit }}
            transition={spring.moderate}
          >
            <Elevated
              offset={2}
              className={cn(
                shape.container,
                'grid max-h-[min(440px,70vh)] gap-1 overflow-y-auto overscroll-contain p-1.5',
              )}
            >
              {list.map((agent, i) => {
                const text = open === 'waiting' ? agent.ask : agent.error;
                return (
                  <div
                    key={agent.id}
                    className={cn('grid min-w-0 gap-1 p-2', i > 0 && 'border-t border-border')}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="grid w-5 shrink-0 place-items-center">
                        <AgentStatusIcon status={agent.status} />
                      </span>
                      <span
                        dir="auto"
                        className={cn(size.type.body, 'min-w-0 shrink truncate text-foreground')}
                        style={{ fontVariationSettings: fontWeights.semibold }}
                      >
                        {agent.name}
                      </span>
                      <span
                        dir="auto"
                        className={cn(
                          size.type.caption,
                          'min-w-0 flex-1 truncate text-muted-foreground',
                        )}
                      >
                        {agent.task}
                      </span>
                    </span>
                    {text && (
                      <span
                        dir="auto"
                        className={cn(
                          size.type.caption,
                          'pl-7 text-muted-foreground [overflow-wrap:anywhere]',
                        )}
                      >
                        {text}
                      </span>
                    )}
                    {onResolve ? (
                      <span className="mt-1 flex justify-end gap-1.5">
                        <Button
                          variant="secondary"
                          size="compact"
                          onClick={() =>
                            onResolve(agent, open === 'waiting' ? 'reject' : 'dismiss')
                          }
                        >
                          {open === 'waiting' ? labels.reject : labels.dismiss}
                        </Button>
                        <Button
                          variant="primary"
                          size="compact"
                          autoFocus={i === 0}
                          onClick={() => onResolve(agent, open === 'waiting' ? 'approve' : 'retry')}
                        >
                          {open === 'waiting' ? labels.approve : labels.retry}
                        </Button>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </Elevated>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

export type { AgentTreeAction, AgentTreeLabels, AgentTreeNode, AgentTreeProps };
export { AgentTree };
