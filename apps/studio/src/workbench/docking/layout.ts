import { canonicalJson, WorkspaceTarget } from '@corral/contracts';
import type { SerializedDockview } from 'dockview-react';
import { z } from 'zod';

import { DOCK_VIEWS, type DockView } from '../panels/registry.ts';

const CONTEXT_VIEWS = DOCK_VIEWS;
export type DockContextView = DockView;
export type DockPreset = 'conversation' | 'implementation' | 'review';
export const MAX_DOCUMENTS = 20;

const normalizedPath = (path: string) => {
  const parts = path.split('/');
  return (
    !path.includes('\\') &&
    !path.includes('\0') &&
    parts.every(
      (part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
    ) &&
    parts[0]?.toLowerCase() !== '.corral'
  );
};
const DocumentDescriptor = z.object({
  kind: z.literal('document'),
  target: WorkspaceTarget,
  path: z.string().min(1).max(4096).refine(normalizedPath),
  viewId: z.string().min(1).max(512),
});
export type DockDocumentDescriptor = z.infer<typeof DocumentDescriptor>;
const documentViewKey = (descriptor: DockDocumentDescriptor) =>
  canonicalJson([descriptor.target, descriptor.path, descriptor.viewId]);
export type DockPanelDescriptor =
  | { kind: 'context'; view: DockContextView }
  | DockDocumentDescriptor
  | { kind: 'unknown'; label: string };
export interface DockPanel {
  id: string;
  descriptor: DockPanelDescriptor;
}
export const DEFAULT_PANELS: DockPanel[] = CONTEXT_VIEWS.map((view) => ({
  id: `context:${view}`,
  descriptor: { kind: 'context', view },
}));
const unavailable = (): DockPanelDescriptor => ({ kind: 'unknown', label: 'Unavailable panel' });
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const panelId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');

/**
 * A document tab names its file; when another open document shares that name it adds the
 * folder, and when the same path is open from another conversation, which one (#78 IA-05).
 */
export function documentTabLabel(
  descriptor: DockDocumentDescriptor,
  open: readonly DockPanelDescriptor[],
  currentSessionId: string,
  otherSession: (shortId: string) => string,
): string {
  const name = (path: string) => path.split('/').at(-1) ?? path;
  const base = name(descriptor.path);
  const others = open.filter(
    (other): other is DockDocumentDescriptor =>
      other.kind === 'document' && other.viewId !== descriptor.viewId && name(other.path) === base,
  );
  if (!others.length) return base;
  const folder = descriptor.path.split('/').slice(0, -1).join('/');
  const samePath = others.some((other) => other.path === descriptor.path);
  const owner =
    samePath && descriptor.target.sessionId !== currentSessionId
      ? ` · ${otherSession(descriptor.target.sessionId.slice(-6))}`
      : '';
  return `${base}${folder && !samePath ? ` — ${folder}` : ''}${owner}`;
}

export function layoutStorageKey(hostId: string | undefined, projectId: string): string | null {
  return hostId ? `corral:docking:v1:${JSON.stringify([hostId, projectId])}` : null;
}

/** Admission never evicts a view or silently replaces its document identity. */
export function addDocumentPanel(panels: DockPanel[], panel: DockPanel): DockPanel[] | null {
  if (
    panel.descriptor.kind !== 'document' ||
    !DocumentDescriptor.safeParse(panel.descriptor).success
  )
    return null;
  const existing = panels.find((candidate) => candidate.id === panel.id);
  if (existing)
    return canonicalJson(existing.descriptor) === canonicalJson(panel.descriptor) ? panels : null;
  const viewKey = documentViewKey(panel.descriptor);
  if (
    panels.some(
      (candidate) =>
        candidate.descriptor.kind === 'document' &&
        documentViewKey(candidate.descriptor) === viewKey,
    )
  )
    return null;
  return panels.filter((candidate) => candidate.descriptor.kind === 'document').length <
    MAX_DOCUMENTS
    ? [...panels, panel]
    : null;
}

function serializedPanels(panels: DockPanel[]): SerializedDockview['panels'] {
  return Object.fromEntries(
    panels.map(({ id, descriptor }) => [
      id,
      {
        id,
        contentComponent: 'workbench',
        renderer: 'always',
        title:
          descriptor.kind === 'document'
            ? descriptor.path.split('/').at(-1)
            : descriptor.kind === 'context'
              ? descriptor.view
              : 'Unavailable panel',
        params: { descriptor },
      },
    ]),
  );
}

type GridNode = SerializedDockview['grid']['root'];
const leaf = (id: string, views: string[], size: number): GridNode => ({
  type: 'leaf',
  size,
  data: { id, views, activeView: views[0] },
});

/** Presets only move existing IDs. Documents and processes remain owned outside this module. */
export function createPresetLayout(
  preset: DockPreset,
  supplied: DockPanel[] = DEFAULT_PANELS,
): SerializedDockview {
  const panels = supplied.length ? supplied : DEFAULT_PANELS;
  if (new Set(panels.map((panel) => panel.id)).size !== panels.length)
    throw new Error('Duplicate dock panel identity');
  if (panels.filter((panel) => panel.descriptor.kind === 'document').length > MAX_DOCUMENTS)
    throw new Error('Document panel limit reached');
  const groups = {
    main1: [] as string[],
    main2: [] as string[],
    aux: [] as string[],
    bottom: [] as string[],
  };
  const hasDocuments = panels.some((panel) => panel.descriptor.kind === 'document');
  for (const { id, descriptor } of panels) {
    if (descriptor.kind === 'document')
      groups[preset === 'implementation' ? 'main1' : 'main2'].push(id);
    else if (
      descriptor.kind === 'context' &&
      ['terminal', 'checks', 'problems', 'tools'].includes(descriptor.view)
    )
      groups.bottom.push(id);
    else if (
      descriptor.kind === 'context' &&
      ((preset === 'review' && descriptor.view === 'changes') ||
        ((preset === 'conversation' || !hasDocuments) && descriptor.view === 'chat'))
    )
      groups.main1.push(id);
    else groups.aux.push(id);
  }
  if (!groups.main1.length && !groups.main2.length && groups.aux.length)
    groups.main1.push(groups.aux.shift() as string);
  const top = (['main1', 'main2', 'aux'] as const).filter((id) => groups[id].length);
  const topHeight = groups.bottom.length ? 580 : 800;
  const columns = top.map((id) => leaf(id, groups[id], 1200 / top.length));
  const root: GridNode = {
    type: 'branch',
    size: 1200,
    data: [
      ...(columns.length
        ? [
            columns.length === 1
              ? ({ ...columns[0], size: topHeight } as GridNode)
              : ({ type: 'branch', size: topHeight, data: columns } as GridNode),
          ]
        : []),
      ...(groups.bottom.length ? [leaf('bottom', groups.bottom, 220)] : []),
    ],
  };
  return {
    grid: {
      root,
      width: 1200,
      height: 800,
      orientation: 'VERTICAL' as SerializedDockview['grid']['orientation'],
    },
    panels: serializedPanels(panels),
    activeGroup: top[0] ?? 'bottom',
  };
}

export interface ParsedLayout {
  layout: SerializedDockview | null;
  panels: DockPanel[];
  recovered: boolean;
}

export function parseLayout(raw: unknown, hostId: string, projectId: string): ParsedLayout {
  if (raw === null || raw === undefined) return { layout: null, panels: [], recovered: false };
  let saved: Record<string, unknown> | null;
  try {
    saved = object(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {
    return { layout: null, panels: [], recovered: true };
  }
  if (!saved || saved.hostId !== hostId || saved.projectId !== projectId)
    return { layout: null, panels: [], recovered: true };
  const source = object(saved.layout);
  const sourcePanels = object(source?.panels);
  if (!source || !sourcePanels) return { layout: null, panels: [], recovered: true };
  let recovered = saved.schemaVersion !== 1;
  let documents = 0;
  const contextViews = new Set<DockContextView>();
  const documentViews = new Set<string>();
  const panels: DockPanel[] = [];
  for (const [id, value] of Object.entries(sourcePanels)) {
    if (!panelId(id)) {
      recovered = true;
      continue;
    }
    const panel = object(value);
    const rawDescriptor = object(object(panel?.params)?.descriptor);
    let descriptor = unavailable();
    if (
      rawDescriptor?.kind === 'context' &&
      CONTEXT_VIEWS.includes(rawDescriptor.view as DockContextView)
    ) {
      const view = rawDescriptor.view as DockContextView;
      if (contextViews.has(view)) recovered = true;
      else {
        descriptor = { kind: 'context', view };
        contextViews.add(view);
      }
    } else if (rawDescriptor?.kind === 'document') {
      const parsed = DocumentDescriptor.safeParse(rawDescriptor);
      if (
        parsed.success &&
        parsed.data.target.hostId === hostId &&
        parsed.data.target.projectId === projectId &&
        !documentViews.has(documentViewKey(parsed.data)) &&
        documents < MAX_DOCUMENTS
      ) {
        descriptor = parsed.data;
        documentViews.add(documentViewKey(parsed.data));
        documents += 1;
      } else recovered = true;
    } else if (rawDescriptor?.kind !== 'unknown') recovered = true;
    if (panel?.id !== id) recovered = true;
    panels.push({ id, descriptor });
  }
  if (!panels.length) return { layout: null, panels, recovered: true };
  const grid = object(source.grid);
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const ids = new Set(panels.map((panel) => panel.id));
  const documentIds = new Set(
    panels.filter((panel) => panel.descriptor.kind === 'document').map((panel) => panel.id),
  );
  const used = new Set<string>();
  const groups = new Set<string>();
  let documentGroups = 0;
  const node = (rawNode: unknown, depth = 0): GridNode | null => {
    const input = object(rawNode);
    if (!input || depth > 8) return null;
    // Dockview's type makes size optional, but its deserializer propagates missing sizes as NaN.
    if (!positive(input.size)) return null;
    const common = {
      size: input.size,
      ...(typeof input.visible === 'boolean' ? { visible: input.visible } : {}),
    };
    if (
      input.type === 'branch' &&
      Array.isArray(input.data) &&
      input.data.length > 0 &&
      input.data.length <= 4
    ) {
      const children = input.data.map((child) => node(child, depth + 1));
      if (children.some((child) => child === null)) return null;
      return { type: 'branch', data: children as GridNode[], ...common };
    }
    const data = object(input.data);
    if (
      input.type !== 'leaf' ||
      !data ||
      !panelId(data.id) ||
      groups.has(data.id) ||
      !Array.isArray(data.views) ||
      !data.views.length
    )
      return null;
    const views: string[] = [];
    for (const view of data.views) {
      if (!panelId(view) || !ids.has(view) || used.has(view)) return null;
      used.add(view);
      views.push(view);
    }
    groups.add(data.id);
    if (views.some((view) => documentIds.has(view))) documentGroups += 1;
    if (groups.size > 4 || documentGroups > 2) return null;
    const activeView =
      typeof data.activeView === 'string' && views.includes(data.activeView)
        ? data.activeView
        : views[0];
    if (data.activeView !== undefined && data.activeView !== activeView) recovered = true;
    return { type: 'leaf', data: { id: data.id, views, activeView }, ...common };
  };
  let root: GridNode | null = null;
  try {
    root = node(grid?.root);
  } catch {
    /* A corrupt grid must not consume document references. */
  }
  const unsupported = ['floatingGroups', 'popoutGroups', 'edgeGroups'].some((key) => {
    const value = source[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
  if (
    saved.schemaVersion !== 1 ||
    unsupported ||
    !grid ||
    !root ||
    root.type !== 'branch' ||
    used.size !== ids.size ||
    !positive(grid.width) ||
    !positive(grid.height) ||
    (grid.orientation !== 'HORIZONTAL' && grid.orientation !== 'VERTICAL')
  )
    return { layout: createPresetLayout('implementation', panels), panels, recovered: true };
  const activeGroup =
    typeof source.activeGroup === 'string' && groups.has(source.activeGroup)
      ? source.activeGroup
      : groups.values().next().value;
  if (source.activeGroup !== undefined && source.activeGroup !== activeGroup) recovered = true;
  return {
    layout: {
      grid: {
        root,
        width: grid.width,
        height: grid.height,
        orientation: grid.orientation as SerializedDockview['grid']['orientation'],
      },
      panels: serializedPanels(panels),
      ...(activeGroup ? { activeGroup } : {}),
    },
    panels,
    recovered,
  };
}

/** Whitelisting serialization prevents renderer params from becoming a second state store. */
export function serializeLayout(
  layout: SerializedDockview,
  hostId: string,
  projectId: string,
): string {
  const saved = parseLayout({ schemaVersion: 1, hostId, projectId, layout }, hostId, projectId);
  return JSON.stringify({ schemaVersion: 1, hostId, projectId, layout: saved.layout });
}
