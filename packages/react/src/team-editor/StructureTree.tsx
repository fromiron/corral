import type { CorralDefinition, CorralNode } from '@corral/contracts';
import { type Diagnostic, isBox } from '@corral/core';
import { type DragEvent as ReactDragEvent, useState } from 'react';
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
  Gauge,
  Plus,
  TriangleAlert,
} from '../ui/icons.ts';
import { KIND_ICON, kindOf } from './kinds.ts';
import type { TeamSelection } from './TeamGraphCanvas.tsx';

// The team as an outline: every step in flow order, boxes with their members inside. Dragging a
// row onto a box moves the step into it; dropping it on the team row moves it to the top level.

const NODE_DRAG_TYPE = 'application/x-corral-node';

export interface StructureTreeProps {
  definition: CorralDefinition;
  diagnostics: readonly Diagnostic[];
  /** Flow order of the nodes, as the canvas lays them out. */
  order: ReadonlyMap<string, number>;
  selection: TeamSelection;
  onSelect: (selection: TeamSelection) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (boxId: string) => void;
  canMove: (nodeId: string, parentId: string | null) => boolean;
  onMove: (nodeId: string, parentId: string | null) => void;
  onAdd: () => void;
  onTeamSettings: () => void;
  onCommands: () => void;
  teamSettingsOpen: boolean;
}

export function StructureTree({
  definition,
  diagnostics,
  order,
  selection,
  onSelect,
  collapsed,
  onToggle,
  canMove,
  onMove,
  onAdd,
  onTeamSettings,
  onCommands,
  teamSettingsOpen,
}: StructureTreeProps) {
  const t = useTranslations('TeamEditor');
  const size = useSize();
  const [over, setOver] = useState<string | null>(null);
  const selected = new Set(selection.nodes);
  const worst = new Map<string, Diagnostic['severity']>();
  for (const d of diagnostics) {
    if (!d.nodeId) continue;
    if (worst.get(d.nodeId) !== 'error') worst.set(d.nodeId, d.severity);
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
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
      if (canMove(nodeId, parentId)) onMove(nodeId, parentId);
    },
  });

  const row = (node: CorralNode, depth: number) => {
    const kind = kindOf(node);
    const Icon = KIND_ICON[kind];
    const box = isBox(node);
    const open = box && !collapsed.has(node.id);
    const severity = worst.get(node.id);
    const dropping = over === node.id;
    return (
      <li key={node.id}>
        <div
          className={cn(
            'flex items-center gap-1 rounded-md pr-1',
            selected.has(node.id) ? 'bg-selected/60' : 'hover:bg-hover',
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
              'flex h-8 min-w-0 grow items-center gap-2 rounded-md px-1 text-left text-foreground',
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
            <span className="truncate">{node.label}</span>
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
    <aside aria-label={t('outline')} className="flex min-h-0 flex-col border-r border-border">
      <header className="flex items-center gap-1.5 py-2 pr-2 pl-4">
        <h2
          className={cn(size.type.caption, 'grow text-muted-foreground')}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t('structure')}
        </h2>
        <Button variant="ghost" size="icon-compact" aria-label={t('addStep')} onClick={onAdd}>
          <Plus />
        </Button>
      </header>
      <div
        className={cn(
          'mx-2 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5',
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
        <KitBadge size="compact" color={errors ? 'red' : diagnostics.length ? 'amber' : 'gray'}>
          {t('problems', { count: diagnostics.length })}
        </KitBadge>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {children(null).map((node) => row(node, 0))}
      </ul>
      <footer className="grid gap-0.5 border-t border-border p-2">
        <Button
          variant="ghost"
          size="compact"
          className="justify-start"
          aria-pressed={teamSettingsOpen}
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
