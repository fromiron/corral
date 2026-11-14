'use client';

// Connections: each connection is a row (brand, name and one status line) that expands into
// the host's details. ConnectionSheet is the add-connection dialog: one dialog whose faces
// (find, connect, found) spring into each other; ConnectionDirectory is its searchable
// directory face and ConnectionDiscovery its "found" face. Everything is props: the parent owns
// the connections, runs each connection and answers the callbacks.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useControllable } from '../../hooks/use-controllable.ts';
import {
  type UseFluidHoverReturn,
  useFluidHover,
  useRegisterFluidHoverItem,
} from '../../hooks/use-fluid-hover.ts';
import { initials } from '../../lib/agent-format.ts';
import { focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { type IconComponent, useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { typeClass } from '../../lib/type-scale.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.tsx';
import { FluidHoverHighlight } from '../ui/fluid-hover-highlight.tsx';
import { InputField, InputGroup } from '../ui/input-group.tsx';
import {
  AgentCard,
  type AgentMark,
  CircleCheck,
  Collapse,
  DisclosureChevron,
  Roll,
  RollNumber,
  resolveMark,
  SizeScope,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** State of a connection. `needs-auth` and `error` wait for the person. */
export type ConnectionStatus = 'connected' | 'needs-auth' | 'connecting' | 'error';

/** The inline button on a row that needs the person. */
export interface ConnectionRowAction {
  label: string;
  /** Accessible name, with the connection in it. */
  name: string;
  icon?: IconComponent;
  loading?: boolean;
  run: () => void;
}

export interface Connection {
  id: string;
  /** Visible name (`OpenAI`). */
  name: string;
  /** Brand mark or icon component. Omitted, the name's initials. */
  logo?: AgentMark;
  status: ConnectionStatus;
  /** The one line under the name: how it is connected, or what it needs. */
  line: string;
  /** The one thing to do about a row that needs the person. */
  action?: ConnectionRowAction | null;
  /** What the row shows once expanded. */
  details?: ReactNode;
}

export interface ConnectionsLabels {
  /** Region name (the heading, visually hidden with `titleHidden`). */
  title: string;
  add: string;
  /** Shown while there are no connections. */
  empty: string;
  /** Live-region wording for a new or changed connection, and a removed one. */
  announce: (connection: Connection) => string;
  removed: (name: string) => string;
}

export interface ConnectionsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  connections: Connection[];
  /** Controlled expanded connection id (one at a time); `null` collapses all. */
  expanded?: string | null;
  defaultExpanded?: string | null;
  onExpandedChange?: (id: string | null) => void;
  /** Add pressed. Omit to hide the button. */
  onAdd?: () => void;
  /** Whether the add dialog is open (for the button's `aria-expanded`). */
  addOpen?: boolean;
  /** Controls beside Add, such as a menu. */
  actions?: ReactNode;
  /** Keeps the heading for assistive tech only, where the page already names the list. */
  titleHidden?: boolean;
  labels: ConnectionsLabels;
  /** Density step for the panel and everything inside it. */
  size?: SizeVariant;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: 'var(--success)',
  'needs-auth': 'var(--warning)',
  connecting: 'var(--muted-foreground)',
  error: 'var(--destructive)',
};

function StatusGlyph({ status, size }: { status: ConnectionStatus; size: number }) {
  const icons = useIcons();
  if (status === 'connected') return <CircleCheck size={size} strokeWidth={1.8} />;
  const Icon =
    status === 'needs-auth'
      ? icons.link
      : status === 'error'
        ? icons['alert-triangle']
        : icons.hourglass;
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center',
        status === 'connecting' && 'pulse-soft',
      )}
      aria-hidden
    >
      <Icon size={size} strokeWidth={1.75} />
    </span>
  );
}

/** A brand mark, or the name's initials on a quiet tile. */
export function ConnectionMark({
  name,
  logo,
  size = 20,
}: {
  name: string;
  logo?: AgentMark | undefined;
  size?: number;
}) {
  const shape = useShape();
  const Mark = resolveMark(logo);
  if (Mark)
    return (
      <span className="grid shrink-0 place-items-center text-foreground" aria-hidden>
        <Mark size={size} />
      </span>
    );
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center border border-border bg-background text-foreground',
        typeClass('micro', 'compact'),
        'leading-none',
        shape.chip,
      )}
      style={{ width: size, height: size, fontVariationSettings: fontWeights.semibold }}
    >
      {initials(name).slice(0, 2) || name.charAt(0)}
    </span>
  );
}

// ─── Connection row ──────────────────────────────────────────────────────────

interface RowProps {
  connection: Connection;
  index: number;
  open: boolean;
  hover: UseFluidHoverReturn;
  registerButton: (id: string, el: HTMLButtonElement | null) => void;
  onToggleOpen: () => void;
}

function ConnectionRow({ connection, index, open, hover, registerButton, onToggleOpen }: RowProps) {
  const size = useSize();
  const shape = useShape();
  const id = useId();
  const headRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useRegisterFluidHoverItem(hover.registerItem, index, headRef);

  const compact = size.variant === 'compact';
  const ids = { name: `${id}-name`, line: `${id}-line`, fold: `${id}-fold` };
  const action = connection.action ?? null;

  // The action button goes away (or disables while connecting) once pressed; hand focus back
  // to the row so it isn't dropped on the page.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || connection.status === 'connecting') return;
    refocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || headRef.current?.contains(active))
      buttonRef.current?.focus();
  }, [connection.status]);

  // Inside the body the shared row highlight steps aside.
  const foldHandlers = {
    onMouseMove: (e: MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      hover.setActiveIndex(null);
    },
    onMouseLeave: () => hover.handlers.onMouseEnter(),
  };
  const inset = compact ? 'pr-2.5 pl-[40px]' : 'pr-3 pl-[44px]';
  const muted = connection.status === 'connected';
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);

  return (
    <>
      <div
        ref={headRef}
        data-fluid-hover-index={index}
        className={cn(
          'relative z-10 flex items-center',
          compact ? 'min-h-12 gap-2.5 px-2.5 py-2' : 'min-h-14 gap-3 px-3 py-2.5',
        )}
      >
        {/* The whole row toggles; the action sits above this layer. */}
        <button
          ref={(el) => {
            buttonRef.current = el;
            registerButton(connection.id, el);
          }}
          type="button"
          data-connection-row=""
          aria-expanded={open}
          aria-controls={ids.fold}
          aria-labelledby={`${ids.name} ${ids.line}`}
          onClick={onToggleOpen}
          className={cn('absolute inset-0 cursor-pointer', shape.bg, focusRingInset)}
        />
        <span className="pointer-events-none">
          <ConnectionMark name={connection.name} logo={connection.logo} size={compact ? 18 : 20} />
        </span>
        <span className="pointer-events-none grid min-w-0 flex-1">
          <span
            id={ids.name}
            className={cn(size.type.body, 'truncate text-foreground')}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {connection.name}
          </span>{' '}
          <span
            className={cn(
              size.type.caption,
              'flex min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground',
            )}
          >
            <Roll id={`${connection.status}:${connection.line}`} className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-flex shrink-0"
                  style={{ color: STATUS_COLOR[connection.status] }}
                >
                  <StatusGlyph status={connection.status} size={compact ? 12 : 13} />
                </span>
                <span
                  id={ids.line}
                  className={cn('truncate', connection.status === 'connecting' && 'shimmer-text')}
                  style={muted ? undefined : { color: STATUS_COLOR[connection.status] }}
                >
                  {connection.line}
                </span>
              </span>
            </Roll>
          </span>
        </span>{' '}
        <AnimatePresence initial={false}>
          {action && (
            <motion.span
              key="action"
              className="relative z-10 shrink-0"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94, transition: spring.fast.exit }}
              transition={spring.moderate}
            >
              <Button
                variant="secondary"
                size="compact"
                leadingIcon={action.icon}
                loading={action.loading}
                aria-label={action.name}
                onClick={() => {
                  refocus.current = true;
                  action.run();
                }}
              >
                {action.label}
              </Button>
            </motion.span>
          )}
        </AnimatePresence>
        <DisclosureChevron open={open} size={compact ? 14 : 15} />
      </div>

      <Collapse open={open} id={ids.fold} {...foldHandlers}>
        <div className={cn('grid gap-2.5 pb-4 @max-[520px]:pl-3', inset)}>
          {/* Details mount on first open and stay for the fold's closing spring. */}
          {opened ? connection.details : null}
        </div>
      </Collapse>
    </>
  );
}

// ─── Connections ─────────────────────────────────────────────────────────────

const ConnectionsBody = forwardRef<HTMLDivElement, Omit<ConnectionsProps, 'size'>>(
  (
    {
      connections,
      expanded: expandedProp,
      defaultExpanded = null,
      onExpandedChange,
      onAdd,
      addOpen = false,
      actions,
      titleHidden = false,
      labels,
      className,
      ...props
    },
    ref,
  ) => {
    const size = useSize();
    const shape = useShape();
    const icons = useIcons();
    const titleId = useId();
    const [expanded, setExpanded] = useControllable<string | null>(
      expandedProp,
      defaultExpanded,
      onExpandedChange,
    );
    const listRef = useRef<HTMLDivElement>(null);
    const hover = useFluidHover(listRef, { gapClick: false });

    // Live region: describe each change to the connections once it lands.
    const [prev, setPrev] = useState(connections);
    const [said, setSaid] = useState({ text: '', n: 0 });
    if (prev !== connections) {
      const before = new Map(prev.map((c) => [c.id, c]));
      const lines: string[] = [];
      for (const c of connections) {
        const was = before.get(c.id);
        if (!was || was.status !== c.status || was.line !== c.line) lines.push(labels.announce(c));
      }
      const ids = new Set(connections.map((c) => c.id));
      for (const was of prev) if (!ids.has(was.id)) lines.push(labels.removed(was.name));
      setPrev(connections);
      if (lines.length) setSaid((s) => ({ text: lines.join(' '), n: s.n + 1 }));
    }

    // A removed row hands focus to its neighbour (or Add) when focus was inside it.
    const rowButtons = useRef(new Map<string, HTMLButtonElement>());
    const addRef = useRef<HTMLButtonElement>(null);
    const order = useRef<string[]>(connections.map((c) => c.id));
    useEffect(() => {
      const before = order.current;
      const now = connections.map((c) => c.id);
      order.current = now;
      const gone = before.findIndex((id) => !now.includes(id));
      if (gone === -1) return;
      // Focus still on something (another row, a dialog) stays where it is.
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const neighbour = [...before.slice(gone + 1), ...before.slice(0, gone).reverse()].find((id) =>
        now.includes(id),
      );
      const target = neighbour ? rowButtons.current.get(neighbour) : undefined;
      if (target) target.focus();
      else addRef.current?.focus();
    }, [connections]);

    const registerButton = (id: string, el: HTMLButtonElement | null) => {
      if (el) rowButtons.current.set(id, el);
      else rowButtons.current.delete(id);
    };

    const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (!target.matches('[data-connection-row]')) return;
      const rows = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('[data-connection-row]') ?? [],
      );
      const i = rows.indexOf(target as HTMLButtonElement);
      const next =
        e.key === 'ArrowDown'
          ? Math.min(rows.length - 1, i + 1)
          : e.key === 'ArrowUp'
            ? Math.max(0, i - 1)
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? rows.length - 1
                : -1;
      if (next < 0 || i < 0) return;
      e.preventDefault();
      rows[next]?.focus();
    };

    const gutter = size.variant === 'compact' ? 'px-4' : 'px-5';

    return (
      <AgentCard
        ref={ref}
        role="region"
        aria-labelledby={titleId}
        className={cn('@container', className)}
        {...props}
      >
        <header
          className={cn(
            'flex items-center justify-between gap-3 pt-3.5 @max-[480px]:px-4',
            gutter,
            titleHidden && 'pt-3',
          )}
        >
          <h2
            id={titleId}
            className={cn(
              size.type.subtitle,
              'm-0 flex min-w-0 items-center gap-2 text-foreground',
              titleHidden && 'sr-only',
            )}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            <span className="truncate">{labels.title}</span>
          </h2>
          <div className={cn('flex shrink-0 items-center gap-1', titleHidden && 'ml-auto')}>
            {actions}
            {onAdd && (
              <Button
                ref={addRef}
                variant="tertiary"
                leadingIcon={icons.plus}
                aria-haspopup="dialog"
                aria-expanded={addOpen}
                onClick={onAdd}
                className="shrink-0"
              >
                {labels.add}
              </Button>
            )}
          </div>
        </header>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys move between the row toggles; each row keeps its own button. */}
        <div
          ref={listRef}
          className="relative px-2 pt-2 pb-2"
          onMouseMove={hover.handlers.onMouseMove}
          onMouseEnter={hover.handlers.onMouseEnter}
          onMouseLeave={hover.handlers.onMouseLeave}
          onKeyDown={onListKeyDown}
        >
          <FluidHoverHighlight hover={hover} className={shape.bg} />
          <AnimatePresence initial={false} mode="popLayout">
            {connections.map((connection, i) => (
              <motion.article
                key={connection.id}
                layout="position"
                aria-label={connection.name}
                data-connection={connection.id}
                className={cn(i > 0 && 'border-t border-border')}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, transition: spring.moderate.exit }}
                transition={{ ...spring.slow, layout: spring.moderate }}
              >
                <ConnectionRow
                  connection={connection}
                  index={i}
                  open={expanded === connection.id}
                  hover={hover}
                  registerButton={registerButton}
                  onToggleOpen={() =>
                    setExpanded(expanded === connection.id ? null : connection.id)
                  }
                />
              </motion.article>
            ))}
          </AnimatePresence>
          {connections.length === 0 && (
            <p className={cn(size.type.body, 'm-0 px-3 pt-1 pb-3 text-muted-foreground')}>
              {labels.empty}
            </p>
          )}
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          {said.text}
          {said.n % 2 ? ' ' : ''}
        </p>
      </AgentCard>
    );
  },
);
ConnectionsBody.displayName = 'ConnectionsBody';

/** Connections as expandable rows with one status line each, and an Add action. */
export const Connections = forwardRef<HTMLDivElement, ConnectionsProps>(
  ({ size, ...props }, ref) => (
    <SizeScope size={size}>
      <ConnectionsBody ref={ref} {...props} />
    </SizeScope>
  ),
);
Connections.displayName = 'Connections';

// ─── Add-connection sheet ────────────────────────────────────────────────────

export interface ConnectionSheetProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  open: boolean;
  /** Close button, Escape or a click outside asked to close. */
  onOpenChange: (open: boolean) => void;
  /** The face shown; changing it springs the old face out and the new one in. */
  face: string;
  /** The face's title; it rolls with the face. */
  title: ReactNode;
  /** Name of the close button. */
  closeLabel: string;
  /** Where focus lands when the face changes: its title, or the face's own control. */
  focusTitle?: boolean;
  children: ReactNode;
  /** Density step for the sheet. */
  size?: SizeVariant;
}

const SheetBody = forwardRef<HTMLDivElement, Omit<ConnectionSheetProps, 'size'>>(
  ({ open, onOpenChange, face, title, closeLabel, focusTitle = true, children, ...props }, ref) => {
    const reduce = useReducedMotion() ?? false;
    const icons = useIcons();
    const XIcon = icons.x;
    const titleRef = useRef<HTMLHeadingElement>(null);
    // Each later face lands focus on its title unless the face takes focus itself.
    const first = useRef(true);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The face change is the trigger.
    useEffect(() => {
      if (!open) {
        first.current = true;
        return;
      }
      if (first.current) {
        first.current = false;
        return;
      }
      if (!focusTitle) return;
      const id = requestAnimationFrame(() => titleRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }, [open, face]);

    const enter = reduce ? false : { opacity: 0, y: 4 };
    return (
      <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
        <DialogContent ref={ref} size="sm" showCloseButton={false} {...props}>
          <DialogHeader className="pr-8">
            <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
              <Roll id={face}>{title}</Roll>
            </DialogTitle>
          </DialogHeader>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-3 top-3"
            aria-label={closeLabel}
            onClick={() => onOpenChange(false)}
          >
            <XIcon aria-hidden />
          </Button>
          {/* The inset leaves room for focus rings at the clip edge. */}
          <Collapse className="-m-1.5" innerClassName="relative p-1.5">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={face}
                initial={enter}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: spring.moderate.exit }}
                transition={spring.moderate}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </Collapse>
        </DialogContent>
      </Dialog>
    );
  },
);
SheetBody.displayName = 'ConnectionSheetBody';

/** Add-connection dialog: one dialog whose faces spring into each other. */
export const ConnectionSheet = forwardRef<HTMLDivElement, ConnectionSheetProps>(
  ({ size, ...props }, ref) => (
    <SizeScope size={size}>
      <SheetBody ref={ref} {...props} />
    </SizeScope>
  ),
);
ConnectionSheet.displayName = 'ConnectionSheet';

// ─── Directory face ──────────────────────────────────────────────────────────

export interface ConnectionDirectoryEntry {
  id: string;
  name: string;
  logo?: AgentMark;
  /** One line under the name. */
  description?: string;
  /** More text the search matches. */
  keywords?: string;
  /** A mark at the row's end (that it is connected). */
  trailing?: ReactNode;
}

export interface ConnectionDirectoryProps {
  entries: ConnectionDirectoryEntry[];
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (entry: ConnectionDirectoryEntry) => void;
  labels: { search: string; directory: string; noMatch: (query: string) => string };
  /** Below the directory: a quieter way in. */
  footer?: ReactNode;
}

/** The directory face: a search field over rows that pick a connection. */
export function ConnectionDirectory({
  entries,
  query,
  onQueryChange,
  onPick,
  labels,
  footer,
}: ConnectionDirectoryProps) {
  const size = useSize();
  const shape = useShape();
  const icons = useIcons();
  const searchRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef, { gapClick: false });

  // Back on the directory (or just opened): the search field takes focus.
  useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const q = query.trim().toLowerCase();
  const items = entries.filter((entry) =>
    `${entry.name} ${entry.description ?? ''} ${entry.keywords ?? ''}`.toLowerCase().includes(q),
  );
  const rows = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-directory-row]') ?? []);
  const onSearchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' || e.nativeEvent.isComposing) return;
    const first = rows()[0];
    if (!first) return;
    e.preventDefault();
    first.focus();
  };
  const onRowsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    const i = all.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    const next =
      e.key === 'ArrowDown'
        ? Math.min(all.length - 1, i + 1)
        : e.key === 'ArrowUp'
          ? i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    if (next < 0) searchRef.current?.querySelector('input')?.focus();
    else all[next]?.focus();
  };

  return (
    <div className="grid gap-3">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: ArrowDown moves from the field into the rows; the field keeps its own keys. */}
      <div ref={searchRef} onKeyDown={onSearchKey}>
        <InputGroup className="w-full">
          <InputField
            index={0}
            label={labels.search}
            labelHidden
            icon={icons.search}
            placeholder={labels.search}
            value={query}
            onChange={onQueryChange}
            autoComplete="off"
          />
        </InputGroup>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: A named group of row buttons, not a form fieldset; arrow keys move between the buttons, which keep their own activation. */}
      <div
        ref={listRef}
        role="group"
        aria-label={labels.directory}
        className="relative -mx-1 grid max-h-[min(22rem,50dvh)] overflow-y-auto px-1"
        onMouseMove={hover.handlers.onMouseMove}
        onMouseEnter={hover.handlers.onMouseEnter}
        onMouseLeave={hover.handlers.onMouseLeave}
        onKeyDown={onRowsKey}
      >
        <FluidHoverHighlight hover={hover} className={shape.bg} />
        {items.length ? (
          items.map((entry, i) => (
            <DirectoryRow
              key={entry.id}
              entry={entry}
              index={i}
              register={hover.registerItem}
              onPick={onPick}
            />
          ))
        ) : (
          <p
            className={cn(
              size.type.body,
              'm-0 px-2.5 py-2 text-muted-foreground [overflow-wrap:anywhere]',
            )}
          >
            {labels.noMatch(query.trim())}
          </p>
        )}
      </div>
      {footer}
    </div>
  );
}

function DirectoryRow({
  entry,
  index,
  register,
  onPick,
}: {
  entry: ConnectionDirectoryEntry;
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  onPick: (entry: ConnectionDirectoryEntry) => void;
}) {
  const size = useSize();
  const shape = useShape();
  const ref = useRef<HTMLButtonElement>(null);
  useRegisterFluidHoverItem(register, index, ref);
  return (
    <button
      ref={ref}
      type="button"
      data-directory-row=""
      data-fluid-hover-index={index}
      onClick={() => onPick(entry)}
      className={cn(
        'relative z-10 flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left',
        shape.bg,
        focusRingInset,
      )}
    >
      <span className="grid size-5 shrink-0 place-items-center">
        <ConnectionMark name={entry.name} logo={entry.logo} size={18} />
      </span>
      <span className="grid min-w-0 flex-1">
        <span
          className={cn(size.type.body, 'truncate text-foreground')}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {entry.name}
        </span>{' '}
        {entry.description ? (
          <span className={cn(size.type.caption, 'truncate text-muted-foreground')}>
            {entry.description}
          </span>
        ) : null}
      </span>
      {entry.trailing ? (
        <span className={cn(size.type.caption, 'shrink-0 text-muted-foreground')}>
          {entry.trailing}
        </span>
      ) : null}
    </button>
  );
}

/** The connected mark at a directory row's end: the kit's check with a spoken word. */
export function ConnectedMark({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center" style={{ color: 'var(--success)' }}>
      <CircleCheck size={15} strokeWidth={1.8} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ─── Discovery face ──────────────────────────────────────────────────────────

export interface ConnectionDiscoveryProps {
  /** The list is still being read. */
  working: boolean;
  /** Everything found; the face rolls the count up and lists the first `limit`. */
  items: { id: string; name: string; meta?: ReactNode }[];
  limit?: number;
  labels: {
    reading: string;
    /** Text before and after the rolling count. */
    before: string;
    after: (count: number) => string;
    list: string;
    more: (count: number) => string;
  };
}

/** The found face: the count rolls up while the found items rise into a list. */
export function ConnectionDiscovery({
  working,
  items,
  limit = 8,
  labels,
}: ConnectionDiscoveryProps) {
  const size = useSize();
  const reduce = useReducedMotion() ?? false;
  // The count starts at zero and rolls to the total once the face is up.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (working) return;
    const id = requestAnimationFrame(() => setShown(items.length));
    return () => cancelAnimationFrame(id);
  }, [working, items.length]);
  const listed = items.slice(0, limit);
  return (
    <div className="grid gap-3">
      <p
        role="status"
        className={cn(
          size.type.subtitle,
          'm-0',
          working ? 'shimmer-text text-muted-foreground' : 'text-foreground',
        )}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {working ? (
          labels.reading
        ) : (
          <>
            <span className="sr-only">{`${labels.before}${items.length}${labels.after(items.length)}`}</span>
            <span aria-hidden>
              {labels.before}
              <RollNumber value={shown} />
              {labels.after(items.length)}
            </span>
          </>
        )}
      </p>
      {!working && listed.length > 0 ? (
        <ul aria-label={labels.list} className="m-0 grid list-none gap-1 p-0">
          {listed.map((item, i) => (
            <motion.li
              key={item.id}
              className={cn(
                size.type.caption,
                'flex min-w-0 items-center gap-2 text-muted-foreground',
              )}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring.moderate, delay: reduce ? 0 : i * 0.04 }}
            >
              <CircleCheck size={13} strokeWidth={1.6} className="text-[color:var(--success)]" />
              <span className="min-w-0 truncate text-foreground">{item.name}</span>
              {item.meta ? (
                <span className="ml-auto shrink-0 tabular-nums">{item.meta}</span>
              ) : null}
            </motion.li>
          ))}
          {items.length > listed.length ? (
            <motion.li
              className={cn(size.type.caption, 'pl-[21px] text-muted-foreground')}
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...spring.moderate, delay: reduce ? 0 : listed.length * 0.04 }}
            >
              {labels.more(items.length - listed.length)}
            </motion.li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
