'use client';

import { animate, motion, useReducedMotion } from 'motion/react';
import {
  createContext,
  type Dispatch,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type UseFluidHoverReturn,
  useFluidHover,
  useRegisterFluidHoverItem,
} from '../../hooks/use-fluid-hover.ts';
import { type IconComponent, useIcons } from '../../lib/icon-context.tsx';
import { isDisabledRow } from '../../lib/popup.ts';
import { shapeMap } from '../../lib/shape-context.tsx';
import {
  fieldTouchClass,
  SizeProvider,
  type SizeVariant,
  typeClass,
  useSize,
} from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog.tsx';
import { FluidHoverHighlight, type FluidHoverSource } from './fluid-hover-highlight.tsx';
import { ScrollArea } from './scroll-area.tsx';
import { TabsSubtle, TabsSubtleItem } from './tabs-subtle.tsx';

// -----------------------------------------------------------------------------
// Command menu: type to filter, arrows to move the highlight, Enter to run.
// The input keeps DOM focus and points at the highlighted row through
// aria-activedescendant. Items are data (`items` on the root), grouped by
// `group`; the panel is sized by its rows up to its max-height. The
// highlight is the fluid hover fill; there is no focus ring in the list.
// -----------------------------------------------------------------------------

export interface CommandMenuItemData {
  /** Unique id. Doubles as the row's key and `aria-activedescendant` target. */
  value: string;
  label: string;
  /** The footer's Enter hint while highlighted, e.g. "Open Showcase".
   *  Defaults to the label. */
  action?: string;
  /** Muted secondary text after the label. */
  description?: string;
  icon?: IconComponent;
  /** Keys shown at the row's trailing edge, e.g. `"mod+p"` or `"⌘⇧P"`.
   *  Display only: bind the combo yourself. */
  shortcut?: string;
  /** Extra terms the filter matches besides label and description. */
  keywords?: readonly string[];
  /** Heading the row is listed under, in first-appearance order. */
  group?: string;
  disabled?: boolean;
  /** Runs when the row is picked, before the root's `onSelect`. */
  onSelect?: () => void;
}

/** Contiguous slice of the visible rows under one heading. */
interface CommandMenuSection {
  id: string;
  heading: string | null;
  items: CommandMenuItemData[];
  /** Flat index of the section's first row. */
  start: number;
}

// Popup lists always use "rounded" radii: pill rows would break the hover
// fill's concentric fit. The dialog shell still follows the global shape.
const listShape = shapeMap.rounded;

// -----------------------------------------------------------------------------
// Shortcuts — one string syntax for both the trigger combo and the caps a row
// displays. Tokens join with "+": modifiers first, then one key.
//   "mod+k"        ⌘K on a Mac, Ctrl+K elsewhere
//   "mod+shift+p"  ⌘⇧P / Ctrl+Shift+P
//   "/"            a bare key
// Pre-formatted caps ("⌘K", "⌘⇧P") display as-is, one cap per glyph.
// -----------------------------------------------------------------------------

export interface ParsedShortcut {
  /** ⌘ on a Mac, Ctrl elsewhere; either matches when listening. */
  mod: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase `KeyboardEvent.key` ("k", "/", "escape"). */
  key: string;
}

const MODIFIER_TOKENS: Record<string, keyof Omit<ParsedShortcut, 'key'>> = {
  mod: 'mod',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  super: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};

/** Named keys, as `KeyboardEvent.key` spells them (lowercased). */
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  plus: '+',
};

/** Splits a combo on "+", keeping a trailing "+" as the key itself. */
function shortcutTokens(shortcut: string): string[] {
  const trimmed = shortcut.trim();
  if (trimmed === '') return [];
  const tokens = trimmed.split('+').map((t) => t.trim());
  // "mod++" splits into ["mod", "", ""]: the empties were a literal "+".
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '' && i > 0) {
      if (out[out.length - 1] !== '+') out.push('+');
      continue;
    }
    if (tokens[i] !== '') out.push(tokens[i] as string);
  }
  return out;
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parsed: ParsedShortcut = {
    mod: false,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: '',
  };
  for (const token of shortcutTokens(shortcut)) {
    const lower = token.toLowerCase();
    const modifier = MODIFIER_TOKENS[lower];
    if (modifier) parsed[modifier] = true;
    else parsed.key = KEY_ALIASES[lower] ?? lower;
  }
  return parsed;
}

/** Whether a keydown is the parsed combo. Falls back to the physical `code`
 *  for non-Latin layouts or while ⌥ is held (Mac ⌥ turns `key` into a
 *  symbol); otherwise `key` wins, so Dvorak/AZERTY letters match as typed. */
export function matchesShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  parsed: ParsedShortcut,
): boolean {
  if (parsed.key === '') return false;
  const key = e.key.toLowerCase();
  const byCode =
    parsed.key.length === 1 &&
    /[a-z0-9]/.test(parsed.key) &&
    (e.altKey || !/^[a-z0-9]$/i.test(e.key)) &&
    e.code.toLowerCase() === (/[a-z]/.test(parsed.key) ? `key${parsed.key}` : `digit${parsed.key}`);
  if (key !== parsed.key && !byCode) return false;
  if (parsed.mod) {
    if (!e.metaKey && !e.ctrlKey) return false;
  } else if (e.metaKey !== parsed.meta || e.ctrlKey !== parsed.ctrl) {
    return false;
  }
  if (e.altKey !== parsed.alt) return false;
  // Shifted symbols imply Shift, so it is only checked when named.
  if (parsed.shift && !e.shiftKey) return false;
  return true;
}

/** Whether the combo has a modifier, i.e. is safe to fire while typing. */
export function hasModifier(parsed: ParsedShortcut): boolean {
  return parsed.mod || parsed.meta || parsed.ctrl || parsed.alt;
}

const CAP_LABELS: Record<string, { mac: string; other: string }> = {
  mod: { mac: '⌘', other: 'Ctrl' },
  meta: { mac: '⌘', other: 'Win' },
  ctrl: { mac: '⌃', other: 'Ctrl' },
  alt: { mac: '⌥', other: 'Alt' },
  shift: { mac: '⇧', other: 'Shift' },
  enter: { mac: '↵', other: 'Enter' },
  escape: { mac: 'Esc', other: 'Esc' },
  backspace: { mac: '⌫', other: 'Backspace' },
  delete: { mac: '⌦', other: 'Del' },
  tab: { mac: '⇥', other: 'Tab' },
  ' ': { mac: 'Space', other: 'Space' },
  arrowup: { mac: '↑', other: '↑' },
  arrowdown: { mac: '↓', other: '↓' },
  arrowleft: { mac: '←', other: '←' },
  arrowright: { mac: '→', other: '→' },
};

const PREFORMATTED = /^[⌘⌃⌥⇧↵⌫⌦⇥↑↓←→]+[A-Za-z0-9]?$/;

/** The caps a shortcut displays: symbols on a Mac, words elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string[] {
  const caps: string[] = [];
  for (const token of shortcutTokens(shortcut)) {
    if (PREFORMATTED.test(token)) {
      caps.push(...Array.from(token));
      continue;
    }
    const lower = token.toLowerCase();
    const modifier = MODIFIER_TOKENS[lower];
    const name = modifier ?? KEY_ALIASES[lower] ?? lower;
    const cap = CAP_LABELS[name];
    if (cap) caps.push(mac ? cap.mac : cap.other);
    else if (name.length === 1) caps.push(name.toUpperCase());
    else caps.push(name.charAt(0).toUpperCase() + name.slice(1));
  }
  return caps;
}

/** Whether the page runs on a Mac. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

// Read once as a store snapshot: the server and hydration draw ⌘, then other
// platforms swap to words on the next render.
let macPlatform: boolean | null = null;
const readMac = () => (macPlatform ??= isMacPlatform());
const serverMac = () => true;
const subscribeNever = () => () => {};

/** Whether to draw ⌘ and ⌥ rather than Ctrl and Alt. */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribeNever, readMac, serverMac);
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

// ─── Filtering ───────────────────────────────────────────────────────────────

/** Every query word appears in the label, description, or keywords
 *  (case-insensitive). Rows keep their order. */
export function defaultCommandMenuFilter(item: CommandMenuItemData, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.label, item.description ?? '', ...(item.keywords ?? [])]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Groups the visible rows into sections, suggestions first while the query
 *  is empty. */
export function sectionRows(
  visible: readonly CommandMenuItemData[],
  suggestions: readonly string[] | undefined,
  suggestionsLabel: string,
  query: string,
): CommandMenuSection[] {
  const sections: CommandMenuSection[] = [];
  const byHeading = new Map<string | null, CommandMenuSection>();
  const suggested = new Set(query === '' ? (suggestions ?? []) : []);
  let index = 0;
  const push = (heading: string | null, id: string, item: CommandMenuItemData) => {
    let section = byHeading.get(heading);
    if (!section) {
      section = { id, heading, items: [], start: 0 };
      byHeading.set(heading, section);
      sections.push(section);
    }
    section.items.push(item);
  };
  // Suggested rows leave their own group so nothing is listed twice.
  if (suggested.size > 0) {
    const pool = new Map(visible.map((item) => [item.value, item]));
    for (const value of suggestions ?? []) {
      const item = pool.get(value);
      if (item) push(suggestionsLabel, 'suggestions', item);
    }
  }
  for (const item of visible) {
    if (suggested.has(item.value)) continue;
    push(item.group ?? null, item.group ? `group:${item.group}` : 'ungrouped', item);
  }
  for (const section of sections) {
    section.start = index;
    index += section.items.length;
  }
  return sections;
}

// ─── Contexts ────────────────────────────────────────────────────────────────

/** The highlighted index as a store, so a change re-renders only the two
 *  rows it concerns. */
interface HighlightStore {
  get: () => number | null;
  subscribe: (listener: () => void) => () => void;
}

interface CommandMenuContextValue {
  query: string;
  setQuery: (query: string) => void;
  sections: CommandMenuSection[];
  /** The visible rows, flat, in list order: the keyboard's index space. */
  rows: CommandMenuItemData[];
  itemsByValue: Map<string, CommandMenuItemData>;
  listId: string;
  listRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Stable fluid hover parts only; the index and rects travel separately so
   *  this value holds still while the pointer moves. */
  registerItem: UseFluidHoverReturn['registerItem'];
  setActiveIndex: Dispatch<SetStateAction<number | null>>;
  listHandlers: UseFluidHoverReturn['handlers'];
  highlight: HighlightStore;
  select: (item: CommandMenuItemData) => void;
  /** Moves the highlight from the keyboard: a step (wrapping), or an end. */
  move: (to: 1 | -1 | 'first' | 'last') => void;
  /** The mounted CommandMenuTabs, so ← and → in the field switch tabs. */
  tabsRef: RefObject<CommandMenuTabsHandle | null>;
  tabsMounted: boolean;
  setTabsMounted: (mounted: boolean) => void;
}

/** The fill's index and rects, so only the list re-renders as it travels. */
const CommandMenuFillContext = createContext<FluidHoverSource | null>(null);

interface CommandMenuTabsHandle {
  tabs: readonly CommandMenuTab[];
  value: string;
  onValueChange: (value: string) => void;
}

const CommandMenuContext = createContext<CommandMenuContextValue | null>(null);

function useCommandMenu(): CommandMenuContextValue {
  const ctx = useContext(CommandMenuContext);
  if (!ctx) throw new Error('CommandMenu compound components must be inside <CommandMenu>');
  return ctx;
}

// The list provides each row's flat index, so custom rows never number themselves.
const CommandMenuIndexContext = createContext<number>(0);

interface CommandMenuDialogContextValue {
  close: () => void;
}

const CommandMenuDialogContext = createContext<CommandMenuDialogContextValue | null>(null);

// ─── CommandMenu (root) ──────────────────────────────────────────────────────

export interface CommandMenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** The actions. The highlight resets to the first row when the rows change. */
  items: readonly CommandMenuItemData[];
  /** Runs when a row is picked, after the item's own `onSelect`. */
  onSelect?: (item: CommandMenuItemData) => void;
  /** Match an item against the query. @default defaultCommandMenuFilter */
  filter?: (item: CommandMenuItemData, query: string) => boolean;
  /** Controlled query. */
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  /** Values listed first, under `suggestionsLabel`, while nothing is typed. */
  suggestions?: readonly string[];
  /** @default "Suggestions" */
  suggestionsLabel?: string;
  /** Inside CommandMenuDialog: picking a row closes the dialog.
   *  @default true */
  closeOnSelect?: boolean;
  /** Row size (default 36px, compact 28px). Omitted, follows the SizeProvider. */
  size?: SizeVariant;
  children: ReactNode;
}

const CommandMenu = forwardRef<HTMLDivElement, CommandMenuProps>(
  (
    {
      items,
      onSelect,
      filter = defaultCommandMenuFilter,
      query: queryProp,
      defaultQuery = '',
      onQueryChange,
      suggestions,
      suggestionsLabel = 'Suggestions',
      closeOnSelect = true,
      size,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const listId = useId();
    const listRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const dialog = useContext(CommandMenuDialogContext);
    const tabsRef = useRef<CommandMenuTabsHandle | null>(null);
    const [tabsMounted, setTabsMounted] = useState(false);

    const [internalQuery, setInternalQuery] = useState(defaultQuery);
    const query = queryProp ?? internalQuery;
    const setQuery = useCallback(
      (next: string) => {
        if (queryProp === undefined) setInternalQuery(next);
        onQueryChange?.(next);
      },
      [queryProp, onQueryChange],
    );

    const itemsByValue = useMemo(() => {
      const map = new Map<string, CommandMenuItemData>();
      for (const item of items) map.set(item.value, item);
      return map;
    }, [items]);

    const sections = useMemo(() => {
      const visible = query === '' ? items : items.filter((item) => filter(item, query));
      return sectionRows(visible, suggestions, suggestionsLabel, query);
    }, [items, query, filter, suggestions, suggestionsLabel]);
    const rows = useMemo(() => sections.flatMap((s) => s.items), [sections]);
    // Content, not identity, so an inline `items` literal doesn't reset the
    // highlight every render. NUL-joined so values can't collide.
    const rowsKey = rows.map((row) => row.value).join('\u0000');

    // Created at the root so the input can drive it; the list's ref is set
    // before the hook observes it because child effects run first.
    const hover = useFluidHover(listRef, { isItemDisabled: isDisabledRow });
    const { activeIndex, setActiveIndex, registerItem, itemRects, isMeasured, session } = hover;
    const { onMouseEnter, onMouseMove, onMouseLeave, onClick } = hover.handlers;
    const listHandlers = useMemo(
      () => ({ onMouseEnter, onMouseMove, onMouseLeave, onClick }),
      [onMouseEnter, onMouseMove, onMouseLeave, onClick],
    );

    // Published to the highlight store after each commit.
    const highlightRef = useRef<number | null>(null);
    const listenersRef = useRef(new Set<() => void>());
    const highlight = useMemo<HighlightStore>(
      () => ({
        get: () => highlightRef.current,
        subscribe: (listener) => {
          listenersRef.current.add(listener);
          return () => {
            listenersRef.current.delete(listener);
          };
        },
      }),
      [],
    );
    useIsoLayoutEffect(() => {
      highlightRef.current = activeIndex;
      for (const listener of listenersRef.current) listener();
    }, [activeIndex]);
    const fill = useMemo<FluidHoverSource>(
      () => ({ activeIndex, itemRects, isMeasured, session }),
      [activeIndex, itemRects, isMeasured, session],
    );

    // Scrolls when a move is decided, not in an index effect, so a move to the
    // already-highlighted row still scrolls. Keyboard moves center the row on
    // the highlight's spring; a query reset snaps to the top. Offsets (not
    // rects) are transform-immune; never scrollIntoView, which scrolls the page.
    const reduceMotion = useReducedMotion() ?? false;
    const scrollAnimationRef = useRef<{ stop: () => void } | null>(null);
    const scrollToRow = useCallback(
      (index: number, mode: 'center' | 'top') => {
        const list = listRef.current;
        const viewport = list?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
        if (!list || !viewport) return;
        scrollAnimationRef.current?.stop();
        scrollAnimationRef.current = null;
        if (mode === 'top' || index === 0) {
          viewport.scrollTop = 0;
          return;
        }
        const row = list.querySelector<HTMLElement>(`[data-fluid-hover-index="${index}"]`);
        if (!row) return;
        const rowTop = row.offsetTop + list.offsetTop;
        const target = Math.max(
          0,
          Math.min(
            rowTop + row.offsetHeight / 2 - viewport.clientHeight / 2,
            viewport.scrollHeight - viewport.clientHeight,
          ),
        );
        if (reduceMotion) {
          viewport.scrollTop = target;
          return;
        }
        scrollAnimationRef.current = animate(viewport.scrollTop, target, {
          ...spring.fast,
          onUpdate: (value) => {
            viewport.scrollTop = value;
          },
        });
      },
      [reduceMotion],
    );
    useEffect(() => () => scrollAnimationRef.current?.stop(), []);

    // Highlight the first enabled row whenever the rows change.
    const rowsRef = useRef(rows);
    useIsoLayoutEffect(() => {
      rowsRef.current = rows;
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: rowsKey re-highlights when the rows change.
    useEffect(() => {
      const first = rowsRef.current.findIndex((row) => !row.disabled);
      setActiveIndex(first === -1 ? null : first);
      scrollToRow(0, 'top');
    }, [rowsKey, setActiveIndex, scrollToRow]);

    const move = useCallback(
      (to: 1 | -1 | 'first' | 'last') => {
        const enabled: number[] = [];
        rowsRef.current.forEach((row, i) => {
          if (!row.disabled) enabled.push(i);
        });
        if (enabled.length === 0) return;
        let next: number;
        if (to === 'first') next = enabled[0] as number;
        else if (to === 'last') next = enabled[enabled.length - 1] as number;
        else {
          const current = highlightRef.current;
          const pos = current === null ? -1 : enabled.indexOf(current);
          // Wraps at both ends.
          if (pos === -1) next = (to === 1 ? enabled[0] : enabled[enabled.length - 1]) as number;
          else next = enabled[(pos + to + enabled.length) % enabled.length] as number;
        }
        setActiveIndex(next);
        scrollToRow(next, 'center');
      },
      [setActiveIndex, scrollToRow],
    );

    const onSelectRef = useRef(onSelect);
    useIsoLayoutEffect(() => {
      onSelectRef.current = onSelect;
    });
    const select = useCallback(
      (item: CommandMenuItemData) => {
        if (item.disabled) return;
        item.onSelect?.();
        onSelectRef.current?.(item);
        if (closeOnSelect) dialog?.close();
      },
      [closeOnSelect, dialog],
    );

    const ctx = useMemo<CommandMenuContextValue>(
      () => ({
        query,
        setQuery,
        sections,
        rows,
        itemsByValue,
        listId,
        listRef,
        inputRef,
        registerItem,
        setActiveIndex,
        listHandlers,
        highlight,
        select,
        move,
        tabsRef,
        tabsMounted,
        setTabsMounted,
      }),
      [
        query,
        setQuery,
        sections,
        rows,
        itemsByValue,
        listId,
        registerItem,
        setActiveIndex,
        listHandlers,
        highlight,
        select,
        move,
        tabsMounted,
      ],
    );

    // The frame springs to the column's measured offsetHeight. Never "auto":
    // framer would read the scaled size under a transformed ancestor. max-h
    // inherits down, so a cap on the root bounds the column and the list scrolls.
    const columnRef = useRef<HTMLDivElement | null>(null);
    const [height, setHeight] = useState<number | null>(null);
    useEffect(() => {
      const el = columnRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const update = () => setHeight(el.offsetHeight);
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    const root = (
      <CommandMenuContext.Provider value={ctx}>
        <CommandMenuFillContext.Provider value={fill}>
          <div
            ref={ref}
            data-slot="command-menu"
            className={cn('relative w-full max-h-[inherit] overflow-hidden', className)}
            {...props}
          >
            <motion.div
              className="max-h-[inherit] overflow-hidden"
              initial={false}
              animate={height === null ? {} : { height }}
              transition={reduceMotion ? { duration: 0 } : spring.moderate}
            >
              <div ref={columnRef} className="flex max-h-[inherit] min-h-0 flex-col">
                {children}
              </div>
            </motion.div>
          </div>
        </CommandMenuFillContext.Provider>
      </CommandMenuContext.Provider>
    );

    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
  },
);

CommandMenu.displayName = 'CommandMenu';

// ─── CommandMenuInput ────────────────────────────────────────────────────────

export interface CommandMenuInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'defaultValue' | 'onChange' | 'size'
  > {
  placeholder?: string;
  /** Leading icon. @default the search icon */
  icon?: IconComponent | null;
}

const CommandMenuInput = forwardRef<HTMLInputElement, CommandMenuInputProps>(
  ({ className, placeholder = 'Type a command or search…', icon, onKeyDown, ...props }, ref) => {
    const icons = useIcons();
    const SearchIcon = icons.search;
    const Icon = icon === undefined ? SearchIcon : icon;
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    const { query, setQuery, rows, listId, inputRef, highlight, select, move, tabsRef } =
      useCommandMenu();
    const activeIndex = useSyncExternalStore(highlight.subscribe, highlight.get, () => null);
    const dialog = useContext(CommandMenuDialogContext);

    const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      // IME composition keys belong to the composer (Safari reports the
      // commit as keyCode 229 after compositionend).
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          // With tabs, ← / → switch tabs; modified presses (Shift+Arrow
          // selection) keep their editing meaning.
          const tabs = tabsRef.current;
          if (!tabs || tabs.tabs.length === 0 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey)
            return;
          e.preventDefault();
          const count = tabs.tabs.length;
          const current = tabs.tabs.findIndex((tab) => tab.value === tabs.value);
          const step = e.key === 'ArrowRight' ? 1 : -1;
          const next = ((current === -1 ? 0 : current) + step + count) % count;
          tabs.onValueChange((tabs.tabs[next] as CommandMenuTab).value);
          return;
        }
        case 'ArrowDown':
          e.preventDefault();
          move(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          move(-1);
          return;
        case 'Home':
          if (query !== '') return; // the caret's own Home
          e.preventDefault();
          move('first');
          return;
        case 'End':
          if (query !== '') return;
          e.preventDefault();
          move('last');
          return;
        case 'Enter': {
          e.preventDefault();
          const row = activeIndex === null ? undefined : rows[activeIndex];
          if (row) select(row);
          return;
        }
        case 'Escape':
          // A dialog closes itself; inline, Escape clears the query.
          if (dialog || query === '') return;
          e.preventDefault();
          setQuery('');
          return;
        default:
          return;
      }
    };

    return (
      <div
        data-slot="command-menu-input"
        className={cn(
          'group/command-input flex shrink-0 items-center',
          compact ? 'h-10 gap-2 px-3' : 'h-12 gap-2.5 px-4',
        )}
      >
        {Icon && (
          <Icon
            size={sizeClasses.icon}
            strokeWidth={1.5}
            className="shrink-0 text-muted-foreground transition-[color,stroke-width] duration-80 group-focus-within/command-input:text-foreground group-focus-within/command-input:stroke-[2]"
          />
        )}
        <input
          ref={(node) => {
            inputRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
          }}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex === null ? undefined : `${listId}-${activeIndex}`}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          placeholder={placeholder}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          // rounded-none: a :focus-visible radius would clip the caret.
          className={cn(
            'min-w-0 flex-1 rounded-none bg-transparent text-foreground placeholder:text-muted-foreground outline-none font-[inherit]',
            // One step above the rows' size; the leading keeps the caret in proportion.
            compact
              ? 'text-[length:var(--fs-subtitle-compact,13px)] leading-5'
              : 'text-[length:var(--fs-subtitle,14px)] leading-6',
            fieldTouchClass,
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);

CommandMenuInput.displayName = 'CommandMenuInput';

// -----------------------------------------------------------------------------
// CommandMenuTabs — tabs under the field. You own the value: derive `items`
// from it.
// -----------------------------------------------------------------------------

export interface CommandMenuTab {
  value: string;
  label: string;
  icon?: IconComponent;
}

export interface CommandMenuTabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  tabs: readonly CommandMenuTab[];
  value: string;
  onValueChange: (value: string) => void;
  /** Trailing content of the tab row, e.g. CommandMenuFilters or a Button. */
  children?: ReactNode;
}

// Inside the tab row, CommandMenuFilters drops its own padding.
const TabsRowContext = createContext(false);

const CommandMenuTabs = forwardRef<HTMLDivElement, CommandMenuTabsProps>(
  ({ tabs, value, onValueChange, className, children, ...props }, ref) => {
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    const { tabsRef, setTabsMounted } = useCommandMenu();
    const selectedIndex = Math.max(
      0,
      tabs.findIndex((tab) => tab.value === value),
    );

    // The field reads this ref on ← / →. A layout effect so on a keyed remount
    // the old cleanup runs before the new write and the ref is never left empty.
    useIsoLayoutEffect(() => {
      tabsRef.current = { tabs, value, onValueChange };
      return () => {
        tabsRef.current = null;
      };
    }, [tabsRef, tabs, value, onValueChange]);
    useEffect(() => {
      setTabsMounted(true);
      return () => setTabsMounted(false);
    }, [setTabsMounted]);

    return (
      <div
        ref={ref}
        data-slot="command-menu-tabs"
        className={cn(
          'flex shrink-0 items-center',
          compact ? 'gap-1 px-2 pb-1.5' : 'gap-2 px-2.5 pb-2',
          className,
        )}
        {...props}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: keeps a pointer pick from taking focus from the field. */}
        <div
          // A pointer pick must not take focus from the field. No overflow clip:
          // it would crop TabsSubtle's outset focus ring.
          onMouseDown={(e) => e.preventDefault()}
          className="flex min-w-0 flex-1 items-center"
        >
          <TabsSubtle
            size="compact"
            selectedIndex={selectedIndex}
            onSelect={(index) => {
              const tab = tabs[index];
              if (tab) onValueChange(tab.value);
            }}
            aria-label="Filter results"
          >
            {tabs.map((tab, index) => (
              <TabsSubtleItem key={tab.value} index={index} label={tab.label} icon={tab.icon} />
            ))}
          </TabsSubtle>
        </div>
        {children && (
          <TabsRowContext.Provider value={true}>
            <div className="ml-auto flex shrink-0 items-center">{children}</div>
          </TabsRowContext.Provider>
        )}
      </div>
    );
  },
);

CommandMenuTabs.displayName = 'CommandMenuTabs';

// -----------------------------------------------------------------------------
// CommandMenuFilters — a borderless bar of compact controls under the field.
// -----------------------------------------------------------------------------

export type CommandMenuFiltersProps = HTMLAttributes<HTMLDivElement>;

const CommandMenuFilters = forwardRef<HTMLDivElement, CommandMenuFiltersProps>(
  ({ className, children, ...props }, ref) => {
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    const inTabsRow = useContext(TabsRowContext);
    return (
      <div
        ref={ref}
        data-slot="command-menu-filters"
        className={cn(
          'flex shrink-0 items-center gap-1',
          // Select triggers hug their content instead of form width.
          '[&_[role=combobox]]:w-auto [&_[role=combobox]]:min-w-0',
          !inTabsRow && 'flex-wrap',
          !inTabsRow && (compact ? 'px-2 pb-1.5' : 'px-2.5 pb-2'),
          className,
        )}
        {...props}
      >
        <SizeProvider size="compact">{children}</SizeProvider>
      </div>
    );
  },
);

CommandMenuFilters.displayName = 'CommandMenuFilters';

// -----------------------------------------------------------------------------
// CommandMenuList — the scrolling rows under a divider, grouped by heading,
// with the fluid hover fill.
// -----------------------------------------------------------------------------

export interface CommandMenuListProps extends HTMLAttributes<HTMLDivElement> {
  /** Custom rows: return a CommandMenuItem (or one built on it) per item. */
  renderItem?: (item: CommandMenuItemData, index: number) => ReactNode;
  /** Static children of the list, e.g. CommandMenuEmpty. */
  children?: ReactNode;
}

const CommandMenuList = forwardRef<HTMLDivElement, CommandMenuListProps>(
  ({ className, children, renderItem, ...props }, ref) => {
    const { sections, rows, listId, listRef, setActiveIndex, listHandlers } = useCommandMenu();
    const fill = useContext(CommandMenuFillContext);
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    const empty = rows.length === 0;

    // The pointer leaving keeps the highlight, so Enter still has a target.
    const lastActiveRef = useRef<number | null>(null);
    useIsoLayoutEffect(() => {
      if (fill && fill.activeIndex !== null) lastActiveRef.current = fill.activeIndex;
    });
    const handleMouseLeave = () => {
      listHandlers.onMouseLeave();
      setActiveIndex(lastActiveRef.current);
    };

    return (
      // Flex, not a percentage height: the shell's max-height leaves every box
      // indefinite. scroll-divider draws both hairlines (so the footer draws
      // none); the bottom one is dropped when the list is the last child.
      <ScrollArea
        className="scroll-divider flex min-h-0 flex-1 flex-col border-t border-border/60 [&::before]:!-top-px [&:last-child::after]:!hidden"
        viewportClassName="min-h-0 flex-1 [&>div[style]]:!block [&>div[style]]:!min-w-0 [--scroll-fade-size:32px] scroll-fade"
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input owns arrow and Enter keys for the list. */}
        <div
          ref={(node) => {
            listRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
          }}
          id={listId}
          role="listbox"
          tabIndex={-1}
          data-slot="command-menu-list"
          data-empty={empty || undefined}
          onMouseEnter={listHandlers.onMouseEnter}
          onMouseMove={listHandlers.onMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={listHandlers.onClick}
          // A row click must not blur the field.
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            // The list is the fill's offsetParent, so both scroll together.
            'relative flex flex-col gap-1 p-1 outline-none data-[empty]:p-0',
            className,
          )}
          {...props}
        >
          {fill && <FluidHoverHighlight hover={fill} className={listShape.bg} />}
          {children}
          {sections.map((section, sectionIndex) => {
            // Positional ids: a heading with a space would split aria-labelledby.
            const headingId = section.heading ? `${listId}-group-${sectionIndex}` : undefined;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox group, not a form fieldset.
              <div
                key={section.id}
                role="group"
                aria-labelledby={headingId}
                className="flex flex-col"
              >
                {section.heading && (
                  <div
                    id={headingId}
                    role="presentation"
                    className={cn(
                      'flex shrink-0 items-center text-muted-foreground',
                      compact ? 'h-6 px-1.5' : 'h-7 px-2',
                      typeClass('caption', compact ? 'compact' : 'default'),
                    )}
                  >
                    {section.heading}
                  </div>
                )}
                {section.items.map((item, i) => {
                  const index = section.start + i;
                  return (
                    <CommandMenuIndexContext.Provider key={item.value} value={index}>
                      {renderItem ? (
                        renderItem(item, index)
                      ) : (
                        <CommandMenuItem value={item.value} />
                      )}
                    </CommandMenuIndexContext.Provider>
                  );
                })}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    );
  },
);

CommandMenuList.displayName = 'CommandMenuList';

// ─── CommandMenuEmpty ────────────────────────────────────────────────────────

export type CommandMenuEmptyProps = HTMLAttributes<HTMLDivElement>;

const CommandMenuEmpty = forwardRef<HTMLDivElement, CommandMenuEmptyProps>(
  ({ className, ...props }, ref) => {
    const { rows } = useCommandMenu();
    const sizeClasses = useSize();
    if (rows.length > 0) return null;
    return (
      <div
        ref={ref}
        role="status"
        aria-live="polite"
        data-slot="command-menu-empty"
        className={cn('px-3 py-6 text-center text-muted-foreground', sizeClasses.text, className)}
        {...props}
      />
    );
  },
);

CommandMenuEmpty.displayName = 'CommandMenuEmpty';

// ─── CommandMenuShortcut ─────────────────────────────────────────────────────

export interface CommandMenuShortcutProps extends HTMLAttributes<HTMLElement> {
  /** The combo, in the trigger syntax (`"mod+p"`) or pre-formatted (`"⌘P"`).
   *  A list draws each entry as its own cap: `["up", "down"]`. */
  keys: string | readonly string[];
}

const CommandMenuShortcut = forwardRef<HTMLElement, CommandMenuShortcutProps>(
  ({ keys, className, ...props }, ref) => {
    const mac = useIsMac();
    const compact = useSize().variant === 'compact';
    const caps = (typeof keys === 'string' ? [keys] : keys).flatMap((k) => formatShortcut(k, mac));
    return (
      <kbd
        ref={ref}
        data-slot="command-menu-shortcut"
        className={cn(
          'ml-auto inline-flex shrink-0 items-center gap-0.5 align-middle font-sans',
          className,
        )}
        {...props}
      >
        {caps.map((cap, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a shortcut may repeat a key cap.
            key={`${cap}-${i}`}
            className={cn(
              'flex items-center justify-center bg-hover text-muted-foreground',
              listShape.chip,
              compact ? 'h-4 min-w-4 px-1' : 'h-5 min-w-5 px-1',
              typeClass('micro', compact ? 'compact' : 'default'),
            )}
          >
            {cap}
          </span>
        ))}
      </kbd>
    );
  },
);

CommandMenuShortcut.displayName = 'CommandMenuShortcut';

// -----------------------------------------------------------------------------
// CommandMenuItem — one row. Reads its data from the root by `value`; any
// prop set here overrides it.
// -----------------------------------------------------------------------------

export interface CommandMenuItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  value: string;
  label?: string;
  description?: string;
  icon?: IconComponent;
  shortcut?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

// Memoized: the list re-renders as the fill travels; unchanged rows must not.
const CommandMenuItem = memo(
  forwardRef<HTMLDivElement, CommandMenuItemProps>(
    (
      {
        value,
        label,
        description,
        icon,
        shortcut,
        disabled,
        onSelect,
        className,
        onClick,
        children,
        ...props
      },
      ref,
    ) => {
      const { itemsByValue, listId, registerItem, highlight, select } = useCommandMenu();
      const index = useContext(CommandMenuIndexContext);
      const internalRef = useRef<HTMLDivElement | null>(null);
      const sizeClasses = useSize();
      const isActive = useSyncExternalStore(
        highlight.subscribe,
        () => highlight.get() === index,
        () => false,
      );

      const data = itemsByValue.get(value);
      const item: CommandMenuItemData = {
        ...(data ?? { value, label: value }),
        ...(label !== undefined && { label }),
        ...(description !== undefined && { description }),
        ...(icon !== undefined && { icon }),
        ...(shortcut !== undefined && { shortcut }),
        ...(disabled !== undefined && { disabled }),
        ...(onSelect !== undefined && { onSelect }),
      };
      const Icon = item.icon;

      useRegisterFluidHoverItem(registerItem, index, internalRef);

      return (
        // biome-ignore lint/a11y/useFocusableInteractive: the input keeps focus and points here with aria-activedescendant.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns arrow and Enter keys for every row.
        <div
          ref={(node) => {
            internalRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
          }}
          id={`${listId}-${index}`}
          role="option"
          aria-selected={isActive}
          aria-disabled={item.disabled || undefined}
          data-fluid-hover-index={index}
          data-value={value}
          data-slot="command-menu-item"
          onClick={(e) => {
            onClick?.(e);
            if (!e.defaultPrevented) select(item);
          }}
          className={cn(
            // Fixed height so the label's text-box trim doesn't shrink the row.
            'relative z-10 flex shrink-0 items-center cursor-pointer select-none outline-none',
            sizeClasses.control,
            sizeClasses.gap,
            sizeClasses.itemPx,
            sizeClasses.text,
            listShape.item,
            'transition-[color] duration-80',
            isActive ? 'text-foreground' : 'text-muted-foreground',
            item.disabled && 'opacity-50 pointer-events-none',
            className,
          )}
          {...props}
        >
          {Icon && (
            <Icon
              size={sizeClasses.icon}
              strokeWidth={isActive ? 2 : 1.5}
              className="shrink-0 transition-[color,stroke-width] duration-80"
            />
          )}
          {children ?? (
            // py-1/-my-1: truncate's overflow would clip the trimmed glyphs.
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1">
                {item.label}
              </span>
              {item.description && (
                <span className="min-w-0 truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1 text-muted-foreground">
                  {item.description}
                </span>
              )}
            </span>
          )}
          {item.shortcut && <CommandMenuShortcut keys={item.shortcut} />}
        </div>
      );
    },
  ),
);

CommandMenuItem.displayName = 'CommandMenuItem';

// -----------------------------------------------------------------------------
// CommandMenuFooter — key hints. Tabs add ← →, a dialog adds Esc.
// -----------------------------------------------------------------------------

export interface CommandMenuHint {
  label: string;
  /** A combo, or a list of separate caps. */
  keys: string | readonly string[];
}

export interface CommandMenuFooterProps extends HTMLAttributes<HTMLDivElement> {
  /** Replaces the default hints. */
  hints?: readonly CommandMenuHint[];
  /** Replaces the hints entirely with your own content. */
  children?: ReactNode;
}

const CommandMenuFooter = forwardRef<HTMLDivElement, CommandMenuFooterProps>(
  ({ hints, className, children, ...props }, ref) => {
    const { rows, highlight, tabsMounted } = useCommandMenu();
    const dialog = useContext(CommandMenuDialogContext);
    const compact = useSize().variant === 'compact';
    // The Enter hint names the highlighted row's action; it sits at the
    // trailing edge so its changing width never moves the other hints.
    const activeIndex = useSyncExternalStore(highlight.subscribe, highlight.get, () => null);
    const row = activeIndex === null ? undefined : rows[activeIndex];
    const action = hints ? null : row ? (row.action ?? row.label) : null;
    const resolved: readonly CommandMenuHint[] = hints ?? [
      { label: 'Select', keys: ['up', 'down'] },
      ...(tabsMounted ? [{ label: 'Tabs', keys: ['left', 'right'] }] : []),
      ...(dialog ? [{ label: 'Close', keys: 'esc' }] : []),
    ];
    return (
      <div
        ref={ref}
        data-slot="command-menu-footer"
        className={cn(
          'flex shrink-0 items-center overflow-hidden text-muted-foreground',
          compact ? 'h-8 gap-3 px-3' : 'h-10 gap-4 px-4',
          typeClass('caption', compact ? 'compact' : 'default'),
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            {resolved.map((hint) => (
              <span key={hint.label} className="flex shrink-0 items-center gap-1.5">
                <span>{hint.label}</span>
                <CommandMenuShortcut keys={hint.keys} className="ml-0" />
              </span>
            ))}
            {action !== null && (
              <span
                data-slot="command-menu-footer-action"
                className="ml-auto flex min-w-0 items-center gap-1.5 text-foreground"
              >
                <span className="truncate">{action}</span>
                <CommandMenuShortcut keys="enter" className="ml-0" />
              </span>
            )}
          </>
        )}
      </div>
    );
  },
);

CommandMenuFooter.displayName = 'CommandMenuFooter';

// -----------------------------------------------------------------------------
// CommandMenuDialog — the modal shell, opened by a global shortcut.
// -----------------------------------------------------------------------------

// One dialog answers a shared combo: an open one first, else the most recently
// mounted one whose scope holds focus (no scope = everywhere). Peers match on
// the parsed combo, so "mod+k" and "Mod+K" are one key.
const mountedDialogs: {
  combo: string;
  isOpen: () => boolean;
  inScope: () => boolean;
}[] = [];

function comboKey(parsed: ParsedShortcut): string {
  return [
    parsed.mod && 'mod',
    parsed.meta && 'meta',
    parsed.ctrl && 'ctrl',
    parsed.alt && 'alt',
    parsed.shift && 'shift',
    parsed.key,
  ]
    .filter(Boolean)
    .join('+');
}

export interface CommandMenuDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Combo that toggles the dialog page-wide. `null` binds nothing. @default "mod+k" */
  shortcut?: string | null;
  /** The combo only opens the dialog while focus is inside this element
   *  (closing works anywhere). */
  shortcutScope?: RefObject<HTMLElement | null>;
  /** Read to screen readers as the dialog's name. @default "Command menu" */
  title?: string;
  /** @default "Search for a command to run." */
  description?: string;
  /** Traps focus and locks page scroll while open. @default true */
  modal?: boolean;
  /** Portal target, for scoping the dialog to a region (see Dialog). */
  container?: HTMLElement | null;
  /** Merged onto the dialog panel. */
  className?: string;
  children: ReactNode;
}

function CommandMenuDialog({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  shortcut = 'mod+k',
  shortcutScope,
  title = 'Command menu',
  description = 'Search for a command to run.',
  modal,
  container,
  className,
  children,
}: CommandMenuDialogProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = openProp ?? internalOpen;
  // Refs keep `setOpen` stable: re-registering the listener would move this
  // dialog to the end of the peer list and change who answers a shared combo.
  const openRef = useRef(open);
  const scopeRef = useRef(shortcutScope);
  const onOpenChangeRef = useRef(onOpenChange);
  const controlledRef = useRef(openProp !== undefined);
  useIsoLayoutEffect(() => {
    openRef.current = open;
    scopeRef.current = shortcutScope;
    onOpenChangeRef.current = onOpenChange;
    controlledRef.current = openProp !== undefined;
  });

  const setOpen = useCallback((next: boolean) => {
    if (!controlledRef.current) setInternalOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    if (!shortcut) return;
    const parsed = parseShortcut(shortcut);
    if (parsed.key === '') return;
    const combo = comboKey(parsed);
    const entry = {
      combo,
      isOpen: () => openRef.current,
      inScope: () => {
        const scope = scopeRef.current?.current;
        return !scope || scope.contains(document.activeElement);
      },
    };
    mountedDialogs.push(entry);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return;
      if (!matchesShortcut(e, parsed)) return;
      // A bare key stays out of fields; a modifier combo fires anywhere.
      if (!hasModifier(parsed) && isEditable(e.target)) return;
      const peers = mountedDialogs.filter((d) => d.combo === combo);
      const answers =
        peers.find((d) => d.isOpen()) ??
        peers
          .slice()
          .reverse()
          .find((d) => d.inScope());
      if (answers !== entry) return;
      e.preventDefault();
      setOpen(!openRef.current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const i = mountedDialogs.indexOf(entry);
      if (i !== -1) mountedDialogs.splice(i, 1);
    };
  }, [shortcut, setOpen]);

  const dialogCtx = useMemo(() => ({ close: () => setOpen(false) }), [setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={modal}>
      <DialogContent
        size="lg"
        container={container}
        showCloseButton={false}
        // Top-anchored where a max-height panel would sit centered, so the
        // field stays put while the rows filter down.
        position="top"
        className={cn(
          'top-[max(12dvh,calc(50dvh-220px))] flex max-h-[min(440px,76dvh)] flex-col overflow-hidden p-0',
          className,
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <CommandMenuDialogContext.Provider value={dialogCtx}>
          {children}
        </CommandMenuDialogContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

CommandMenuDialog.displayName = 'CommandMenuDialog';

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuFilters,
  CommandMenuFooter,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuShortcut,
  CommandMenuTabs,
};
