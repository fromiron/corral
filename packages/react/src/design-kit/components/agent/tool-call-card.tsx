'use client';

// A tool call an agent made, as a collapsible card: name, one-line summary,
// status glyph and latency in the header; Arguments and Result JSON (with
// copy) in the body. `ToolCallGroup` stacks several under one header
// ("Using tools… · 2.7s" while any runs, "Used 2 tools · 1.2s" after).

import { AnimatePresence, motion } from 'motion/react';
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
  useRef,
  useState,
} from 'react';
import { useNow } from '../../hooks/use-now.ts';
import { formatDuration, formatLatency } from '../../lib/agent-format.ts';
import { agentLogos, isAgentLogoName } from '../../lib/agent-logos.tsx';
import { focusRing, focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { type IconComponent, type IconName, useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import {
  AgentCard,
  type AgentMark,
  AgentStatusIcon,
  MetaDot,
  SizeScope,
  ToolStack,
  toneColor,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Lifecycle of a single tool call. */
type ToolCallStatus = 'running' | 'waiting' | 'stopped' | 'success' | 'error';

/** A brand mark, an icon component, or an icon slot name (`"search"`). */
type ToolCallIcon = AgentMark | IconName;

interface ToolCall {
  id: string;
  /** Tool name, shown in mono (`search_web`). */
  name: string;
  /** One line on what the call did (`Searched the web for 'CRM pricing'`). */
  summary?: ReactNode;
  icon?: ToolCallIcon;
  status: ToolCallStatus;
  /** Epoch ms the call started; drives the live counter while running. */
  startedAt?: number;
  /** Final latency in ms, once finished. */
  latencyMs?: number;
  /** Arguments, rendered as JSON. */
  args?: unknown;
  /** Result, rendered as JSON (strings render as-is). */
  result?: unknown;
  /** Error message for `status: "error"`. */
  error?: string;
  /** Host status word beside the glyph and in the announcement (`refused`); defaults to the lifecycle word. */
  statusLabel?: string;
  /** Rendered under Result in place of the JSON, e.g. a link to a stored result. */
  resultContent?: ReactNode;
}

const statusGlyph = {
  running: 'running',
  waiting: 'waiting',
  stopped: 'stopped',
  success: 'done',
  error: 'failed',
} as const;

/** Every visible string, so a host can translate the card. */
interface ToolCallLabels {
  arguments: string;
  result: string;
  error: string;
  failed: string;
  errorFallback: string;
  waiting: string;
  noResult: string;
  retry: string;
  copy: (section: string) => string;
  copied: string;
  showAll: string;
  showLess: string;
  status: (name: string, status: string) => string;
  usingTools: string;
  usedTools: (count: number) => string;
  failedCount: (count: number) => string;
}

const defaultLabels: ToolCallLabels = {
  arguments: 'Arguments',
  result: 'Result',
  error: 'Error',
  failed: 'Failed',
  errorFallback: 'The tool returned an error.',
  waiting: 'Waiting for result…',
  noResult: 'No result',
  retry: 'Retry',
  copy: (section) => `Copy ${section.toLowerCase()}`,
  copied: 'Copied',
  showAll: 'Show all',
  showLess: 'Show less',
  status: (name, status) => `${name} ${status}`,
  usingTools: 'Using tools…',
  usedTools: (count) => `Used ${count} tool${count === 1 ? '' : 's'}`,
  failedCount: (count) => `${count} failed`,
};

const LabelsContext = createContext<ToolCallLabels>(defaultLabels);
const statusWord = {
  running: 'running',
  waiting: 'waiting',
  stopped: 'stopped',
  success: 'finished',
  error: 'failed',
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useResolveIcon() {
  const icons = useIcons();
  return useCallback(
    (icon: ToolCallIcon | undefined): IconComponent => {
      if (typeof icon === 'string') {
        if (isAgentLogoName(icon)) return agentLogos[icon];
        if (icon in icons) return icons[icon as IconName];
        return icons['sliders-horizontal'];
      }
      return icon ?? icons['sliders-horizontal'];
    },
    [icons],
  );
}

/** Live seconds with one decimal (`0.0s`, `2.7s`), then worded. */
function formatTicking(ms: number) {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms);
}

function toJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

/** Light JSON syntax coloring: keys, strings, numbers, literals. */
function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[1] !== undefined && m[2] !== undefined) {
      out.push(
        <span key={k++} className="text-foreground">
          {m[1]}
        </span>,
        m[2],
      );
    } else if (m[1] !== undefined) {
      out.push(
        <span key={k++} style={{ color: 'var(--info)' }}>
          {m[1]}
        </span>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <span key={k++} style={{ color: toneColor('purple') }}>
          {m[0]}
        </span>,
      );
    } else {
      out.push(
        <span key={k++} style={{ color: 'var(--warning)' }}>
          {m[0]}
        </span>,
      );
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Height collapse: measures the content and animates to its pixel height. */
function Collapse({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div
      id={id}
      className="overflow-hidden"
      initial={false}
      animate={{ height: open ? (height ?? 'auto') : 0, opacity: open ? 1 : 0 }}
      transition={open ? spring.moderate : spring.moderate.exit}
      inert={!open}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}

function Chevron({ open }: { open: boolean }) {
  const icons = useIcons();
  const Icon = icons['chevron-down'];
  return (
    <motion.span
      aria-hidden
      className="grid shrink-0 place-items-center text-muted-foreground"
      initial={false}
      animate={{ rotate: open ? 180 : 0 }}
      transition={spring.moderate}
    >
      <Icon size={12} />
    </motion.span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const icons = useIcons();
  const shape = useShape();
  const labels = useContext(LabelsContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const Icon = copied ? icons.check : icons.copy;
  return (
    <button
      type="button"
      aria-label={copied ? labels.copied : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
      className={cn(
        'relative grid size-6 place-items-center text-muted-foreground transition-colors duration-80 hover:bg-hover hover:text-foreground',
        shape.bg,
        focusRing,
      )}
      style={copied ? { color: 'var(--emphasis)' } : undefined}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={copied ? 'check' : 'copy'}
          className="grid place-items-center"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
          transition={spring.fast}
        >
          <Icon size={14} />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function SectionHead({ label, copyText }: { label: string; copyText?: string }) {
  const size = useSize();
  const labels = useContext(LabelsContext);
  return (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <span
        className={cn(size.type.caption, 'text-muted-foreground')}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {label}
      </span>
      {copyText !== undefined && <CopyButton text={copyText} label={labels.copy(label)} />}
    </div>
  );
}

function CodeBlock({ text, cap }: { text: string; cap?: number }) {
  const shape = useShape();
  const size = useSize();
  const labels = useContext(LabelsContext);
  const preRef = useRef<HTMLPreElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rendered text changes the measured height
  useLayoutEffect(() => {
    const el = preRef.current;
    if (!el || !cap) return;
    setOverflows(el.scrollHeight > cap + 1);
  }, [text, cap]);
  const capped = !!cap && overflows && !expanded;
  return (
    <div className="grid gap-1">
      <div className="relative">
        <pre
          ref={preRef}
          data-capped={capped || undefined}
          className={cn(
            'm-0 overflow-hidden border border-border bg-muted px-3 py-2.5 font-mono whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] [tab-size:2]',
            size.type.caption,
            shape.bg,
          )}
          style={capped ? { maxHeight: cap } : undefined}
        >
          <code>{highlightJson(text)}</code>
        </pre>
        {capped && (
          <span
            aria-hidden
            className={cn('pointer-events-none absolute inset-x-px bottom-px h-14', shape.bg)}
            style={{ background: 'linear-gradient(to bottom, transparent, var(--muted))' }}
          />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            size.type.caption,
            'justify-self-start text-muted-foreground transition-colors duration-160 hover:text-foreground',
            focusRing,
          )}
        >
          {expanded ? labels.showLess : labels.showAll}
        </button>
      )}
    </div>
  );
}

// ─── ToolCallCard ────────────────────────────────────────────────────────────

interface ToolCallCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onToggle'> {
  call: ToolCall;
  /** Controlled open state of the body. */
  open?: boolean;
  /** Initial open state when uncontrolled. @default false */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shown as a Retry button on a failed call. */
  onRetry?: (call: ToolCall) => void;
  /** Result height (px) before "Show all". `0` disables the cap. @default 220 */
  resultCap?: number;
  /** Density for the card; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
  /** Visible strings; omitted ones keep the English defaults. */
  labels?: Partial<ToolCallLabels>;
}

const ToolCallCardBody = forwardRef<HTMLDivElement, Omit<ToolCallCardProps, 'size' | 'labels'>>(
  (
    {
      call,
      open: openProp,
      defaultOpen = false,
      onOpenChange,
      onRetry,
      resultCap = 220,
      className,
      ...props
    },
    ref,
  ) => {
    const size = useSize();
    const icons = useIcons();
    const labels = useContext(LabelsContext);
    const resolveIcon = useResolveIcon();
    const bodyId = useId();
    const [openState, setOpenState] = useState(defaultOpen);
    const open = openProp ?? openState;
    const setOpen = (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next);
    };
    const running = call.status === 'running';
    const now = useNow(100, running && call.startedAt !== undefined);
    const time = running
      ? call.startedAt !== undefined
        ? formatTicking(now - call.startedAt)
        : undefined
      : call.latencyMs !== undefined
        ? formatLatency(call.latencyMs)
        : undefined;
    const Icon = resolveIcon(call.icon);
    const argsText = call.args !== undefined ? toJson(call.args) : undefined;
    const resultText = call.result !== undefined ? toJson(call.result) : undefined;

    return (
      <AgentCard
        ref={ref}
        data-status={call.status}
        data-open={open || undefined}
        className={className}
        {...props}
      >
        <span className="sr-only" role="status" aria-live="polite">
          {labels.status(call.name, call.statusLabel ?? statusWord[call.status])}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className={cn(
            'flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors duration-80 hover:bg-hover',
            focusRingInset,
            size.type.body,
          )}
        >
          <span
            className="grid size-4 shrink-0 place-items-center text-muted-foreground"
            aria-hidden
          >
            <Icon size={16} />
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <code
              className={cn(
                'max-w-[55%] shrink truncate font-mono text-foreground',
                size.type.caption,
              )}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {call.name}
            </code>
            {call.summary !== undefined && (
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  running ? 'shimmer-text' : 'text-muted-foreground',
                )}
              >
                {call.summary}
              </span>
            )}
          </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums',
              size.type.caption,
              call.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
            style={
              call.status === 'error' ? { fontVariationSettings: fontWeights.semibold } : undefined
            }
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={call.status}
                className="grid place-items-center"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
                transition={spring.slow}
              >
                <AgentStatusIcon status={statusGlyph[call.status]} size={14} />
              </motion.span>
            </AnimatePresence>
            {call.statusLabel !== undefined ? (
              <span>{call.statusLabel}</span>
            ) : call.status === 'error' && !time ? (
              labels.failed
            ) : null}
            {time !== undefined && call.statusLabel !== undefined ? <MetaDot /> : null}
            {time}
          </span>
          <Chevron open={open} />
        </button>
        <Collapse open={open} id={bodyId}>
          <div className="grid gap-3.5 border-t border-border px-3.5 pt-3 pb-3.5">
            {argsText !== undefined && (
              <div className="grid gap-1.5">
                <SectionHead label={labels.arguments} copyText={argsText} />
                <CodeBlock text={argsText} />
              </div>
            )}
            <div className="grid gap-1.5">
              <SectionHead
                label={call.status === 'error' ? labels.error : labels.result}
                copyText={
                  call.status === 'success' && call.resultContent === undefined
                    ? resultText
                    : undefined
                }
              />
              {call.status === 'running' && (
                <p className={cn('pulse-soft m-0 text-muted-foreground', size.type.caption)}>
                  {labels.waiting}
                </p>
              )}
              {(call.status === 'waiting' || call.status === 'stopped') && (
                <p className={cn('m-0 text-muted-foreground', size.type.caption)}>
                  {call.statusLabel ??
                    (call.status === 'waiting' ? labels.waiting : labels.noResult)}
                </p>
              )}
              {call.status === 'success' &&
                (call.resultContent !== undefined ? (
                  call.resultContent
                ) : resultText !== undefined ? (
                  <CodeBlock text={resultText} cap={resultCap || undefined} />
                ) : (
                  <p className={cn('m-0 text-muted-foreground', size.type.caption)}>
                    {labels.noResult}
                  </p>
                ))}
              {call.status === 'error' && (
                <div
                  className="flex min-h-11 items-center gap-2 rounded-lg border py-2 pr-2 pl-3"
                  style={{
                    background: 'color-mix(in srgb, var(--destructive) 5%, transparent)',
                    borderColor: 'color-mix(in srgb, var(--destructive) 18%, transparent)',
                  }}
                >
                  <p
                    className={cn(
                      'm-0 max-h-[200px] min-w-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-line text-destructive [overflow-wrap:anywhere]',
                      size.type.body,
                    )}
                  >
                    {call.error ?? labels.errorFallback}
                  </p>
                  {onRetry && (
                    <Button
                      variant="ghost"
                      size="compact"
                      leadingIcon={icons['rotate-ccw']}
                      onClick={() => onRetry(call)}
                    >
                      {labels.retry}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </Collapse>
      </AgentCard>
    );
  },
);
ToolCallCardBody.displayName = 'ToolCallCardBody';

/** One tool call: header with name, summary, status and latency; JSON body. */
const ToolCallCard = forwardRef<HTMLDivElement, ToolCallCardProps>(
  ({ size, labels, ...props }, ref) => {
    const inherited = useContext(LabelsContext);
    const body = (
      <SizeScope size={size}>
        <ToolCallCardBody ref={ref} {...props} />
      </SizeScope>
    );
    return labels ? (
      <LabelsContext.Provider value={{ ...inherited, ...labels }}>{body}</LabelsContext.Provider>
    ) : (
      body
    );
  },
);
ToolCallCard.displayName = 'ToolCallCard';

// ─── ToolCallGroup ───────────────────────────────────────────────────────────

interface ToolCallGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onToggle'> {
  calls: ToolCall[];
  /** Header label override. Default: `Using tools…` while any runs, else `Used N tools`. */
  label?: ReactNode;
  /** Controlled open state of the list. */
  open?: boolean;
  /** Initial open state when uncontrolled. @default true */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Calls whose bodies start open (uncontrolled). */
  defaultOpenIds?: string[];
  /** Header time override in ms. Default: live since the first start while running, else the sum of latencies. */
  elapsedMs?: number;
  onRetry?: (call: ToolCall) => void;
  /** Density for the group and its cards; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
  /** Visible strings for the group and its cards; omitted ones keep the English defaults. */
  labels?: Partial<ToolCallLabels>;
}

const ToolCallGroupBody = forwardRef<HTMLDivElement, Omit<ToolCallGroupProps, 'size' | 'labels'>>(
  (
    {
      calls,
      label,
      open: openProp,
      defaultOpen = true,
      onOpenChange,
      defaultOpenIds,
      elapsedMs,
      onRetry,
      className,
      ...props
    },
    ref,
  ) => {
    const size = useSize();
    const shape = useShape();
    const labels = useContext(LabelsContext);
    const resolveIcon = useResolveIcon();
    const listId = useId();
    const [openState, setOpenState] = useState(defaultOpen);
    const open = openProp ?? openState;
    const setOpen = (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next);
    };
    const running = calls.some((c) => c.status === 'running');
    const failed = calls.filter((c) => c.status === 'error').length;
    const starts = calls.map((c) => c.startedAt).filter((t): t is number => t !== undefined);
    const now = useNow(100, running && elapsedMs === undefined && starts.length > 0);
    // Only observed time is shown: without a start or a latency the header carries no total.
    const timed =
      elapsedMs !== undefined ||
      (running ? starts.length > 0 : calls.some((c) => c.latencyMs !== undefined));
    const total =
      elapsedMs ??
      (running && starts.length
        ? now - Math.min(...starts)
        : calls.reduce((sum, c) => sum + (c.latencyMs ?? 0), 0));
    const text = label ?? (running ? labels.usingTools : labels.usedTools(calls.length));
    const marks = Array.from(new Set(calls.map((c) => resolveIcon(c.icon))));

    return (
      <div
        ref={ref}
        data-open={open || undefined}
        data-running={running || undefined}
        className={cn('grid min-w-0', className)}
        {...props}
      >
        <span className="sr-only" role="status" aria-live="polite">
          {typeof text === 'string' ? text : undefined}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
          className={cn(
            'flex min-w-0 items-center gap-2 justify-self-start px-1.5 py-1 text-left text-muted-foreground transition-colors duration-80 hover:bg-hover hover:text-foreground',
            size.type.body,
            shape.bg,
            focusRing,
          )}
        >
          <ToolStack tools={marks} max={4} size={22} />
          <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
            <span
              className={cn('min-w-0 truncate', running && 'shimmer-text')}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {text}
            </span>
            {failed > 0 && (
              <span className="shrink-0 text-destructive">
                <MetaDot /> {labels.failedCount(failed)}
              </span>
            )}
            {timed && (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                · {running && elapsedMs === undefined ? formatTicking(total) : formatLatency(total)}
              </span>
            )}
          </span>
          <Chevron open={open} />
        </button>
        <Collapse open={open} id={listId}>
          <div className="grid gap-2 pt-1.5 pb-0.5">
            {calls.map((call) => (
              <ToolCallCard
                key={call.id}
                call={call}
                defaultOpen={defaultOpenIds?.includes(call.id)}
                onRetry={onRetry}
              />
            ))}
          </div>
        </Collapse>
      </div>
    );
  },
);
ToolCallGroupBody.displayName = 'ToolCallGroupBody';

/** Several tool calls under one collapsible header with a tool stack and total time. */
const ToolCallGroup = forwardRef<HTMLDivElement, ToolCallGroupProps>(
  ({ size, labels, ...props }, ref) => {
    const inherited = useContext(LabelsContext);
    const body = (
      <SizeScope size={size}>
        <ToolCallGroupBody ref={ref} {...props} />
      </SizeScope>
    );
    return labels ? (
      <LabelsContext.Provider value={{ ...inherited, ...labels }}>{body}</LabelsContext.Provider>
    ) : (
      body
    );
  },
);
ToolCallGroup.displayName = 'ToolCallGroup';

export type {
  ToolCall,
  ToolCallCardProps,
  ToolCallGroupProps,
  ToolCallIcon,
  ToolCallLabels,
  ToolCallStatus,
};
export { ToolCallCard, ToolCallGroup };
