import type { CorralDefinition, CorralNode } from '@corral/contracts';
import { type Diagnostic, isBox } from '@corral/core';
import { type DragEvent as ReactDragEvent, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button, Keycap, KitBadge, useSize } from '../design-kit/index.ts';
import { focusRing } from '../design-kit/lib/focus.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { cn } from '../design-kit/lib/utils.ts';
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Command,
  Eye,
  Gauge,
  Plus,
  TriangleAlert,
} from '../ui/icons.ts';
import { KIND_ICON, kindOf } from './kinds.ts';
import { requiredReviewLoopIds } from './roster.ts';
import type { TeamSelection } from './TeamGraphCanvas.tsx';

// The team as an outline: every step in flow order, boxes with their members inside. Dragging a
// row onto a box moves the step into it; dropping it on the team row moves it to the top level.

const NODE_DRAG_TYPE = 'application/x-corral-node';

/** The outline and the composition list use the same validation state and severity colors. */
export function ProblemCountBadge({
  diagnostics,
  validationStatus,
}: {
  diagnostics: readonly Diagnostic[];
  validationStatus?: string | undefined;
}) {
  const t = useTranslations('TeamEditor');
  return (
    <KitBadge
      size="compact"
      color={
        diagnostics.some((issue) => issue.severity === 'error')
          ? 'red'
          : diagnostics.length
            ? 'amber'
            : 'gray'
      }
    >
      {validationStatus ?? t('problems', { count: diagnostics.length })}
    </KitBadge>
  );
}

export interface StructureTreeProps {
  definition: CorralDefinition;
  hasWorkAgent: boolean;
  diagnostics: readonly Diagnostic[];
  validationStatus?: string | undefined;
  /** Flow order of the nodes, as the canvas lays them out. */
  order: ReadonlyMap<string, number>;
  selection: TeamSelection;
  onSelect: (selection: TeamSelection) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (boxId: string) => void;
  onMove: (nodeId: string, parentId: string | null) => void;
  onAdd: () => void;
  onTeamSettings: () => void;
  onSharedOutrider: () => void;
  onProblems: () => void;
  onCommands: () => void;
  /** Which team-wide view the sheet shows, if any. */
  view: 'team' | 'problems' | 'sharedOutrider' | null;
  /** A row of the stacked editor's column instead of its left side. */
  stacked?: boolean;
}

export function StructureTree({
  definition,
  hasWorkAgent,
  diagnostics,
  validationStatus,
  order,
  selection,
  onSelect,
  collapsed,
  onToggle,
  onMove,
  onAdd,
  onTeamSettings,
  onSharedOutrider,
  onProblems,
  onCommands,
  view,
  stacked = false,
}: StructureTreeProps) {
  const t = useTranslations('TeamEditor');
  const size = useSize();
  const [over, setOver] = useState<string | null>(null);
  const reviewLoops = useMemo(() => requiredReviewLoopIds(definition.nodes), [definition.nodes]);
  const selected = new Set(selection.nodes);
  const worst = new Map<string, Diagnostic['severity']>();
  for (const d of diagnostics) {
    if (!d.nodeId) continue;
    if (worst.get(d.nodeId) !== 'error') worst.set(d.nodeId, d.severity);
  }
  const children = (parentId: string | null) =>
    definition.nodes
      .filter((n) => (n.parentId ?? null) === parentId)
      .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));

  const dropProps = (parentId: string | null, key: string) => ({
    onDragOver: (event: ReactDragEvent) => {
      if (!event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
      event.preventDefault();
      setOver(key);
    },
    onDragLeave: () => setOver((current) => (current === key ? null : current)),
    onDrop: (event: ReactDragEvent) => {
      const nodeId = event.dataTransfer.getData(NODE_DRAG_TYPE);
      setOver(null);
      if (!nodeId) return;
      event.preventDefault();
      event.stopPropagation();
      onMove(nodeId, parentId);
    },
  });

  const row = (node: CorralNode, depth: number) => {
    const kind = kindOf(node);
    const Icon = KIND_ICON[kind];
    // A reference team's inside lives in its own editor, so here it neither opens nor takes steps.
    const box = isBox(node) && !(node.type === 'team' && node.source.kind === 'reference');
    const open = box && !collapsed.has(node.id);
    const reviewLoop = node.type === 'loop' && reviewLoops.has(node.id);
    const severity = worst.get(node.id);
    const dropping = over === node.id;
    return (
      <li key={node.id}>
        <div
          className={cn(
            'flex items-center gap-1 rounded-md pr-1',
            selected.has(node.id) ? 'bg-active' : 'hover:bg-hover',
            dropping && 'outline-2 outline-emphasis',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
          {...(box ? dropProps(node.id, node.id) : {})}
        >
          {box ? (
            <button
              type="button"
              aria-label={t(open ? 'collapse' : 'expand', { name: node.label })}
              aria-expanded={open}
              className={cn(
                focusRing,
                'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground',
              )}
              onClick={() => onToggle(node.id)}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span aria-hidden className="size-5 shrink-0" />
          )}
          <button
            type="button"
            draggable
            aria-pressed={selected.has(node.id)}
            className={cn(
              focusRing,
              size.type.body,
              'flex min-h-8 min-w-0 grow items-center gap-2 rounded-md px-1 text-left text-foreground',
              reviewLoop && 'py-1',
            )}
            onDragStart={(event) => {
              event.dataTransfer.setData(NODE_DRAG_TYPE, node.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={(event) => {
              if (event.shiftKey || event.metaKey || event.ctrlKey)
                onSelect({
                  nodes: selected.has(node.id)
                    ? selection.nodes.filter((id) => id !== node.id)
                    : [...selection.nodes, node.id],
                  edge: null,
                });
              else onSelect({ nodes: [node.id], edge: null });
            }}
          >
            <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate">{node.label}</span>
              {reviewLoop && (
                <span className={cn(size.type.caption, 'block text-muted-foreground')}>
                  {t('noFinalSubmission')}
                </span>
              )}
            </span>
            {severity ? (
              <span
                className={cn(
                  'ml-auto inline-flex shrink-0',
                  severity === 'error' ? 'text-destructive' : 'text-warning',
                )}
              >
                {severity === 'error' ? (
                  <CircleAlert size={14} aria-hidden />
                ) : (
                  <TriangleAlert size={14} aria-hidden />
                )}
              </span>
            ) : null}
          </button>
        </div>
        {open ? <ul>{children(node.id).map((child) => row(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    // The team row heads the outline: its name, its problems and the way to add a step. Beside
    // the work area the outline is the editor's left column, down to its bottom edge.
    <aside
      aria-label={t('outline')}
      className={cn(
        'flex flex-col border-border',
        stacked
          ? 'shrink-0 border-b'
          : 'col-start-1 row-span-2 row-start-1 min-h-0 w-[272px] border-r',
      )}
    >
      <div
        className={cn(
          'mx-2 mt-2 mb-1 flex items-center gap-2 rounded-md py-1.5 pr-0.5 pl-2',
          over === '__top' && 'outline-2 outline-emphasis',
        )}
        {...dropProps(null, '__top')}
      >
        <span
          className={cn(size.type.body, 'grow truncate text-foreground')}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {definition.name}
        </span>
        {hasWorkAgent && (
          <button
            type="button"
            disabled={Boolean(validationStatus)}
            aria-pressed={view === 'problems'}
            className={cn(focusRing, 'rounded-full')}
            onClick={onProblems}
          >
            <ProblemCountBadge diagnostics={diagnostics} validationStatus={validationStatus} />
          </button>
        )}
        <Button variant="ghost" size="icon-compact" aria-label={t('addStep')} onClick={onAdd}>
          <Plus />
        </Button>
      </div>
      {/* Stacked, a long outline scrolls in itself, so the canvas stays near the top. */}
      <ul
        className={cn(
          '-mt-1 scroll-py-2 overflow-y-auto px-2 pt-1 pb-2',
          stacked ? 'max-h-60' : 'min-h-0 flex-1',
        )}
      >
        {children(null).map((node) => row(node, 0))}
      </ul>
      {/* What belongs to the whole team stands under its steps, as in the composition list. */}
      <footer
        className={cn('gap-0.5 border-t border-border p-2', stacked ? 'flex flex-wrap' : 'grid')}
      >
        <Button
          variant="ghost"
          size="compact"
          className="justify-start"
          aria-pressed={view === 'sharedOutrider'}
          onClick={onSharedOutrider}
        >
          <Eye />
          {definition.sharedOutrider
            ? definition.sharedOutrider.targets.kind === 'all'
              ? t('sharedOutrider.entireSummary')
              : t('sharedOutrider.selectedSummary', {
                  count: definition.sharedOutrider.targets.nodeIds.length,
                })
            : t('sharedOutrider.add')}
        </Button>
        <Button
          variant="ghost"
          size="compact"
          className="justify-start"
          aria-pressed={view === 'team'}
          onClick={onTeamSettings}
        >
          <Gauge /> {t('teamSettings')}
        </Button>
        <Button variant="ghost" size="compact" className="justify-start" onClick={onCommands}>
          <Command /> {t('commands')}
          <span className="ml-auto">
            <Keycap>⌘K</Keycap>
          </span>
        </Button>
      </footer>
    </aside>
  );
}
