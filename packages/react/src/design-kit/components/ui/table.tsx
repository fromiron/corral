'use client';

import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  useContext,
  useMemo,
  useRef,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';

// A plain HTML table with one fluid hover highlight behind it. Body rows opt
// in by passing `index`; the lit row hides its borders so the highlight reads
// as one clean pill.

// ── Context ──────────────────────────────────────────────

interface TableContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
}

const TableContext = createContext<TableContextValue | null>(null);

// ── Table ────────────────────────────────────────────────

interface TableProps extends HTMLAttributes<HTMLTableElement> {
  children: ReactNode;
  /** Pins the table's rows to one step of the size ladder (default 36px,
   *  compact 28px). Omitted, it follows the surrounding SizeProvider. */
  size?: SizeVariant;
}

const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ children, size, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const sizeClasses = useSize(size);

    const hover = useFluidHover(containerRef);
    const { activeIndex, handlers, registerItem } = hover;

    const contextValue = useMemo(
      () => ({ registerItem, activeIndex }),
      [registerItem, activeIndex],
    );

    const table = (
      <TableContext.Provider value={contextValue}>
        {/* A div can't live inside <table>, so the highlight sits in this
            wrapper behind the table; rows sit above it (z-10). */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Pointer handlers only position the decorative hover highlight. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: The wrapper has no action; table content retains its own keyboard controls. */}
        <div
          ref={containerRef}
          className="relative"
          onMouseEnter={handlers.onMouseEnter}
          onMouseMove={handlers.onMouseMove}
          onMouseLeave={handlers.onMouseLeave}
          onClick={handlers.onClick}
        >
          <FluidHoverHighlight hover={hover} />

          <table
            ref={ref}
            className={cn('w-full border-collapse', sizeClasses.text, className)}
            {...props}
          >
            {children}
          </table>
        </div>
      </TableContext.Provider>
    );

    return size ? <SizeProvider size={size}>{table}</SizeProvider> : table;
  },
);

Table.displayName = 'Table';

// ── TableHeader ──────────────────────────────────────────

const TableHeader = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn('', className)} {...props} />,
);

TableHeader.displayName = 'TableHeader';

// ── TableBody ────────────────────────────────────────────

const TableBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn('', className)} {...props} />,
);

TableBody.displayName = 'TableBody';

// ── TableRow ─────────────────────────────────────────────

interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  index?: number;
}

const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ index, className, style, ...props }, ref) => {
    const internalRef = useRef<HTMLTableRowElement>(null);
    const ctx = useContext(TableContext);

    useRegisterFluidHoverItem(ctx?.registerItem, index, internalRef);

    const isBodyRow = index !== undefined;
    const activeIdx = ctx?.activeIndex ?? null;
    // Rows draw only a bottom border, so the lit row also hides the one above
    // it (the header's, for row 0).
    const hideBorder =
      activeIdx !== null &&
      ((isBodyRow && (index === activeIdx || index === activeIdx - 1)) ||
        (!isBodyRow && activeIdx === 0));

    return (
      <tr
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLTableRowElement | null>).current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLTableRowElement | null>).current = node;
        }}
        data-fluid-hover-index={index}
        // `is-active` lets every cell read the lit state through the row.
        className={cn(
          'group/row relative z-10 border-b transition-[border-color] duration-80',
          hideBorder ? 'border-transparent' : 'border-accent/40',
          isBodyRow && activeIdx === index && 'is-active',
          className,
        )}
        style={{
          ...style,
          fontVariationSettings: isBodyRow ? fontWeights.normal : fontWeights.semibold,
        }}
        {...props}
      />
    );
  },
);

TableRow.displayName = 'TableRow';

// ── TableHead ────────────────────────────────────────────

const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => {
    const sizeClasses = useSize();
    return (
      <th
        ref={ref}
        className={cn(
          'text-left text-foreground',
          // py + line box = 36px / 28px row height.
          sizeClasses.variant === 'compact' ? 'px-2.5 py-[5px]' : 'px-3 py-2',
          className,
        )}
        {...props}
      />
    );
  },
);

TableHead.displayName = 'TableHead';

// ── TableCell ────────────────────────────────────────────

const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => {
    const sizeClasses = useSize();
    return (
      <td
        ref={ref}
        // Same padding as TableHead so every row shares a height.
        className={cn(
          'text-muted-foreground transition-colors duration-80 group-[.is-active]/row:text-foreground',
          sizeClasses.variant === 'compact' ? 'px-2.5 py-[5px]' : 'px-3 py-2',
          className,
        )}
        {...props}
      />
    );
  },
);

TableCell.displayName = 'TableCell';

// ── Exports ──────────────────────────────────────────────

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
