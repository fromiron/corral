import { ChevronRight, FileText, Folder, FolderOpen } from '@corral/react/icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { TreeRow } from './fileTree.ts';

const ROW = 28;

/**
 * The Files tree (WAI-ARIA tree view). One row takes Tab; arrows move, Right/Left open and close
 * folders or step in and out, Home/End jump, Enter opens a file or toggles a folder. Rows are
 * virtualized, so each carries its level and position for assistive technology.
 */
export function FileTree({
  label,
  rows,
  active,
  onOpen,
  onToggle,
  reveal,
}: {
  label: string;
  rows: TreeRow[];
  /** The file shown now, marked selected. */
  active: string | null;
  onOpen(path: string): void;
  onToggle(path: string, open: boolean): void;
  /** A row to scroll to and focus once it is shown, e.g. a folder chosen in quick open. */
  reveal?: { path: string; seq: number } | null;
}) {
  const t = useTranslations('Files');
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW,
    overscan: 8,
  });
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const stop =
    rows.find((row) => row.path === focusPath)?.path ??
    rows.find((row) => row.path === active)?.path ??
    rows[0]?.path;
  // A moved focus lands once its row is rendered; a far row is scrolled in first.
  useEffect(() => {
    const path = pending.current;
    if (!path) return;
    const row = [...(scroll.current?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])].find(
      (item) => item.dataset.treePath === path,
    );
    if (row) {
      pending.current = null;
      row.focus();
    }
  });
  const revealed = useRef(0);
  useEffect(() => {
    if (!reveal || revealed.current === reveal.seq) return;
    const index = rows.findIndex((row) => row.path === reveal.path);
    if (index === -1) return;
    revealed.current = reveal.seq;
    pending.current = reveal.path;
    setFocusPath(reveal.path);
    virtual.scrollToIndex?.(index, { align: 'auto' });
  }, [reveal, rows, virtual]);
  const move = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    pending.current = row.path;
    setFocusPath(row.path);
    virtual.scrollToIndex?.(rows.indexOf(row));
  };
  const activate = (row: TreeRow) => {
    setFocusPath(row.path);
    if (row.kind === 'folder') onToggle(row.path, !row.expanded);
    else onOpen(row.path);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, row: TreeRow, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.kind !== 'folder') return;
        if (!row.expanded) onToggle(row.path, true);
        else if (rows[index + 1]?.parent === row.path) move(index + 1);
        break;
      case 'ArrowLeft':
        if (row.kind === 'folder' && row.expanded) onToggle(row.path, false);
        else if (row.parent) move(rows.findIndex((item) => item.path === row.parent));
        else return;
        break;
      // Space keeps the button's own activation on key up.
      case 'Enter':
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  return (
    <div
      ref={scroll}
      role="tree"
      aria-label={label}
      className="max-h-[70dvh] min-h-44 flex-1 overflow-auto overscroll-contain"
    >
      <div role="none" style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const folder = row.kind === 'folder';
          const Icon = folder ? (row.expanded ? FolderOpen : Folder) : FileText;
          return (
            <button
              key={row.path}
              type="button"
              role="treeitem"
              data-tree-path={row.path}
              title={row.path}
              tabIndex={row.path === stop ? 0 : -1}
              aria-level={row.level}
              aria-posinset={row.posInSet}
              aria-setsize={row.setSize}
              aria-expanded={folder ? row.expanded : undefined}
              aria-selected={row.path === active}
              aria-busy={row.loading || undefined}
              onClick={() => activate(row)}
              onKeyDown={(event) => onKeyDown(event, row, item.index)}
              onFocus={() => setFocusPath(row.path)}
              style={{
                position: 'absolute',
                top: item.start,
                left: 0,
                width: '100%',
                height: item.size,
                paddingInlineStart: `${0.25 + (row.level - 1) * 0.875}rem`,
              }}
              className={`flex items-center gap-1.5 rounded-md pr-2 text-left text-caption transition-colors duration-80 hover:bg-hover focus-visible:-outline-offset-2 ${row.path === active ? 'bg-secondary text-foreground' : 'text-foreground'}`}
            >
              <ChevronRight
                size={14}
                aria-hidden
                className={`shrink-0 text-muted-foreground transition-transform duration-80 motion-reduce:transition-none ${folder ? '' : 'invisible'} ${row.expanded ? 'rotate-90' : ''}`}
              />
              <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{row.name}</span>
              {row.loading ? (
                <span className="ml-auto shrink-0 text-muted-foreground">{t('folderLoading')}</span>
              ) : row.failed ? (
                <span className="ml-auto shrink-0 text-danger">{t('folderFailed')}</span>
              ) : row.truncated ? (
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {t('folderTruncated')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
