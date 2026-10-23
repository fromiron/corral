'use client';

import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIcons } from '../../lib/icon-context.tsx';
import { useSize } from '../../lib/size-context.tsx';
import { SURFACE_BG } from '../../lib/surface-classes.ts';
import { useSurface } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';

// ---------------------------------------------------------------------------
// DropdownSearch: a controlled search field pinned to the top of a
// DropdownContent popup; filter the MenuItems you render against `value`.
// Typing keys stop at the input so the menu's typeahead can't steal them, and
// typing on a focused row is redirected into the field (useDropdownSearchHost).
// Arrows move between the field and the ends of the list; Enter in the field
// picks nothing.
// ---------------------------------------------------------------------------

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface SearchHandle {
  input: HTMLInputElement | null;
  /** Whether the field takes focus when the popup opens. */
  autoFocus: boolean;
  append: (text: string) => void;
  deleteBackward: () => void;
}

interface DropdownSearchHostValue {
  register: (handle: SearchHandle) => () => void;
  /** Whether the popup is open; popups stay mounted through their exit animation. */
  open: boolean;
}

export const DropdownSearchHostContext = createContext<DropdownSearchHostValue | null>(null);

const ROW_SELECTOR = [
  '[role="menuitem"]:not([aria-disabled="true"])',
  '[role="menuitemradio"]:not([aria-disabled="true"])',
  '[role="menuitemcheckbox"]:not([aria-disabled="true"])',
].join(', ');

const ANY_ROW = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** Whether `a` comes before `b` in the document. */
function precedes(a: Node, b: Node) {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function menuRows(from: HTMLElement | null): HTMLElement[] {
  const menu = from?.closest<HTMLElement>('[role="menu"]');
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>(ROW_SELECTOR)) : [];
}

/** Scroll the menu's list to its top; the walk stops at the menu, never the page. */
function scrollToTop(row: HTMLElement) {
  const menu = row.closest<HTMLElement>('[role="menu"]');
  for (let el = row.parentElement; el && menu?.contains(el); el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      el.scrollTop = 0;
      return;
    }
  }
}

/** Hosts a DropdownSearch inside a popup: returns the context value, a
 *  capture-phase keydown handler for the popup, and field-presence checks. */
export function useDropdownSearchHost(open: boolean) {
  const handleRef = useRef<SearchHandle | null>(null);
  // Reactive twin of the ref, for render-time decisions.
  const [searchMounted, setSearchMounted] = useState(false);

  const register = useCallback((handle: SearchHandle) => {
    handleRef.current = handle;
    setSearchMounted(true);
    return () => {
      if (handleRef.current === handle) {
        handleRef.current = null;
        setSearchMounted(false);
      }
    };
  }, []);

  const host = useMemo(() => ({ register, open }), [register, open]);

  // Typing on a focused row goes into the field (Space still activates the
  // row). Arrowing off the first or last row returns to the field instead of
  // wrapping past it.
  const onKeyDownCapture = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    const handle = handleRef.current;
    if (!handle?.input) return;
    if (e.target === handle.input) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target?.matches(ANY_ROW)) return;
      const up = e.key === 'ArrowUp';
      const rows = menuRows(target);
      const edge = up ? rows[0] : rows[rows.length - 1];
      // "Past" because Base UI lets arrows land on a disabled row beyond the edge.
      const pastEdge =
        !edge || edge === target || (up ? precedes(target, edge) : precedes(edge, target));
      if (pastEdge) {
        e.preventDefault();
        e.stopPropagation();
        handle.input.focus();
        // The next ↓ lands on the first row, so show the top of the list.
        scrollToTop(target);
      }
    } else if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      e.stopPropagation();
      handle.input.focus();
      handle.append(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      handle.input.focus();
      handle.deleteBackward();
    }
  }, []);

  const hasSearch = useCallback(() => handleRef.current !== null, []);

  /** Whether a mounted field takes focus on open (after the primitive's own). */
  const searchTakesFocus = useCallback(() => handleRef.current?.autoFocus ?? false, []);

  return {
    host,
    hasSearch,
    searchTakesFocus,
    searchMounted,
    onKeyDownCapture,
  };
}

// ---------------------------------------------------------------------------
// DropdownSearch
// ---------------------------------------------------------------------------

export interface DropdownSearchProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'size' | 'defaultValue'
  > {
  /** The query. Filter the MenuItems you render against it. */
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Reset the query to "" when the popup closes. @default true */
  clearOnClose?: boolean;
  /** Take focus when the popup opens. @default true */
  autoFocus?: boolean;
}

const DropdownSearch = forwardRef<HTMLInputElement, DropdownSearchProps>(
  (
    {
      value,
      onValueChange,
      placeholder = 'Search…',
      clearOnClose = true,
      autoFocus = true,
      className,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const icons = useIcons();
    const SearchIcon = icons.search;
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    const host = useContext(DropdownSearchHostContext);
    const open = host?.open ?? true;
    // Painted explicitly: rows scroll under the sticky field, and its parent
    // may be display:contents, where `bg-inherit` resolves to transparent.
    const surface = useSurface();
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Latest props for the handle and unmount cleanup, without re-registering.
    const valueRef = useRef(value);
    const onValueChangeRef = useRef(onValueChange);
    const clearOnCloseRef = useRef(clearOnClose);
    const autoFocusRef = useRef(autoFocus);
    useIsoLayoutEffect(() => {
      valueRef.current = value;
      onValueChangeRef.current = onValueChange;
      clearOnCloseRef.current = clearOnClose;
      autoFocusRef.current = autoFocus;
    });

    useEffect(() => {
      if (!host) return;
      return host.register({
        get input() {
          return inputRef.current;
        },
        get autoFocus() {
          return autoFocusRef.current;
        },
        append: (text) => onValueChangeRef.current(valueRef.current + text),
        deleteBackward: () => onValueChangeRef.current(valueRef.current.slice(0, -1)),
      });
    }, [host]);

    // On every open (including a reopen mid-exit): reset the query and take
    // focus two frames in, after the popup's own initial focus.
    useEffect(() => {
      if (!open) return;
      if (clearOnCloseRef.current && valueRef.current !== '') {
        onValueChangeRef.current('');
      }
      if (!autoFocus) return;
      let inner: number | undefined;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => inputRef.current?.focus());
      });
      return () => {
        cancelAnimationFrame(outer);
        if (inner !== undefined) cancelAnimationFrame(inner);
      };
    }, [open, autoFocus]);

    useEffect(
      () => () => {
        if (clearOnCloseRef.current && valueRef.current !== '') {
          onValueChangeRef.current('');
        }
      },
      [],
    );

    const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      // Escape and Tab belong to the menu; nothing else may reach its typeahead.
      if (e.key === 'Escape' || e.key === 'Tab') return;
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const rows = menuRows(e.currentTarget);
        if (rows.length === 0) return;
        e.preventDefault();
        // biome-ignore lint/style/noNonNullAssertion: The length guard proves both endpoint rows exist.
        (e.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1])!.focus();
      } else if (e.key === 'Enter') {
        // Nothing to pick; keep a surrounding form from submitting.
        e.preventDefault();
      }
    };

    return (
      <div
        // Bleeds into the popup's 4px padding so the divider runs edge to edge.
        className={cn(
          'group/search sticky top-0 z-20 -mx-1 -mt-1 mb-0.5 flex shrink-0 items-center border-b border-border/60',
          SURFACE_BG[surface],
          sizeClasses.control,
          sizeClasses.gap,
          compact ? 'px-2.5' : 'px-3',
          className,
        )}
      >
        <SearchIcon
          size={sizeClasses.icon}
          strokeWidth={1.5}
          className="shrink-0 text-muted-foreground transition-[color,stroke-width] duration-80 group-focus-within/search:text-foreground group-focus-within/search:stroke-[2]"
        />
        {/* biome-ignore lint/a11y/useSemanticElements: Retain the kit searchbox semantics without native search decorations. */}
        <input
          ref={(node) => {
            inputRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
          }}
          type="text"
          role="searchbox"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          // rounded-none: a :focus-visible radius would clip the caret.
          className={cn(
            'min-w-0 flex-1 rounded-none bg-transparent text-foreground placeholder:text-muted-foreground outline-none font-[inherit]',
            sizeClasses.field,
            // Safari draws the caret the full line height.
            compact ? 'leading-5' : 'leading-6',
          )}
          {...props}
        />
      </div>
    );
  },
);

DropdownSearch.displayName = 'DropdownSearch';

// ---------------------------------------------------------------------------
// DropdownEmpty
// ---------------------------------------------------------------------------

const DropdownEmpty = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const sizeClasses = useSize();
    return (
      <div
        ref={ref}
        role="status"
        aria-live="polite"
        className={cn('px-2 py-6 text-center text-muted-foreground', sizeClasses.text, className)}
        {...props}
      />
    );
  },
);

DropdownEmpty.displayName = 'DropdownEmpty';

export { DropdownEmpty, DropdownSearch };
