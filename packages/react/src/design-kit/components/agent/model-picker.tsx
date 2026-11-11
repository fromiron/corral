'use client';

import { Popover as PopoverPrimitive } from '@base-ui/react/popover';

// Composer model picker: a trigger chip that opens a small settings popover
// with a model listbox (speed / quality / cost hints), an Auto option, the
// Extended thinking switch with its Effort segmented control, a Web search
// switch, and a footer readout for the highlighted model.

import { AnimatePresence, motion } from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatLatency } from '../../lib/agent-format.ts';
import { Elevated } from '../../lib/elevated.tsx';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { exitFallbackMs, spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select.tsx';
import { Switch } from '../ui/switch.tsx';
import { TabItem, Tabs, TabsList } from '../ui/tabs.tsx';
import { type AgentMark, Keycap, resolveMark, SizeScope } from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** One choice in the model list. */
export interface ModelOption {
  id: string;
  /** Display name, e.g. `Sonnet 5.5`. */
  name: string;
  /** One-line purpose, e.g. `Everyday work`. */
  description: string;
  /** Tile glyph: a brand mark or icon. Omitted, the name's first letter. */
  mark?: AgentMark;
  /** Marks the Auto option: no hint bars, `Varies` instead. */
  auto?: boolean;
  /** Hints on a 1–5 scale. */
  speed?: number;
  quality?: number;
  cost?: number;
  /** Typical time to first token, for the footer. */
  firstTokenMs?: number;
  /** Price per million tokens in dollars, for the footer. */
  pricePerMTok?: number;
  /** Keep a saved, missing profile visible without allowing it to be chosen. */
  disabled?: boolean;
  /** Group heading; consecutive options with the same group form one named group. */
  group?: string;
  /** More text the search matches besides the name (a model id, a provider name). */
  keywords?: string;
  /** The tile's letter when there is no mark. Omitted, the name's first letter. */
  markText?: string;
  /** Confirmed to take images: the row shows the image mark, named by `labels.image`. */
  imageInput?: boolean;
}

/** The search field over the list; without it the list itself takes the keys. */
export interface ModelPickerSearch {
  label: string;
  placeholder?: string;
  /** Shown when nothing matches the query. */
  noMatch: (query: string) => string;
}

export type ModelEffort = 'low' | 'medium' | 'high';

export interface ModelPickerChoice {
  value: string;
  label: string;
  /** Concise current-value label for the setting row. The menu keeps the full label. */
  shortLabel?: string;
  disabled?: boolean;
}

export interface ModelPickerReasoning {
  label: string;
  ariaLabel: string;
  value: string;
  options: readonly ModelPickerChoice[];
  onValueChange: (value: string) => void;
  /** Present only when a concrete effort is selected; the kit owns its folding tabs. */
  effort?: { label: string; value: string; options: readonly ModelPickerChoice[] };
}

export interface ModelPickerLabels {
  model: string;
  settings: string;
  trigger: (name: string) => string;
  empty: string;
  /** The image mark's name, on a model confirmed to take images. */
  image: string;
}

const defaultLabels: ModelPickerLabels = {
  model: 'Model',
  settings: 'Model settings',
  trigger: (name) => `Model: ${name}`,
  empty: 'No model profiles',
  image: 'Image input',
};

export interface ModelPickerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Options in display order (put the Auto option last). */
  models: ModelOption[];
  /** Selected model id (controlled). */
  value?: string;
  /** Initial selected id when uncontrolled. Defaults to the first model. */
  defaultValue?: string;
  /** Called when the user picks a model. */
  onValueChange?: (id: string) => void;
  /** Popover open state (controlled). */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extended thinking switch (controlled). */
  thinking?: boolean;
  defaultThinking?: boolean;
  onThinkingChange?: (on: boolean) => void;
  /** Effort level shown while thinking is on (controlled). */
  effort?: ModelEffort;
  defaultEffort?: ModelEffort;
  onEffortChange?: (effort: ModelEffort) => void;
  /** Web search switch (controlled). */
  webSearch?: boolean;
  defaultWebSearch?: boolean;
  onWebSearchChange?: (on: boolean) => void;
  /** Which side of the trigger the popover opens on. */
  side?: 'top' | 'bottom';
  /** Popover edge aligned to the trigger. */
  align?: 'start' | 'end';
  /** Close the popover after a model is picked. Default false (settings stay reachable). */
  closeOnSelect?: boolean;
  /** Density for the trigger and popover; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
  /** Disables the trigger and choices even if an externally controlled popup stays open. */
  disabled?: boolean;
  /** Actual host policies in the kit's setting row and conditional effort tabs. Null hides settings. */
  reasoning?: ModelPickerReasoning | null;
  /** Actual host context in the source footer instead of model metrics. */
  footerText?: string;
  /** Empty-state trigger label; never replaces a selected or missing saved value. */
  placeholder?: string;
  triggerDescription?: string;
  labels?: Partial<ModelPickerLabels>;
  /** A search field above the list (focused on open). Shown while there are models. */
  search?: ModelPickerSearch;
  /**
   * `chip` is the composer's borderless chip; `field` is a bordered form field that fills its
   * row, for a model chosen in a form. Default `chip`.
   */
  trigger?: 'chip' | 'field';
  /** The footer readout and key hints. Default true. */
  footer?: boolean;
  /** The trigger's id, for a visible label's `htmlFor`. */
  triggerId?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useControllable<T>(value: T | undefined, initial: T, onChange?: (v: T) => void) {
  const [inner, setInner] = useState(initial);
  const current = value !== undefined ? value : inner;
  const set = useCallback(
    (next: T) => {
      if (value === undefined) setInner(next);
      onChange?.(next);
    },
    [value, onChange],
  );
  return [current, set] as const;
}

const EFFORTS: { value: ModelEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

function Glyph({ model, small }: { model: ModelOption; small?: boolean }) {
  const icons = useIcons();
  const shape = useShape();
  const Mark = model.auto
    ? (resolveMark(model.mark) ?? icons['sliders-horizontal'])
    : resolveMark(model.mark);
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden border border-border bg-background text-foreground',
        shape.chip,
        small ? 'size-[18px]' : 'size-5',
      )}
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {Mark ? (
        <Mark className={small ? 'size-2.5' : 'size-3'} strokeWidth={1.5} />
      ) : (
        <span className={cn(typeClass('micro'), 'leading-none')}>
          {(model.markText ?? model.name).charAt(0)}
        </span>
      )}
    </span>
  );
}

// ─── Windowed rows ───────────────────────────────────────────────────────────

/** A row of the list: a group heading or an option (by its index in `models`). */
type ListRow =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'option'; key: string; index: number; position: number; double: boolean };
type RowKind = 'group' | 'single' | 'double';
const kindOf = (row: ListRow): RowKind =>
  row.kind === 'group' ? 'group' : row.double ? 'double' : 'single';

/** Row heights before the first rendered row of each kind is measured. */
const ESTIMATE: Record<'default' | 'compact', Record<RowKind, number>> = {
  default: { group: 28, single: 36, double: 48 },
  compact: { group: 26, single: 32, double: 44 },
};
/** The list's height before it is laid out (and in environments without layout). */
const FALLBACK_VIEWPORT = 320;
/** Rows drawn beyond the visible part, in pixels, so a fast scroll never shows a gap. */
const OVERSCAN = 240;

function matches(model: ModelOption, query: string) {
  if (!query) return true;
  const text = `${model.name} ${model.keywords ?? ''} ${model.group ?? ''}`.toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

/** The visible options in order, with a heading wherever the group changes. */
function listRows(models: ModelOption[], query: string): ListRow[] {
  const rows: ListRow[] = [];
  let group: string | undefined;
  let position = 0;
  models.forEach((model, index) => {
    if (!matches(model, query)) return;
    if (model.group !== undefined && model.group !== group)
      rows.push({ kind: 'group', key: `group:${index}`, label: model.group });
    group = model.group;
    position++;
    rows.push({
      kind: 'option',
      key: model.id,
      index,
      position,
      double: Boolean(model.description),
    });
  });
  return rows;
}

/** Index of the first row whose bottom is below `offset` (rows are sorted by top). */
function firstBelow(tops: number[], heights: number[], offset: number) {
  let low = 0;
  let high = tops.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((tops[mid] ?? 0) + (heights[mid] ?? 0) <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Five-segment hint bar; the lit layer fades in segment by segment. */
function HintMeter({ value, lit, column }: { value: number; lit: boolean; column: number }) {
  return (
    <span className="grid h-1 w-10 grid-cols-5 gap-0.5" aria-hidden>
      {Array.from({ length: 5 }, (_, s) => {
        const on = s < value;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: The five meter segments are fixed, never reordered.
            key={s}
            className={cn(
              'relative overflow-hidden rounded-[1px]',
              on ? 'bg-muted-foreground' : 'bg-active',
            )}
          >
            {on && (
              <motion.span
                className="absolute inset-0"
                style={{ backgroundColor: 'var(--emphasis)' }}
                initial={false}
                animate={{ opacity: lit ? 1 : 0 }}
                transition={{ ...spring.fast, delay: lit ? column * 0.07 + s * 0.045 : 0 }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

function optionLabel(m: ModelOption) {
  if (m.auto) return `${m.name}, ${m.description}`;
  return `${m.name}, ${m.description}. Speed ${m.speed ?? 0}, quality ${m.quality ?? 0}, cost ${m.cost ?? 0} of 5`;
}

function footerParts(m: ModelOption): { caption: ReactNode; spoken: string } {
  if (m.auto || m.firstTokenMs === undefined) {
    return {
      caption: <span>Speed and cost vary per message</span>,
      spoken: `${m.name}: speed and cost vary per message`,
    };
  }
  const t = formatLatency(m.firstTokenMs);
  const price = m.pricePerMTok !== undefined ? `$${m.pricePerMTok}` : undefined;
  const semi = { fontVariationSettings: fontWeights.semibold };
  return {
    caption: (
      <>
        <span>
          ~
          <b className="text-foreground" style={semi}>
            {t}
          </b>{' '}
          first token
        </span>
        {price && (
          <>
            <span aria-hidden>·</span>
            <span>
              <b className="text-foreground" style={semi}>
                {price}
              </b>{' '}
              / M tokens
            </span>
          </>
        )}
      </>
    ),
    spoken: `${m.name}: about ${t} to the first token${price ? `, ${price} per million tokens` : ''}`,
  };
}

/** Height-measured fold (animates to the pixel height, never `auto`). */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div
      className="overflow-hidden"
      initial={false}
      animate={{ height: open ? h : 0, opacity: open ? 1 : 0 }}
      transition={open ? spring.moderate : spring.moderate.exit}
      aria-hidden={!open}
      inert={!open}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

const ModelPickerBody = forwardRef<HTMLDivElement, Omit<ModelPickerProps, 'size'>>(
  (
    {
      models,
      disabled = false,
      reasoning,
      footerText,
      placeholder,
      triggerDescription,
      labels: labelOverrides,
      search,
      trigger: triggerKind = 'chip',
      footer = true,
      triggerId,
      value,
      defaultValue,
      onValueChange,
      open: openProp,
      defaultOpen = false,
      onOpenChange,
      thinking: thinkingProp,
      defaultThinking = false,
      onThinkingChange,
      effort: effortProp,
      defaultEffort = 'medium',
      onEffortChange,
      webSearch: webProp,
      defaultWebSearch = false,
      onWebSearchChange,
      side = 'bottom',
      align = 'start',
      closeOnSelect = false,
      className,
      ...props
    },
    ref,
  ) => {
    const id = useId();
    const shape = useShape();
    const size = useSize();
    const icons = useIcons();
    const Check = icons.check;
    const Chevron = icons['chevron-down'];
    const Brain = icons.brain;
    const Globe = icons.globe;
    const SearchIcon = icons.search;
    const ImageIcon = icons.image;

    const [selected, setSelected] = useControllable(
      value,
      defaultValue ?? models[0]?.id ?? '',
      onValueChange,
    );
    const [open, setOpen] = useControllable(openProp, defaultOpen, onOpenChange);
    const [thinking, setThinking] = useControllable(
      thinkingProp,
      defaultThinking,
      onThinkingChange,
    );
    const [effort, setEffort] = useControllable(effortProp, defaultEffort, onEffortChange);
    const [web, setWeb] = useControllable(webProp, defaultWebSearch, onWebSearchChange);

    const labels = { ...defaultLabels, ...labelOverrides };
    const showHints =
      models.some((m) => !m.auto) &&
      models.every(
        (m) => m.auto || (m.speed !== undefined && m.quality !== undefined && m.cost !== undefined),
      );
    const selectedIndex = models.findIndex((m) => m.id === selected);
    // The active row is kept by its model's id, so a list read again keeps it on that model.
    const [activeId, setActiveId] = useState<string | null>(selected || null);
    const active = activeId === null ? -1 : models.findIndex((m) => m.id === activeId);
    const setActive = (index: number) => setActiveId(models[index]?.id ?? null);
    const [pointing, setPointing] = useState(false);
    const [keyboard, setKeyboard] = useState(false);

    // The search narrows the rows; long lists draw only the rows near the visible part.
    const searching = Boolean(search) && models.length > 0;
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const rows = useMemo(() => listRows(models, q), [models, q]);
    const optionCount = useMemo(() => rows.filter((row) => row.kind === 'option').length, [rows]);
    const rowOf = useMemo(() => {
      const map = new Map<number, number>();
      rows.forEach((row, i) => {
        if (row.kind === 'option') map.set(row.index, i);
      });
      return map;
    }, [rows]);
    const [measured, setMeasured] = useState<Partial<Record<RowKind, number>>>({});
    const estimate = ESTIMATE[size.variant];
    const { tops, heights, total } = useMemo(() => {
      const tops: number[] = [];
      const heights: number[] = [];
      let at = 0;
      for (const row of rows) {
        const kind = kindOf(row);
        const height = measured[kind] ?? estimate[kind];
        tops.push(at);
        heights.push(height);
        at += height;
      }
      return { tops, heights, total: at };
    }, [rows, measured, estimate]);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
    const from = rows.length ? firstBelow(tops, heights, scrollTop - OVERSCAN) : 0;
    let to = from;
    while (to < rows.length && (tops[to] ?? 0) < scrollTop + viewport + OVERSCAN) to++;

    const actionsRef = useRef<PopoverPrimitive.Root.Actions | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const current = models[selectedIndex];
    const highlighted = models[active] ?? current;
    // A form field says what to choose while it is empty; the chip only when there is nothing.
    const triggerName =
      current?.name ??
      (selected || (triggerKind === 'field' || models.length === 0 ? placeholder : '') || '');
    const thinkingShown =
      reasoning === undefined
        ? thinking
        : Boolean(reasoning?.effort && reasoning.effort.value !== 'off');
    const optionId = (index: number) => `${id}-opt-${index}`;
    // A current model that cannot be chosen says why (not connected, unavailable) in the trigger's
    // description too, as a field already says it in its text.
    const triggerNote =
      [
        triggerDescription,
        current && (triggerKind === 'field' || current.disabled) ? current.description : '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined;

    /** Scrolls the list so the option's row (and its group heading, when it opens one) shows. */
    const reveal = (index: number, center = false) => {
      const list = listRef.current;
      const row = rowOf.get(index);
      if (!list || row === undefined) return;
      const height = list.clientHeight || viewport;
      const top = rows[row - 1]?.kind === 'group' ? (tops[row - 1] ?? 0) : (tops[row] ?? 0);
      const bottom = (tops[row] ?? 0) + (heights[row] ?? 0);
      let next = list.scrollTop;
      if (center) next = Math.max(0, top - (height - (bottom - top)) / 2);
      else if (top < next) next = top;
      else if (bottom > next + height) next = bottom - height;
      if (next !== list.scrollTop) list.scrollTop = next;
      setScrollTop(next);
    };

    // Controlled choices remain the host's state until its update is confirmed. Opening (or a
    // new selection while open) recenters the list once it is in the document: the popup's
    // content can mount a render after `open` turns true. A list read again with the same
    // selection keeps the active row and the query.
    const recenter = useRef(false);
    useLayoutEffect(() => {
      if (!open) return;
      setActiveId(selected || null);
      setPointing(false);
      setQuery('');
      recenter.current = true;
    }, [open, selected]);

    // The first drawn row of each kind gives that kind's real height at this density.
    useLayoutEffect(() => {
      const list = listRef.current;
      if (!list) return;
      if (list.clientHeight && list.clientHeight !== viewport) setViewport(list.clientHeight);
      if (recenter.current && open) {
        recenter.current = false;
        if (selectedIndex >= 0) reveal(selectedIndex, true);
      }
      const next: Partial<Record<RowKind, number>> = {};
      for (const kind of ['group', 'single', 'double'] as const) {
        if (measured[kind] !== undefined) continue;
        const el = list.querySelector<HTMLElement>(`[data-row-kind="${kind}"]`);
        if (el?.offsetHeight) next[kind] = el.offsetHeight;
      }
      if (Object.keys(next).length) setMeasured((all) => ({ ...all, ...next }));
    });

    useEffect(() => {
      if (open) return;
      const timer = setTimeout(
        () => actionsRef.current?.unmount(),
        exitFallbackMs(spring.moderate),
      );
      return () => clearTimeout(timer);
    }, [open]);

    const pick = (i: number) => {
      const m = models[i];
      if (!m || disabled || m.disabled) return;
      setSelected(m.id);
      if (closeOnSelect) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const enabledIndices = () =>
      rows.flatMap((row) =>
        row.kind === 'option' && !models[row.index]?.disabled ? [row.index] : [],
      );

    const onListKey = (e: KeyboardEvent<HTMLElement>) => {
      if (disabled || e.nativeEvent.isComposing) return;
      const enabled = enabledIndices();
      if (!enabled.length) {
        if (e.key === 'Enter') e.preventDefault();
        return;
      }
      const move = (index: number | undefined) => {
        if (index === undefined) return;
        e.preventDefault();
        setKeyboard(true);
        setPointing(false);
        setActive(index);
        reveal(index);
      };
      const at = enabled.indexOf(active);
      if (e.key === 'ArrowDown') move(enabled[(at + 1) % enabled.length]);
      else if (e.key === 'ArrowUp') move(enabled[(at <= 0 ? enabled.length : at) - 1]);
      else if (e.key === 'Home') move(enabled[0]);
      else if (e.key === 'End') move(enabled.at(-1));
      else if (e.key === 'Enter' || (e.key === ' ' && !searching)) {
        e.preventDefault();
        pick(active);
      }
    };

    const changeQuery = (next: string) => {
      setQuery(next);
      const nextRows = listRows(models, next.trim().toLowerCase());
      const first = nextRows.find((row) => row.kind === 'option' && !models[row.index]?.disabled);
      setActive(first?.kind === 'option' ? first.index : -1);
      setPointing(false);
      if (listRef.current) listRef.current.scrollTop = 0;
      setScrollTop(0);
    };

    const showHighlight = pointing || keyboard;
    const activeRow = rowOf.get(active);
    // Only a drawn row can be named as the active one.
    const activeDrawn = activeRow !== undefined && activeRow >= from && activeRow < to;
    const box =
      activeRow !== undefined
        ? { top: tops[activeRow] ?? 0, height: heights[activeRow] ?? 0 }
        : null;
    const foot = showHints && highlighted ? footerParts(highlighted) : null;
    const popVariants = {
      hidden: { opacity: 0, y: 'var(--model-picker-enter-y)', scale: 0.96 },
      shown: { opacity: 1, y: 0, scale: 1 },
    };

    // The drawn rows, each run of one group inside its own named group.
    const drawn: ReactNode[] = [];
    let run: { label: string; key: string; rows: ReactNode[] } | null = null;
    const flush = () => {
      if (!run) return;
      drawn.push(
        // biome-ignore lint/a11y/useSemanticElements: A listbox groups its options with role="group"; a fieldset is not allowed there.
        <div key={`run:${run.key}`} role="group" aria-label={run.label}>
          {run.rows}
        </div>,
      );
      run = null;
    };
    for (let r = from; r < to; r++) {
      const row = rows[r];
      if (!row) continue;
      const style = { top: tops[r], height: heights[r] };
      if (row.kind === 'group') {
        flush();
        drawn.push(
          <div
            key={row.key}
            aria-hidden
            data-row-kind="group"
            className={cn(
              'absolute inset-x-0 flex items-end px-2 pb-1 text-muted-foreground',
              size.type.caption,
            )}
            style={style}
          >
            <span className="truncate" style={{ fontVariationSettings: fontWeights.semibold }}>
              {row.label}
            </span>
          </div>,
        );
        continue;
      }
      const m = models[row.index];
      if (!m) continue;
      const i = row.index;
      const isSel = i === selectedIndex;
      const isActive = i === active;
      const option = (
        <motion.div
          key={row.key}
          id={optionId(i)}
          role="option"
          data-row-kind={kindOf(row)}
          aria-selected={isSel}
          aria-setsize={optionCount}
          aria-posinset={row.position}
          aria-label={
            showHints
              ? optionLabel(m)
              : [m.name, m.description, m.imageInput ? labels.image : ''].filter(Boolean).join(', ')
          }
          aria-disabled={disabled || m.disabled || undefined}
          data-active={isActive || undefined}
          onPointerMove={() => {
            if (!disabled && !m.disabled && (!pointing || active !== i)) {
              setPointing(true);
              setActive(i);
            }
          }}
          onClick={() => pick(i)}
          className={cn(
            'absolute inset-x-0 z-10 flex cursor-pointer items-center gap-2.5 px-2 py-1.5',
            keyboard && isActive && 'ring-2 ring-inset ring-[color:var(--focus-ring)]',
            shape.item,
            (disabled || m.disabled) && 'cursor-not-allowed opacity-50',
          )}
          style={style}
          initial={false}
          animate={{
            opacity: disabled || m.disabled ? 0.5 : pointing && !isActive ? 0.55 : 1,
          }}
          transition={spring.fast}
        >
          <Glyph model={m} />
          <span className="grid min-w-0 flex-1">
            <span
              className={cn('flex items-center gap-1 text-foreground', size.type.body)}
              style={{
                fontVariationSettings: isSel ? fontWeights.semibold : fontWeights.normal,
              }}
            >
              <span className="truncate">{m.name}</span>
              {isSel && <Check className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />}
            </span>
            {m.description ? (
              <span className={cn('truncate text-muted-foreground', size.type.caption)}>
                {m.description}
              </span>
            ) : null}
          </span>
          {m.imageInput ? (
            <span
              data-mark="image"
              title={labels.image}
              className="inline-flex shrink-0 text-muted-foreground"
            >
              <ImageIcon aria-hidden className="size-3.5" strokeWidth={1.5} />
            </span>
          ) : null}
          {showHints &&
            (m.auto ? (
              <span
                className={cn(
                  'w-[136px] shrink-0 text-center text-muted-foreground',
                  size.type.caption,
                )}
              >
                Varies
              </span>
            ) : (
              <span className="grid shrink-0 grid-cols-[repeat(3,40px)] gap-2">
                <HintMeter value={m.speed ?? 0} lit={isActive && showHighlight} column={0} />
                <HintMeter value={m.quality ?? 0} lit={isActive && showHighlight} column={1} />
                <HintMeter value={m.cost ?? 0} lit={isActive && showHighlight} column={2} />
              </span>
            ))}
        </motion.div>
      );
      const group = m.group;
      if (group === undefined) {
        flush();
        drawn.push(option);
      } else {
        if (!run || run.label !== group) {
          flush();
          run = { label: group, key: row.key, rows: [] };
        }
        run.rows.push(option);
      }
    }
    flush();

    const field = triggerKind === 'field';
    return (
      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(next, details) => {
          if (!next) details.preventUnmountOnClose();
          setOpen(next);
        }}
        actionsRef={actionsRef}
      >
        <div
          ref={ref}
          className={cn(field ? 'relative flex w-full min-w-0' : 'relative inline-flex', className)}
          data-open={open || undefined}
          data-side={side}
          data-align={align}
          {...props}
        >
          <PopoverPrimitive.Trigger
            ref={triggerRef}
            id={triggerId}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={`${id}-menu`}
            aria-label={labels.trigger(triggerName)}
            aria-description={triggerNote}
            disabled={disabled}
            data-slot="model-picker-trigger"
            className={cn(
              field
                ? cn(
                    'group flex w-full min-w-0 items-center border border-border bg-transparent text-left text-foreground transition-colors duration-80 hover:bg-hover disabled:pointer-events-none disabled:opacity-50',
                    size.control,
                    size.px,
                    size.gap,
                    shape.input,
                  )
                : cn(
                    'inline-flex min-h-7 max-w-full items-center gap-1.5 px-1.5 py-1 text-left text-muted-foreground transition-colors duration-160 hover:bg-hover hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed',
                    open && 'bg-hover text-foreground',
                    shape.button,
                  ),
              focusRing,
              size.type.body,
            )}
          >
            {current && <Glyph model={current} small />}
            <span className={cn('relative inline-grid min-w-0', field && 'flex-1')}>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={current?.id}
                  className={field ? 'truncate' : '[overflow-wrap:anywhere]'}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: spring.fast.exit }}
                  transition={spring.fast}
                >
                  {triggerName}
                </motion.span>
              </AnimatePresence>
            </span>
            {field && current?.description ? (
              <span className="min-w-0 max-w-[45%] shrink truncate text-muted-foreground">
                {current.description}
              </span>
            ) : null}
            <AnimatePresence initial={false}>
              {thinkingShown && (
                <motion.span
                  key="flag"
                  aria-hidden
                  className="inline-flex"
                  style={{ color: 'var(--emphasis)' }}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
                  transition={spring.fast}
                >
                  <Brain className="size-3.5" strokeWidth={1.5} />
                </motion.span>
              )}
            </AnimatePresence>
            <motion.span
              aria-hidden
              className={cn('inline-flex', field && 'text-muted-foreground')}
              initial={false}
              animate={{ rotate: open ? 180 : 0 }}
              transition={spring.moderate}
            >
              <Chevron className="size-3.5" strokeWidth={1.5} />
            </motion.span>
          </PopoverPrimitive.Trigger>

          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Positioner
              side={side}
              align={align}
              sideOffset={6}
              className="z-50 max-w-(--available-width)"
            >
              <PopoverPrimitive.Popup
                id={`${id}-menu`}
                aria-label={labels.settings}
                initialFocus={searching ? searchRef : listRef}
                finalFocus={triggerRef}
                data-slot="model-picker-popup"
                className={cn(
                  'outline-none [--model-picker-enter-y:4px] data-[side=bottom]:[--model-picker-enter-y:-4px]',
                  field
                    ? 'w-[max(var(--anchor-width),min(360px,calc(100vw-32px)))]'
                    : 'w-[min(320px,calc(100vw-32px))]',
                )}
              >
                <motion.div
                  variants={popVariants}
                  initial="hidden"
                  animate={open ? 'shown' : 'hidden'}
                  transition={open ? spring.moderate : spring.moderate.exit}
                  onAnimationComplete={() => {
                    if (!open) actionsRef.current?.unmount();
                  }}
                  style={{
                    transformOrigin: `${align === 'start' ? 'left' : 'right'} ${side === 'bottom' ? 'top' : 'bottom'}`,
                  }}
                >
                  <Elevated
                    offset={2}
                    className={cn('max-h-(--available-height) overflow-y-auto', shape.container)}
                  >
                    <div className="p-1">
                      {searching && search ? (
                        <div
                          className={cn(
                            'group/search -mx-1 -mt-1 mb-0.5 flex items-center border-b border-border/60',
                            size.control,
                            size.gap,
                            size.variant === 'compact' ? 'px-2.5' : 'px-3',
                          )}
                        >
                          <SearchIcon
                            size={size.icon}
                            strokeWidth={1.5}
                            aria-hidden
                            className="shrink-0 text-muted-foreground transition-[color,stroke-width] duration-80 group-focus-within/search:text-foreground group-focus-within/search:stroke-[2]"
                          />
                          <input
                            ref={searchRef}
                            type="text"
                            role="combobox"
                            aria-expanded
                            aria-controls={`${id}-list`}
                            aria-autocomplete="list"
                            aria-activedescendant={activeDrawn ? optionId(active) : undefined}
                            aria-label={search.label}
                            placeholder={search.placeholder ?? search.label}
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={disabled}
                            value={query}
                            onChange={(event) => changeQuery(event.target.value)}
                            onKeyDown={onListKey}
                            onFocus={() => setKeyboard(true)}
                            onBlur={() => setKeyboard(false)}
                            // rounded-none: a :focus-visible radius would clip the caret.
                            className={cn(
                              'min-w-0 flex-1 rounded-none bg-transparent text-foreground placeholder:text-muted-foreground outline-none font-[inherit] disabled:opacity-50',
                              size.field,
                              size.variant === 'compact' ? 'leading-5' : 'leading-6',
                            )}
                          />
                        </div>
                      ) : (
                        <div
                          className={cn(
                            'flex h-7 items-center justify-between gap-3 px-2 pt-1 text-muted-foreground',
                            size.type.caption,
                          )}
                        >
                          <span id={`${id}-label`}>{labels.model}</span>
                          {showHints && (
                            <span className="grid grid-cols-[repeat(3,40px)] gap-2" aria-hidden>
                              {['Speed', 'Quality', 'Cost'].map((c) => (
                                <span key={c} className="flex justify-center whitespace-nowrap">
                                  {c}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      )}

                      <div
                        ref={listRef}
                        id={`${id}-list`}
                        role="listbox"
                        tabIndex={searching ? -1 : 0}
                        {...(searching
                          ? { 'aria-label': labels.model }
                          : {
                              'aria-labelledby': `${id}-label`,
                              'aria-activedescendant': activeDrawn ? optionId(active) : undefined,
                            })}
                        aria-disabled={disabled || undefined}
                        data-pointing={pointing || undefined}
                        onKeyDown={searching ? undefined : onListKey}
                        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                        onFocus={(event) => {
                          if (!searching)
                            setKeyboard(event.currentTarget.matches(':focus-visible'));
                        }}
                        onBlur={() => {
                          if (!searching) setKeyboard(false);
                        }}
                        onPointerLeave={() => {
                          setPointing(false);
                          if (!q) setActive(selectedIndex);
                        }}
                        className={cn(
                          'relative max-h-80 overflow-y-auto overscroll-contain outline-none',
                          shape.item,
                        )}
                      >
                        <div className="relative" style={{ height: total }}>
                          {box && (
                            <motion.div
                              aria-hidden
                              className={cn(
                                'pointer-events-none absolute inset-x-0 top-0 bg-hover',
                                shape.bg,
                              )}
                              style={{ height: box.height }}
                              initial={false}
                              animate={{ y: box.top, opacity: showHighlight ? 1 : 0 }}
                              transition={spring.moderate}
                            />
                          )}
                          {drawn}
                        </div>
                        {models.length === 0 && (
                          <p className={cn(size.type.caption, 'px-2 py-2 text-muted-foreground')}>
                            {labels.empty}
                          </p>
                        )}
                        {models.length > 0 && rows.length === 0 && search ? (
                          <p
                            className={cn(
                              size.type.caption,
                              'px-2 py-2 text-muted-foreground [overflow-wrap:anywhere]',
                            )}
                          >
                            {search.noMatch(query.trim())}
                          </p>
                        ) : null}
                      </div>
                      {reasoning !== undefined ? (
                        reasoning ? (
                          <div className="mt-1 grid border-t border-border pt-1">
                            <div className="flex items-center gap-2.5 pl-2">
                              <Brain
                                className="size-4 shrink-0 text-muted-foreground"
                                strokeWidth={1.5}
                                aria-hidden
                              />
                              <span className={cn('min-w-0 flex-1', size.type.body)}>
                                {reasoning.label}
                              </span>
                              <div className="min-w-0 max-w-[65%]">
                                <Select
                                  size="compact"
                                  value={String(
                                    reasoning.options.findIndex(
                                      (option) => option.value === reasoning.value,
                                    ),
                                  )}
                                  onValueChange={(index) => {
                                    const option = reasoning.options[Number(index)];
                                    if (!disabled && option && !option.disabled)
                                      reasoning.onValueChange(option.value);
                                  }}
                                  disabled={disabled}
                                  items={reasoning.options.map((option, index) => ({
                                    value: String(index),
                                    label: option.shortLabel ?? option.label,
                                  }))}
                                >
                                  <SelectTrigger
                                    aria-label={reasoning.ariaLabel}
                                    variant="borderless"
                                    className="min-w-0 max-w-full"
                                  />
                                  <SelectContent align="end">
                                    {reasoning.options.map((option, index) => (
                                      <SelectItem
                                        key={option.value}
                                        index={index}
                                        value={String(index)}
                                        disabled={option.disabled}
                                      >
                                        {option.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <Fold open={Boolean(reasoning.effort)}>
                              {reasoning.effort ? (
                                <div className="flex items-center gap-2.5 pt-0.5 pr-2 pb-1.5 pl-[38px]">
                                  <span
                                    className={cn('shrink-0 text-muted-foreground', size.type.body)}
                                  >
                                    {reasoning.effort.label}
                                  </span>
                                  <Tabs
                                    value={reasoning.effort.value}
                                    onValueChange={(next) => {
                                      const option = reasoning.effort?.options.find(
                                        (item) => item.value === next,
                                      );
                                      if (!disabled && option && !option.disabled)
                                        reasoning.onValueChange(next);
                                    }}
                                    size="compact"
                                    className="min-w-0 overflow-x-auto"
                                  >
                                    {/* The inset track needs full foreground for its compact labels. */}
                                    <TabsList
                                      aria-label={reasoning.effort.label}
                                      className="w-max [--muted-foreground:var(--foreground)]"
                                    >
                                      {reasoning.effort.options.map((option) => (
                                        <TabItem
                                          key={option.value}
                                          value={option.value}
                                          label={option.label}
                                          disabled={disabled || option.disabled}
                                        />
                                      ))}
                                    </TabsList>
                                  </Tabs>
                                </div>
                              ) : null}
                            </Fold>
                          </div>
                        ) : null
                      ) : (
                        <div className="mt-1 grid border-t border-border pt-1">
                          <div className="flex items-center gap-2.5 pl-2">
                            <Brain
                              className="size-4 shrink-0 text-muted-foreground"
                              strokeWidth={1.5}
                              aria-hidden
                            />
                            <Switch
                              label="Extended thinking"
                              checked={thinking}
                              onToggle={() => setThinking(!thinking)}
                              size="compact"
                              className="min-w-0 flex-1 flex-row-reverse justify-between pl-0"
                            />
                          </div>
                          <Fold open={thinking}>
                            <div className="flex items-center gap-2.5 pt-0.5 pr-2 pb-1.5 pl-[38px]">
                              <span
                                id={`${id}-effort`}
                                className={cn(
                                  'min-w-0 flex-1 text-muted-foreground',
                                  size.type.body,
                                )}
                              >
                                Effort
                              </span>
                              <Tabs
                                value={effort}
                                onValueChange={(v) => setEffort(v as ModelEffort)}
                                size="compact"
                                aria-labelledby={`${id}-effort`}
                              >
                                <TabsList>
                                  {EFFORTS.map((e) => (
                                    <TabItem key={e.value} value={e.value} label={e.label} />
                                  ))}
                                </TabsList>
                              </Tabs>
                            </div>
                          </Fold>
                          <div className="flex items-center gap-2.5 pl-2">
                            <Globe
                              className="size-4 shrink-0 text-muted-foreground"
                              strokeWidth={1.5}
                              aria-hidden
                            />
                            <Switch
                              label="Web search"
                              checked={web}
                              onToggle={() => setWeb(!web)}
                              size="compact"
                              className="min-w-0 flex-1 flex-row-reverse justify-between pl-0"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {footer ? (
                      <div
                        className={cn(
                          'flex min-h-9 items-center gap-2 border-t border-border py-1.5 pr-2 pl-3 text-muted-foreground',
                          size.type.caption,
                        )}
                      >
                        <span className="relative inline-grid min-w-0 flex-1">
                          <AnimatePresence initial={false} mode="popLayout">
                            <motion.span
                              key={highlighted?.id}
                              aria-hidden
                              className="flex min-w-0 items-center gap-1 truncate"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0, transition: spring.fast.exit }}
                              transition={spring.fast}
                            >
                              {footerText ?? foot?.caption}
                            </motion.span>
                          </AnimatePresence>
                        </span>
                        <span className="flex shrink-0 items-center gap-1" aria-hidden>
                          <Keycap>↑↓</Keycap>
                          <Keycap>↵</Keycap>
                        </span>
                        <span className="sr-only" aria-live="polite">
                          {footerText ?? foot?.spoken}
                        </span>
                      </div>
                    ) : null}
                  </Elevated>
                </motion.div>
              </PopoverPrimitive.Popup>
            </PopoverPrimitive.Positioner>
          </PopoverPrimitive.Portal>
        </div>
      </PopoverPrimitive.Root>
    );
  },
);
ModelPickerBody.displayName = 'ModelPickerBody';

/** Composer trigger + model settings popover with listbox keyboard support (↑ ↓ Home End ↵, Esc). */
export const ModelPicker = forwardRef<HTMLDivElement, ModelPickerProps>(
  ({ size, ...props }, ref) => (
    <SizeScope size={size}>
      <ModelPickerBody ref={ref} {...props} />
    </SizeScope>
  ),
);
ModelPicker.displayName = 'ModelPicker';
