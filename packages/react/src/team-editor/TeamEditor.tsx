import { isBox } from '@corral/core';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { ProfileOption } from '../components/NodeInspector.tsx';
import {
  Button,
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuInput,
  type CommandMenuItemData,
  CommandMenuList,
} from '../design-kit/index.ts';
import { spring } from '../design-kit/lib/springs.ts';
import { compileDraft } from '../editor/model.ts';
import type { EditorStore } from '../editor/store.ts';
import { Boxes, Maximize2, Minimize2, Redo2, Repeat2, Trash2, Undo2, Users } from '../ui/icons.ts';
import {
  checkPorts,
  connectPorts,
  type EditResult,
  type Placement,
  type PortRequest,
  placeStep,
  primaryOut,
  removeItems,
  type StepKind,
  setParent,
  wrapIn,
} from './commands.ts';
import { InspectorSheet } from './InspectorSheet.tsx';
import { ADDABLE, KIND_ICON } from './kinds.ts';
import { layoutTeam } from './layout.ts';
import { StructureTree } from './StructureTree.tsx';
import { STEP_DRAG_TYPE, TeamGraphCanvas, type TeamSelection } from './TeamGraphCanvas.tsx';

// The team editor (docs/specs/features/team-graph.md): the structure outline, the auto-laid-out
// canvas, a floating settings sheet and a command menu, all editing one draft in the editor
// store, so undo, redo and the unsaved state are shared with every other view of the team.

export interface TeamEditorProps {
  editor: EditorStore;
  profiles?: ProfileOption[] | null;
}

const NONE: TeamSelection = { nodes: [], edge: null };

export function TeamEditor({ editor, profiles = null }: TeamEditorProps) {
  const t = useTranslations('TeamEditor');
  const reduced = useReducedMotion() ?? false;
  const draft = useStore(editor, (s) => s.draft);
  const canUndo = useStore(editor, (s) => s.canUndo);
  const canRedo = useStore(editor, (s) => s.canRedo);
  const { definition } = draft;
  const nodes = useMemo(() => new Map(definition.nodes.map((n) => [n.id, n])), [definition]);
  const diagnostics = useMemo(() => compileDraft(draft).diagnostics, [draft]);

  const [rawSelection, setSelection] = useState<TeamSelection>(NONE);
  // Undo can take a selected step away; the selection only names what still exists.
  const selection = useMemo<TeamSelection>(() => {
    const edges = new Set([
      ...definition.controlEdges.map((e) => e.id),
      ...definition.capabilityLinks.map((l) => l.id),
    ]);
    return {
      nodes: rawSelection.nodes.filter((id) => nodes.has(id)),
      edge: rawSelection.edge && edges.has(rawSelection.edge) ? rawSelection.edge : null,
    };
  }, [rawSelection, nodes, definition]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [teamOpen, setTeamOpen] = useState(false);
  const [dragging, setDragging] = useState<StepKind | null>(null);
  const [menu, setMenu] = useState<{ open: boolean; at: Placement | null }>({
    open: false,
    at: null,
  });

  const select = useCallback((next: TeamSelection) => {
    setSelection(next);
    if (next.nodes.length || next.edge) setTeamOpen(false);
  }, []);
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const apply = (result: EditResult) => {
    if (!result.ok) return;
    editor.getState().applyDraft(result.draft);
    if (result.nodeId) select({ nodes: [result.nodeId], edge: null });
  };

  /** Where a new step goes when nothing else says: after, into or on what is selected. */
  const placement = (): Placement => {
    if (selection.edge && definition.controlEdges.some((e) => e.id === selection.edge))
      return { kind: 'edge', edgeId: selection.edge };
    const only = selection.nodes.length === 1 ? nodes.get(selection.nodes[0] as string) : undefined;
    if (only && isBox(only) && !(only.type === 'team' && only.source.kind === 'reference'))
      return { kind: 'into', boxId: only.id };
    if (only && primaryOut(only) && !(only.type === 'agent' && only.invocation === 'callable'))
      return { kind: 'after', nodeId: only.id };
    return { kind: 'empty' };
  };
  const placeName = (at: Placement) => {
    switch (at.kind) {
      case 'after':
        return t('addAfter', { name: nodes.get(at.nodeId)?.label ?? at.nodeId });
      case 'into':
        return t('addInto', { name: nodes.get(at.boxId)?.label ?? at.boxId });
      case 'edge':
        return t('addOnEdge');
      case 'empty':
        return undefined;
    }
  };
  const canPlace = useCallback(
    (kind: StepKind, at: Placement) => {
      const result = placeStep(editor.getState().draft, kind, at);
      return result.ok ? ({ ok: true } as const) : result;
    },
    [editor],
  );
  const canConnect = useCallback(
    (request: PortRequest) => checkPorts(editor.getState().draft, request),
    [editor],
  );

  // Flow order for the outline: the canvas reads left to right, then top to bottom.
  const order = useMemo(() => {
    const items = [...layoutTeam(definition).items.values()].sort(
      (a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y,
    );
    return new Map(items.map((item, index) => [item.id, index]));
  }, [definition]);

  const remove = (ids: string[]) => {
    editor.getState().applyDraft(removeItems(editor.getState().draft, ids));
    select(NONE);
  };

  // ── command menu ──────────────────────────────────────────────────────────
  const at = menu.at ?? placement();
  const commands: CommandMenuItemData[] = [];
  for (const kind of ADDABLE) {
    const result = placeStep(draft, kind, at);
    const Icon = KIND_ICON[kind];
    commands.push({
      value: `add:${kind}`,
      label: t('addKind', { kind: t(`kinds.${kind}`) }),
      description: result.ok
        ? (placeName(at) ?? t(`kindDescriptions.${kind}`))
        : t(`rejected.${result.reason}`),
      icon: Icon,
      group: t('groups.add'),
      disabled: !result.ok,
      keywords: [kind, t(`kinds.${kind}`)],
      onSelect: () => apply(result),
    });
  }
  if (selection.nodes.length) {
    for (const kind of ['loop', 'team'] as const) {
      const result = wrapIn(draft, selection.nodes, kind);
      commands.push({
        value: `wrap:${kind}`,
        label: t(kind === 'loop' ? 'wrapLoop' : 'wrapTeam'),
        icon: kind === 'loop' ? Repeat2 : Users,
        group: t('groups.structure'),
        disabled: !result.ok,
        ...(result.ok ? {} : { description: t(`rejected.${result.reason}`) }),
        onSelect: () => apply(result),
      });
    }
    const parents = new Set(selection.nodes.map((id) => nodes.get(id)?.parentId ?? null));
    if (selection.nodes.length === 1 && !parents.has(null))
      commands.push({
        value: 'move:out',
        label: t('moveOut'),
        icon: Boxes,
        group: t('groups.structure'),
        onSelect: () => apply(setParent(draft, selection.nodes[0] as string, null)),
      });
  }
  if (selection.nodes.length || selection.edge)
    commands.push({
      value: 'delete',
      label:
        selection.nodes.length > 1
          ? t('deleteCount', { count: selection.nodes.length })
          : t('delete'),
      icon: Trash2,
      group: t('groups.structure'),
      shortcut: 'backspace',
      onSelect: () => remove(selection.edge ? [selection.edge] : selection.nodes),
    });
  const boxIds = definition.nodes.filter(isBox).map((n) => n.id);
  if (boxIds.length)
    commands.push(
      {
        value: 'collapse:all',
        label: t('collapseAll'),
        icon: Minimize2,
        group: t('groups.view'),
        onSelect: () => setCollapsed(new Set(boxIds)),
      },
      {
        value: 'expand:all',
        label: t('expandAll'),
        icon: Maximize2,
        group: t('groups.view'),
        onSelect: () => setCollapsed(new Set()),
      },
    );
  commands.push(
    {
      value: 'undo',
      label: t('undo'),
      icon: Undo2,
      group: t('groups.edit'),
      shortcut: 'mod+z',
      disabled: !canUndo,
      onSelect: () => editor.getState().undo(),
    },
    {
      value: 'redo',
      label: t('redo'),
      icon: Redo2,
      group: t('groups.edit'),
      shortcut: 'mod+shift+z',
      disabled: !canRedo,
      onSelect: () => editor.getState().redo(),
    },
  );
  const openMenu = (where: Placement | null) => setMenu({ open: true, at: where });

  // ⌘K belongs to the editor while focus is inside it; elsewhere it is the app's palette.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.nativeEvent.isComposing) return;
    const key = event.key.toLowerCase();
    if (key === 'k') {
      event.preventDefault();
      event.stopPropagation();
      setMenu((current) => ({ open: !current.open, at: null }));
      return;
    }
    if ((event.target as Element).closest('input, textarea, [contenteditable]')) return;
    if (key === 'z' || key === 'y') {
      event.preventDefault();
      if (key === 'y' || event.shiftKey) editor.getState().redo();
      else editor.getState().undo();
    }
  };

  const sheetOpen = teamOpen || selection.nodes.length > 0 || selection.edge !== null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: catches the editor's shortcuts from any control inside it.
    <div className="grid h-full min-h-0 grid-cols-[272px_minmax(0,1fr)]" onKeyDown={onKeyDown}>
      <StructureTree
        definition={definition}
        diagnostics={diagnostics}
        order={order}
        selection={selection}
        onSelect={select}
        collapsed={collapsed}
        onToggle={toggle}
        canMove={(nodeId, parentId) => setParent(draft, nodeId, parentId).ok}
        onMove={(nodeId, parentId) => apply(setParent(draft, nodeId, parentId))}
        onAdd={() => openMenu(null)}
        onTeamSettings={() => {
          setTeamOpen((open) => !open);
          setSelection(NONE);
        }}
        onCommands={() => openMenu(null)}
        teamSettingsOpen={teamOpen}
      />
      <div className="relative min-h-0">
        <TeamGraphCanvas
          definition={definition}
          diagnostics={diagnostics}
          selection={selection}
          onSelect={select}
          collapsed={collapsed}
          onToggle={toggle}
          dragging={dragging}
          canPlace={canPlace}
          onPlace={(kind, where) => apply(placeStep(editor.getState().draft, kind, where))}
          onRequestAdd={openMenu}
          canConnect={canConnect}
          onConnect={(request) => apply(connectPorts(editor.getState().draft, request))}
          onDelete={remove}
          insetRight={sheetOpen ? 368 : 0}
        />
        <div
          role="toolbar"
          aria-label={t('palette')}
          className="absolute top-3 left-3 flex gap-0.5 rounded-[12px] border border-border bg-background p-1 shadow-sm"
        >
          {ADDABLE.map((kind) => {
            const Icon = KIND_ICON[kind];
            return (
              <Button
                key={kind}
                variant="ghost"
                size="icon-compact"
                draggable
                aria-label={t('addKind', { kind: t(`kinds.${kind}`) })}
                title={`${t(`kinds.${kind}`)} — ${t(`kindDescriptions.${kind}`)}`}
                onDragStart={(event) => {
                  event.dataTransfer.setData(STEP_DRAG_TYPE, kind);
                  event.dataTransfer.effectAllowed = 'copy';
                  setDragging(kind);
                }}
                onDragEnd={() => setDragging(null)}
                onClick={() => apply(placeStep(draft, kind, placement()))}
              >
                <Icon />
              </Button>
            );
          })}
        </div>
        <AnimatePresence>
          {sheetOpen ? (
            <motion.div
              key="sheet"
              className="pointer-events-none absolute top-3 right-3 bottom-3"
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { opacity: 0, x: 24, transition: spring.slow.exit }
              }
              transition={reduced ? { duration: 0 } : spring.slow}
            >
              <InspectorSheet
                editor={editor}
                diagnostics={diagnostics}
                selection={selection}
                team={teamOpen}
                profiles={profiles}
                onSelect={select}
                onClose={() => {
                  setTeamOpen(false);
                  setSelection(NONE);
                }}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <CommandMenuDialog
        open={menu.open}
        onOpenChange={(open) => setMenu((current) => ({ ...current, open }))}
        shortcut={null}
        title={t('commandTitle')}
        description={t('commandDescription')}
      >
        <CommandMenu items={commands} onSelect={() => setMenu({ open: false, at: null })}>
          <CommandMenuInput placeholder={t('commandPlaceholder')} />
          <CommandMenuList>
            <CommandMenuEmpty>{t('commandEmpty')}</CommandMenuEmpty>
          </CommandMenuList>
        </CommandMenu>
      </CommandMenuDialog>
    </div>
  );
}
