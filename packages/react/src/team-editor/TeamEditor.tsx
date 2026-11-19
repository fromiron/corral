import {
  type AgentRole,
  type CorralDefinition,
  type HarnessBindingRef,
  isWorkAgent,
} from '@corral/contracts';
import {
  type Diagnostic,
  isBox,
  outputSources,
  ROLE_PRESET_IDS,
  type RolePresetId,
  type RunStats,
  roleFromPreset,
} from '@corral/core';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  Button,
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuInput,
  type CommandMenuItemData,
  CommandMenuList,
} from '../design-kit/index.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { spring } from '../design-kit/lib/springs.ts';
import { compileDraft } from '../editor/model.ts';
import type { EditorStore } from '../editor/store.ts';
import {
  Boxes,
  Copy,
  GitMerge,
  Maximize2,
  Minimize2,
  Redo2,
  Repeat2,
  ShieldCheck,
  Split,
  Trash2,
  Undo2,
  UserCheck,
  Users,
} from '../ui/icons.ts';
import {
  applyPattern,
  checkPorts,
  connectPorts,
  type EditResult,
  importableRoles,
  importRole,
  type Pattern,
  type Placement,
  type PortRequest,
  placeStep,
  primaryOut,
  removeItems,
  replaceOutputSource,
  type StepKind,
  setParent,
  type TeamReference,
  wrapIn,
} from './commands.ts';
import { InspectorSheet, PATTERNS, type SheetView } from './InspectorSheet.tsx';
import { ADDABLE, KIND_ICON } from './kinds.ts';
import { layoutTeam } from './layout.ts';
import type {
  ImageProfileChoice,
  LoopSettings,
  ProfileOption,
  RoleSettings,
} from './NodeSettings.tsx';
import { PlacementDialog } from './PlacementDialog.tsx';
import { type PlacementPrompt, placementDiff } from './placement-preview.ts';
import { RunStatsFigures } from './RunStatsFigures.tsx';
import { statFigures } from './runStats.ts';
import { StructureTree } from './StructureTree.tsx';
import {
  type ResultOffer,
  STEP_DRAG_TYPE,
  TeamGraphCanvas,
  type TeamSelection,
} from './TeamGraphCanvas.tsx';
import { type ReadHarnessAsk, useOutriderTargets } from './useOutriderTargets.ts';

// The team editor (docs/specs/features/team-graph.md): the structure outline, the auto-laid-out
// canvas, a floating settings sheet and a command menu, all editing one draft in the editor
// store, so undo, redo and the unsaved state are shared with every other view of the team.

export interface TeamEditorNavigation {
  showProblems(): void;
  showNode(id: string): void;
  editBrief(): void;
}

export interface TeamEditorProps {
  ref?: Ref<TeamEditorNavigation>;
  diagnostics?: readonly Diagnostic[];
  validationStatus?: string | undefined;
  editor: EditorStore;
  profiles?: ProfileOption[] | null;
  /** Saved image profiles. Null until the host knows the list; a role's current id is kept. */
  imageProfiles?: readonly ImageProfileChoice[] | null;
  /** Extra role settings the host adds to an agent's sheet, such as its Skills. */
  roleSettings?: RoleSettings | undefined;
  /** Extra loop settings the host adds to a Loop's sheet. */
  loopSettings?: LoopSettings | undefined;
  /** The other saved teams of the project, each at its latest saved revision. */
  teams?: readonly TeamReference[];
  /** The saved definition a reference Team points at, once the host has loaded it. */
  resolveTeam?: ((corralId: string, definitionRevision: number) => unknown) | undefined;
  /** Whether a work style a copied role names resolves here; without it none does. */
  resolvesHarness?: ((ref: HarnessBindingRef) => boolean) | undefined;
  /** Reads the effective ask permission at this project's pinned work style revision. */
  readHarnessAsk?: ReadHarnessAsk | undefined;
  onOpenTeam?: ((corralId: string) => void) | undefined;
  /** Run stats of the saved revision, laid over the canvas while the host shows them. */
  runStats?: { stats: RunStats; definition: CorralDefinition } | null | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  /**
   * One column, for a host that finds the editor narrower than TEAM_EDITOR_BESIDE_MIN: the
   * outline, the palette, the canvas and the settings one under another, scrolling inside the
   * editor (docs/specs/features/canvas.md 1). Changing it keeps the selection and the focus.
   */
  stacked?: boolean;
}

/**
 * The narrowest the editor lays out beside: the 272px outline, the 344px sheet with its 12px
 * margins either side and a canvas of at least 320px uncovered.
 */
export const TEAM_EDITOR_BESIDE_MIN = 272 + 320 + 12 + 344 + 12;

const NONE: TeamSelection = { nodes: [], edge: null };
const NO_TEAMS: readonly TeamReference[] = [];
const PATTERN_ICON: Record<Pattern, typeof Split> = {
  reviewLoop: UserCheck,
  checkLoop: ShieldCheck,
  parallel: Split,
};

export function TeamEditor({
  ref,
  diagnostics: sharedDiagnostics,
  validationStatus,
  editor,
  profiles = null,
  imageProfiles = null,
  roleSettings,
  loopSettings,
  teams = NO_TEAMS,
  resolveTeam,
  resolvesHarness,
  readHarnessAsk,
  onOpenTeam,
  runStats = null,
  onOpenRun,
  stacked = false,
}: TeamEditorProps) {
  const t = useTranslations('TeamEditor');
  const presetText = useTranslations('TeamTemplates.presets');
  const reduced = useReducedMotion() ?? false;
  const draft = useStore(editor, (s) => s.draft);
  const canUndo = useStore(editor, (s) => s.canUndo);
  const canRedo = useStore(editor, (s) => s.canRedo);
  const { definition } = draft;
  const nodes = useMemo(() => new Map(definition.nodes.map((n) => [n.id, n])), [definition]);
  // Once the host knows the installed model profiles, a role naming another one is a problem.
  // With none installed every role would be one, and the team is not where that is fixed.
  const knownModelProfiles = useMemo(
    () => (profiles?.length ? profiles.map((p) => p.profileId) : undefined),
    [profiles],
  );
  const diagnostics = useMemo(
    () =>
      sharedDiagnostics ??
      compileDraft(draft, {
        ...(resolveTeam ? { resolveTeam } : {}),
        ...(knownModelProfiles ? { knownModelProfiles } : {}),
      }).diagnostics,
    [sharedDiagnostics, draft, resolveTeam, knownModelProfiles],
  );
  // The role presets in the screen language.
  const presets = useMemo(
    () =>
      ROLE_PRESET_IDS.map((id: RolePresetId) =>
        roleFromPreset(id, id, { name: presetText(`${id}.name`), duty: presetText(`${id}.duty`) }),
      ),
    [presetText],
  );

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
  // The sheet shows the selection unless the team's settings or the problem list is asked for.
  const [view, setView] = useState<Exclude<SheetView, 'selection'> | null>(null);
  // A settings sheet may still be animating out when reopened; each visit starts a fresh form.
  const [outriderFormKey, setOutriderFormKey] = useState(0);
  const outriderTargets = useOutriderTargets(
    definition,
    Boolean(definition.sharedOutrider) || view === 'sharedOutrider',
    resolveTeam,
    readHarnessAsk,
  );
  const [prompt, setPrompt] = useState<PlacementPrompt | null>(null);
  const [placementError, setPlacementError] = useState('');
  const [paletteKind, setPaletteKind] = useState<StepKind | null>(null);
  const [dragging, setDragging] = useState<StepKind | null>(null);
  // The command menu, or the roles it copies from.
  const [menu, setMenu] = useState<{ open: boolean; at: Placement | null; roles: boolean }>({
    open: false,
    at: null,
    roles: false,
  });
  // Said once, right after the import that left a work style out, until the next edit or
  // selection.
  const [dropped, setDropped] = useState<typeof draft | null>(null);
  const [inserted, setInserted] = useState<{ sourceId: string; outputId: string } | null>(null);
  useEffect(() => {
    if (dropped && dropped !== draft) setDropped(null);
  }, [dropped, draft]);

  const [settingsDismissed, setSettingsDismissed] = useState(false);
  const settingsOrigin = useRef<{ id: string; scrollTop: number } | null>(null);
  const select = useCallback((next: TeamSelection) => {
    setPlacementError('');
    settingsOrigin.current = null;
    setSettingsDismissed(false);
    setSelection(next);
    setDropped(null);
    setInserted(null);
    if (next.nodes.length || next.edge) setView(null);
  }, []);
  // Another view, such as an agent import, can ask for a step to be selected.
  const requested = useStore(editor, (s) => s.selectedNodeId);
  useEffect(() => {
    if (!requested) return;
    select({ nodes: [requested], edge: null });
    editor.getState().select(null);
  }, [requested, editor, select]);
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const apply = (result: EditResult) => {
    if (!result.ok) {
      setPlacementError(t(`rejected.${result.reason}`));
      return;
    }
    setPlacementError('');
    const before = editor.getState().draft;
    editor.getState().applyDraft(result.draft);
    if (!result.nodeId) return;
    select({ nodes: [result.nodeId], edge: null });
    const sourceId = result.nodeId;
    if (before.definition.nodes.some((node) => node.id === sourceId)) return;
    const after = result.draft.definition;
    const outgoing = after.controlEdges.filter((edge) => edge.source === sourceId);
    const target = after.nodes.find((node) => node.id === outgoing[0]?.target);
    if (
      outgoing.length === 1 &&
      target?.type === 'output' &&
      target.inputBindings.length === 1 &&
      target.inputBindings[0]?.kind === 'task_output' &&
      target.inputBindings[0].sourceNodeId !== sourceId &&
      before.definition.controlEdges.some(
        (edge) =>
          edge.target === target.id && !after.controlEdges.some((next) => next.id === edge.id),
      ) &&
      outputSources(after, target.id).some((node) => node.id === sourceId)
    ) {
      setInserted({ sourceId, outputId: target.id });
    }
  };
  const copyRole = (role: AgentRole, at: Placement) => {
    const result = importRole(editor.getState().draft, role, selection.nodes, at, {
      resolvesHarness,
    });
    apply(result);
    setDropped(result.ok && result.droppedHarness ? result.draft : null);
  };

  /**
   * Where a new step goes when nothing else says: after, into or on what is selected. An advisor
   * is never put into the flow: it watches the selected agent, a callable one too, or nobody.
   */
  const placement = (kind?: StepKind): Placement => {
    const only = selection.nodes.length === 1 ? nodes.get(selection.nodes[0] as string) : undefined;
    if (kind === 'observer')
      return isWorkAgent(only) ? { kind: 'after', nodeId: only.id } : { kind: 'empty' };
    if (selection.edge && definition.controlEdges.some((e) => e.id === selection.edge))
      return { kind: 'edge', edgeId: selection.edge };
    if (only && isBox(only) && !(only.type === 'team' && only.source.kind === 'reference'))
      return { kind: 'into', boxId: only.id };
    if (only && primaryOut(only) && !(only.type === 'agent' && only.invocation === 'callable'))
      return { kind: 'after', nodeId: only.id };
    return { kind: 'empty' };
  };
  const selectedOutput = (kind: StepKind, explicit?: Placement) => {
    if (kind === 'observer' || explicit || selection.nodes.length !== 1) return undefined;
    const selected = nodes.get(selection.nodes[0] as string);
    return selected?.type === 'output' ? selected : undefined;
  };
  const placeName = (at: Placement, kind?: StepKind): string => {
    if (kind === 'observer' && at.kind === 'after' && isWorkAgent(nodes.get(at.nodeId)))
      return t('addWatching', { name: nodes.get(at.nodeId)?.label ?? at.nodeId });
    if (kind === 'observer') return t('placement.standalone');
    switch (at.kind) {
      case 'after':
        return t('placement.after', { name: nodes.get(at.nodeId)?.label ?? at.nodeId });
      case 'into':
        return t('placement.inside', { name: nodes.get(at.boxId)?.label ?? at.boxId });
      case 'edge': {
        const edge = definition.controlEdges.find((e) => e.id === at.edgeId);
        return edge
          ? t('placement.between', {
              source: nodes.get(edge.source)?.label ?? edge.source,
              target: nodes.get(edge.target)?.label ?? edge.target,
            })
          : t('rejected.unknownNode');
      }
      case 'empty':
        return t('placement.standalone');
    }
  };
  const requestStep = (kind: StepKind, where?: Placement, reference?: TeamReference) => {
    const base = editor.getState().draft;
    const output = selectedOutput(kind, where);
    setPlacementError('');
    if (output) {
      setPrompt({
        kind: 'output',
        base,
        outputId: output.id,
        step: kind,
        ...(reference ? { reference } : {}),
      });
      return;
    }
    const location = where ?? placement(kind);
    const result = placeStep(base, kind, location, {
      ...(reference ? { reference } : {}),
      decisionLabel: t(`kinds.${kind}`),
    });
    if (result.ok) {
      const diff = placementDiff(base, result);
      if (diff.removed.length > 1 || diff.disconnects) {
        setPrompt({ kind: 'preview', base, result, diff, location: placeName(location, kind) });
        return;
      }
    }
    setPrompt(null);
    apply(result);
  };
  const requestMove = (nodeId: string, parentId: string | null) => {
    const base = editor.getState().draft;
    const result = setParent(base, nodeId, parentId);
    if (result.ok && result.draft !== base) {
      const diff = placementDiff(base, result, true);
      if (diff.boundary.length) {
        const parent = parentId ? nodes.get(parentId) : undefined;
        const from = nodes.get(nodeId)?.parentId;
        const loop = parent?.type === 'loop' || (!!from && nodes.get(from)?.type === 'loop');
        const wrap = loop ? wrapIn(base, [nodeId], 'loop') : null;
        const location = parent ? t('moveInto', { box: parent.label }) : t('moveOut');
        setPrompt({ kind: 'preview', base, result, diff, location, ...(wrap?.ok ? { wrap } : {}) });
        return;
      }
    }
    apply(result);
  };
  const currentPrompt = () => {
    if (prompt?.base === editor.getState().draft) return true;
    setPrompt(null);
    setPlacementError(t('placement.changed'));
    return false;
  };
  const canPlace = (kind: StepKind, where: Placement) => {
    const base = editor.getState().draft;
    const result = placeStep(base, kind, where);
    if (!result.ok) return result;
    const diff = placementDiff(base, result);
    return {
      ok: true as const,
      label: placeName(where, kind),
      affected: diff.removed.map((e) => e.id),
    };
  };
  const canConnect = useCallback(
    (request: PortRequest) => checkPorts(editor.getState().draft, request),
    [editor],
  );

  // Flow order for the outline: the canvas reads left to right, then top to bottom. Advisors
  // are not steps: they come after the flow, in the order of their row.
  const order = useMemo(() => {
    const advisor = new Set(
      definition.nodes
        .filter((n) => n.type === 'agent' && n.invocation === 'observer')
        .map((n) => n.id),
    );
    const items = [...layoutTeam(definition).items.values()].sort(
      (a, b) =>
        Number(advisor.has(a.id)) - Number(advisor.has(b.id)) ||
        a.rect.x - b.rect.x ||
        a.rect.y - b.rect.y,
    );
    return new Map(items.map((item, index) => [item.id, index]));
  }, [definition]);

  const remove = (ids: string[]) => {
    editor.getState().applyDraft(removeItems(editor.getState().draft, ids, outriderTargets));
    select(NONE);
  };

  // ── command menu ──────────────────────────────────────────────────────────
  const at = menu.at ?? placement();
  const commands: CommandMenuItemData[] = [];
  const placementLabels = new Map<StepKind, string>();
  for (const kind of ADDABLE) {
    const where = kind === 'observer' ? (menu.at ?? placement(kind)) : at;
    const result = placeStep(draft, kind, where, { decisionLabel: t(`kinds.${kind}`) });
    const Icon = KIND_ICON[kind];
    const description = result.ok
      ? selectedOutput(kind, menu.at ?? undefined)
        ? t('placement.chooseOutput')
        : placeName(where, kind)
      : t(`rejected.${result.reason}`);
    placementLabels.set(kind, description);
    commands.push({
      value: `add:${kind}`,
      label: t('addKind', { kind: t(`kinds.${kind}`) }),
      description,
      icon: Icon,
      group: t('groups.add'),
      disabled: !result.ok,
      keywords: [kind, t(`kinds.${kind}`)],
      onSelect: () => requestStep(kind, menu.at ?? undefined),
    });
  }
  for (const pattern of PATTERNS) {
    const result = applyPattern(draft, pattern, selection.nodes, at, t('kinds.review'));
    commands.push({
      value: `pattern:${pattern}`,
      label: t(`patterns.${pattern}`),
      description: result.ok
        ? selection.nodes.length
          ? t(`patternDescriptions.${pattern}`)
          : t('withNewAgent')
        : t(`rejected.${result.reason}`),
      icon: PATTERN_ICON[pattern],
      group: t('groups.patterns'),
      disabled: !result.ok,
      keywords: [pattern],
      onSelect: () => apply(result),
    });
  }
  const roleTarget = importRole(draft, presets[0] as AgentRole, selection.nodes, at);
  commands.push({
    value: 'import-role',
    label: t('importRole'),
    ...(roleTarget.ok
      ? selection.nodes.length
        ? {}
        : { description: t('withNewAgent') }
      : { description: t(`rejected.${roleTarget.reason}`) }),
    icon: Copy,
    group: t('groups.patterns'),
    disabled: !roleTarget.ok,
    keywords: ['role', t('importRoleTitle')],
  });
  for (const team of teams) {
    const result = placeStep(draft, 'team', at, { reference: team });
    commands.push({
      value: `reference:${team.corralId}`,
      label: t('addReference', { name: team.name }),
      description: result.ok
        ? t('referenceDescription', { revision: team.definitionRevision })
        : t(`rejected.${result.reason}`),
      icon: GitMerge,
      group: t('savedTeams'),
      disabled: !result.ok,
      keywords: [team.name],
      onSelect: () => requestStep('team', menu.at ?? undefined, team),
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
        onSelect: () => requestMove(selection.nodes[0] as string, null),
      });
    if (selection.nodes.length === 1) {
      const nodeId = selection.nodes[0] as string;
      for (const box of definition.nodes) {
        if (!isBox(box) || box.id === nodes.get(nodeId)?.parentId) continue;
        const result = setParent(draft, nodeId, box.id);

        commands.push({
          value: `move:${box.id}`,
          label: t('moveInto', { box: box.label }),
          icon: Boxes,
          group: t('groups.structure'),
          keywords: [box.label],
          disabled: !result.ok,
          ...(result.ok ? {} : { description: t(`rejected.${result.reason}`) }),
          onSelect: () => requestMove(nodeId, box.id),
        });
      }
    }
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
  const openMenu = (where: Placement | null) => setMenu({ open: true, at: where, roles: false });
  const openRoles = () => setMenu((current) => ({ ...current, open: true, roles: true }));

  // The roles to copy: the presets, then each other saved team's roles.
  const roleItems: CommandMenuItemData[] = [
    ...presets.map((role) => ({
      value: `role:preset:${role.id}`,
      label: role.name,
      icon: Copy,
      group: t('rolePresets'),
      onSelect: () => copyRole(role, at),
    })),
    ...teams.flatMap((team) =>
      importableRoles({ nodes: [], roles: team.roles ?? [] }).map((role) => ({
        value: `role:${team.corralId}:${role.id}`,
        label: role.name,
        icon: Copy,
        group: team.name,
        keywords: [team.name],
        onSelect: () => copyRole(role, at),
      })),
    ),
  ];

  // ⌘K belongs to the editor while focus is inside it; elsewhere it is the app's palette.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.nativeEvent.isComposing || prompt) return;
    const key = event.key.toLowerCase();
    if (key === 'k') {
      event.preventDefault();
      event.stopPropagation();
      setMenu((current) => ({ open: !current.open, at: null, roles: false }));
      return;
    }
    if ((event.target as Element).closest('input, textarea, [contenteditable]')) return;
    if (key === 'z' || key === 'y') {
      event.preventDefault();
      if (key === 'y' || event.shiftKey) editor.getState().redo();
      else editor.getState().undo();
    }
  };

  const annotations = useMemo(() => {
    if (!runStats) return undefined;
    const figures = statFigures(definition, runStats.definition, runStats.stats);
    const shown = new Map<string, ReactNode>();
    for (const [nodeId, list] of figures) {
      const node = definition.nodes.find((candidate) => candidate.id === nodeId);
      if (node)
        shown.set(
          nodeId,
          <RunStatsFigures
            node={node}
            figures={list}
            stats={runStats.stats}
            onOpenRun={onOpenRun}
          />,
        );
    }
    return shown;
  }, [runStats, definition, onOpenRun]);

  const selectedSource = inserted && nodes.get(inserted.sourceId);
  const destination = inserted && nodes.get(inserted.outputId);
  let resultOffer: ResultOffer | undefined;
  if (
    selectedSource &&
    destination?.type === 'output' &&
    destination.inputBindings.length === 1 &&
    destination.inputBindings[0]?.sourceNodeId !== selectedSource.id &&
    selection.nodes.length === 1 &&
    selection.nodes[0] === selectedSource.id &&
    definition.controlEdges.some(
      (edge) => edge.source === selectedSource.id && edge.target === destination.id,
    )
  ) {
    resultOffer = {
      source: selectedSource,
      apply: () => {
        const result = replaceOutputSource(
          editor.getState().draft,
          destination.id,
          0,
          selectedSource.id,
        );
        if (result.ok) editor.getState().applyDraft(result.draft);
      },
      dismiss: () => setInserted(null),
    };
  }

  const sheetOpen =
    view !== null || (!settingsDismissed && selection.nodes.length > 0) || selection.edge !== null;
  const notice = dropped && dropped === draft ? t('workStyleDropped') : null;

  // Stacked, settings opened from outside the canvas (an outline row, the team settings, the
  // problem list) scroll into view at their top once drawn. A card chosen on the canvas leaves
  // the editor where it is: the person is working there, and the settings' head shows below.
  const scroller = useRef<HTMLDivElement>(null);
  const settingsBox = useRef<HTMLDivElement>(null);
  const revealing = useRef(false);
  const focusRequested = useRef<'heading' | 'brief' | null>(null);
  const focusSheet = () => settingsBox.current?.querySelector('h2')?.focus({ preventScroll: true });
  const reveal = () => {
    revealing.current = stacked;
  };
  useImperativeHandle(ref, () => ({
    showProblems() {
      if (view === 'problems') focusSheet();
      else focusRequested.current = 'heading';
      reveal();
      setView('problems');
    },
    editBrief() {
      focusRequested.current = 'brief';
      reveal();
      setView('team');
      setSelection(NONE);
    },
    showNode(id) {
      focusRequested.current = 'heading';
      reveal();
      select({ nodes: [id], edge: null });
    },
  }));
  useEffect(() => {
    const box = settingsBox.current;
    if (!box) return;
    if (focusRequested.current === 'brief')
      box.querySelector<HTMLTextAreaElement>('[data-team-brief]')?.focus({ preventScroll: true });
    else if (focusRequested.current === 'heading') focusSheet();
    focusRequested.current = null;
    if (revealing.current) {
      revealing.current = false;
      if (settingsOrigin.current && view === null)
        box
          .querySelector<HTMLInputElement>('[data-node-settings] input')
          ?.focus({ preventScroll: true });
      scroller.current?.scrollTo?.({
        top: box.offsetTop,
        behavior: reduced ? 'instant' : 'smooth',
      });
    }
  });
  // Both layouts are one tree in one order (outline, palette, canvas, settings) with other
  // classes, so changing layout keeps focus, the canvas view and a field's open undo batch.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: catches the editor's shortcuts from any control inside it.
    <div
      ref={scroller}
      data-layout={stacked ? 'stacked' : 'beside'}
      className={
        stacked
          ? 'relative flex h-full min-h-0 flex-col overflow-y-auto'
          : 'grid h-full min-h-0 grid-cols-[272px_minmax(0,1fr)]'
      }
      onKeyDown={onKeyDown}
    >
      <StructureTree
        stacked={stacked}
        definition={definition}
        diagnostics={diagnostics}
        validationStatus={validationStatus}
        order={order}
        selection={selection}
        onSelect={(next) => {
          select(next);
          if (next.nodes.length) reveal();
        }}
        collapsed={collapsed}
        onToggle={toggle}
        onMove={requestMove}
        onAdd={() => openMenu(null)}
        onTeamSettings={() => {
          if (view !== 'team') reveal();
          setView((current) => (current === 'team' ? null : 'team'));
          setSelection(NONE);
        }}
        onSharedOutrider={() => {
          if (view !== 'sharedOutrider') {
            reveal();
            setOutriderFormKey((key) => key + 1);
          }
          setView((current) => (current === 'sharedOutrider' ? null : 'sharedOutrider'));
          setSelection(NONE);
        }}
        onProblems={() => {
          if (view !== 'problems') reveal();
          setView((current) => (current === 'problems' ? null : 'problems'));
          setSelection(NONE);
        }}
        onCommands={() => openMenu(null)}
        view={view}
      />
      <div
        className={
          stacked ? 'contents' : 'group/graph relative grid min-h-0 grid-rows-[auto_minmax(0,1fr)]'
        }
      >
        <div
          role="toolbar"
          aria-label={t('palette')}
          className="flex min-w-0 shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-card px-3 py-1.5"
        >
          <Button size="compact" variant="secondary" onClick={() => openMenu(null)}>
            {t('placement.search')}
          </Button>
          {ADDABLE.map((kind) => {
            const Icon = KIND_ICON[kind];
            return (
              <Button
                key={kind}
                variant="ghost"
                size="icon-compact"
                draggable
                aria-label={t('addKind', { kind: t(`kinds.${kind}`) })}
                title={`${t(`kinds.${kind}`)} · ${t(`kindDescriptions.${kind}`)} · ${placementLabels.get(kind)}`}
                onFocus={() => setPaletteKind(kind)}
                onBlur={() => setPaletteKind(null)}
                onPointerEnter={() => setPaletteKind(kind)}
                onPointerLeave={() => setPaletteKind(null)}
                onDragStart={(event) => {
                  event.dataTransfer.setData(STEP_DRAG_TYPE, kind);
                  event.dataTransfer.effectAllowed = 'copy';
                  setDragging(kind);
                }}
                onDragEnd={() => setDragging(null)}
                onClick={() => requestStep(kind)}
              >
                <Icon />
              </Button>
            );
          })}
          <span className="flex min-w-0 flex-wrap gap-x-2 px-1 text-caption text-muted-foreground">
            {paletteKind ? (
              <span
                className="text-foreground"
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {t(`kinds.${paletteKind}`)}
              </span>
            ) : null}
            <span>{placementLabels.get(paletteKind ?? 'agent')}</span>
          </span>
          {placementError ? (
            <span role="status" className="px-1 text-body text-destructive">
              {placementError}
            </span>
          ) : null}
        </div>
        {/* Stacked, the canvas takes 60% of the editor's height and at least 400px, three rows
            of cards at full size, but always 6rem less than the editor: it keeps touch for
            panning, so the editor must show something to scroll by. A plain wheel over it
            scrolls the editor; Ctrl or ⌘ with it, or a pinch, zooms. */}
        <div
          className={
            stacked
              ? 'relative isolate h-[60%] min-h-[min(400px,calc(100%_-_6rem))] shrink-0'
              : 'relative isolate col-start-1 row-start-2 min-h-0'
          }
        >
          <TeamGraphCanvas
            definition={definition}
            diagnostics={diagnostics}
            selection={selection}
            onSelect={select}
            onOpenSettings={
              stacked
                ? (id) => {
                    select({ nodes: [id], edge: null });
                    settingsOrigin.current = { id, scrollTop: scroller.current?.scrollTop ?? 0 };
                    reveal();
                  }
                : undefined
            }
            collapsed={collapsed}
            onToggle={toggle}
            dragging={dragging}
            canPlace={canPlace}
            onPlace={requestStep}
            highlightedEdges={
              prompt?.kind === 'preview'
                ? [...prompt.diff.removed, ...prompt.diff.boundary].map((e) => e.id)
                : undefined
            }
            onRequestAdd={openMenu}
            canConnect={canConnect}
            onConnect={(request) => apply(connectPorts(editor.getState().draft, request))}
            onDelete={remove}
            insetRight={sheetOpen && !stacked ? 368 : 0}
            annotations={annotations}
            resultOffer={resultOffer}
            wheelZoom={stacked ? 'withModifier' : 'always'}
          />
        </div>
        <AnimatePresence>
          {sheetOpen ? (
            <motion.div
              key="sheet"
              ref={settingsBox}
              className={
                stacked
                  ? undefined
                  : 'pointer-events-none relative col-start-1 row-start-2 m-3 min-h-0 justify-self-end group-has-[[data-connecting]]/graph:hidden'
              }
              // Beside, it slides in from the side it floats on; stacked, it rises into its row.
              initial={
                reduced ? { opacity: 0 } : stacked ? { opacity: 0, y: 8 } : { opacity: 0, x: 24 }
              }
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: 0 } }
                  : stacked
                    ? { opacity: 0, y: 8, transition: spring.slow.exit }
                    : { opacity: 0, x: 24, transition: spring.slow.exit }
              }
              transition={reduced ? { duration: 0 } : spring.slow}
            >
              <InspectorSheet
                key={view === 'sharedOutrider' ? outriderFormKey : 'inspector'}
                stacked={stacked}
                editor={editor}
                diagnostics={diagnostics}
                validationStatus={validationStatus}
                selection={selection}
                view={view ?? 'selection'}
                onFixFlow={() => openMenu(placement())}
                onAddFirstAgent={() =>
                  apply(placeStep(editor.getState().draft, 'agent', { kind: 'empty' }))
                }
                profiles={profiles}
                imageProfiles={imageProfiles}
                roleSettings={roleSettings}
                loopSettings={loopSettings}
                teams={teams}
                outriderTargets={outriderTargets}
                onOpenTeam={onOpenTeam}
                onImportRole={openRoles}
                notice={notice}
                onTeamSettings={() => {
                  reveal();
                  setView('team');
                }}
                onSelect={(next) => {
                  // A step chosen from the problem list opens its settings from outside the canvas.
                  if (view === 'problems' && (next.nodes.length || next.edge)) reveal();
                  select(next);
                }}
                onClose={() => {
                  setView(null);
                  const origin = settingsOrigin.current;
                  settingsOrigin.current = null;
                  if (origin && stacked && selection.nodes[0] === origin.id && view === null) {
                    setSettingsDismissed(true);
                    scroller.current
                      ?.querySelector<HTMLElement>(
                        `[data-team-canvas] [data-node="${CSS.escape(origin.id)}"]`,
                      )
                      ?.focus({ preventScroll: true });
                    scroller.current?.scrollTo?.({ top: origin.scrollTop, behavior: 'instant' });
                  } else setSelection(NONE);
                }}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
        {/* Read out once; the sheet of the agent it happened to shows it. */}
        <p role="status" className="sr-only">
          {notice}
        </p>
      </div>
      {prompt ? (
        <PlacementDialog
          prompt={prompt}
          returnFocus={() =>
            scroller.current?.querySelector<HTMLElement>(
              '[data-team-canvas] [data-node][aria-pressed="true"]',
            ) ?? true
          }
          cancel={() => setPrompt(null)}
          choose={(where) => {
            if (prompt.kind === 'output' && currentPrompt())
              requestStep(prompt.step, where, prompt.reference);
          }}
          confirm={() => {
            if (prompt.kind === 'preview' && currentPrompt()) {
              setPrompt(null);
              apply(prompt.result);
            }
          }}
          previewWrap={() => {
            if (prompt.kind === 'preview' && prompt.wrap && currentPrompt())
              setPrompt({
                kind: 'preview',
                base: prompt.base,
                result: prompt.wrap,
                diff: placementDiff(prompt.base, prompt.wrap),
                location: prompt.location,
                wrapping: true,
              });
          }}
        />
      ) : null}
      <CommandMenuDialog
        open={menu.open}
        onOpenChange={(open) => setMenu((current) => ({ ...current, open }))}
        shortcut={null}
        title={menu.roles ? t('importRoleTitle') : t('commandTitle')}
        description={menu.roles ? t('roleSearch') : t('commandDescription')}
      >
        <EditorMenu
          items={menu.roles ? roleItems : commands}
          roles={menu.roles}
          placeholder={menu.roles ? t('roleSearch') : t('commandPlaceholder')}
          empty={t('commandEmpty')}
          onSelect={(item) => {
            // Import role opens the roles in the same menu; anything else closes it.
            if (item.value === 'import-role') openRoles();
            else setMenu({ open: false, at: null, roles: false });
          }}
        />
      </CommandMenuDialog>
    </div>
  );
}

/** The editor's command menu. Its field starts empty again when it turns to the roles. */
function EditorMenu({
  items,
  roles,
  placeholder,
  empty,
  onSelect,
}: {
  items: CommandMenuItemData[];
  roles: boolean;
  placeholder: string;
  empty: string;
  onSelect: (item: CommandMenuItemData) => void;
}) {
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(roles);
  if (shown !== roles) {
    setShown(roles);
    setQuery('');
  }
  return (
    <CommandMenu
      items={items}
      query={query}
      onQueryChange={setQuery}
      closeOnSelect={false}
      onSelect={onSelect}
    >
      <CommandMenuInput placeholder={placeholder} />
      <CommandMenuList>
        <CommandMenuEmpty>{empty}</CommandMenuEmpty>
      </CommandMenuList>
    </CommandMenu>
  );
}
