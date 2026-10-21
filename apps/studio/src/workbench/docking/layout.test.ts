import type { WorkspaceTarget } from '@corral/contracts';
import type { SerializedDockview } from 'dockview-react';
import { expect, it } from 'vitest';
import {
  addDocumentPanel,
  createPresetLayout,
  DEFAULT_PANELS,
  type DockPanel,
  layoutStorageKey,
  MAX_DOCUMENTS,
  parseLayout,
  serializeLayout,
} from './layout.ts';

const target: WorkspaceTarget = {
  hostId: 'host_a',
  projectId: 'project_a',
  bindingId: 'binding_a',
  sessionId: 'session_a',
  copyGeneration: 1,
};
const document = (index: number): DockPanel => ({
  id: `document_${index}`,
  descriptor: {
    kind: 'document',
    target: { ...target, copyGeneration: index + 1 },
    path: 'src/main.ts',
    viewId: `view_${index}`,
  },
});
const envelope = (layout: SerializedDockview) => ({
  schemaVersion: 1,
  hostId: target.hostId,
  projectId: target.projectId,
  layout,
});

function panel(layout: SerializedDockview, id: string) {
  const value = layout.panels[id];
  if (!value) throw new Error(`Missing fixture panel ${id}`);
  return value;
}

it('[TC-WBD-006-H] all presets and reload preserve twenty exact document references and panel IDs', () => {
  const panels = [
    ...DEFAULT_PANELS,
    ...Array.from({ length: MAX_DOCUMENTS }, (_, index) => document(index)),
  ];
  for (const preset of ['conversation', 'implementation', 'review'] as const) {
    const layout = createPresetLayout(preset, panels);
    const restored = parseLayout(
      serializeLayout(layout, target.hostId, target.projectId),
      target.hostId,
      target.projectId,
    );
    expect(restored.recovered).toBe(false);
    expect(restored.panels).toEqual(panels);
    expect(Object.keys(restored.layout?.panels ?? {})).toEqual(panels.map((panel) => panel.id));
    expect(Object.values(layout.panels).every((panel) => panel.renderer === 'always')).toBe(true);
  }
});

it('[TC-WBD-006-N] a twenty-first document or retarget of an existing ID is refused without eviction', () => {
  const panels = Array.from({ length: MAX_DOCUMENTS }, (_, index) => document(index));
  expect(addDocumentPanel(panels, document(MAX_DOCUMENTS))).toBeNull();
  expect(addDocumentPanel(panels, document(0))).toBe(panels);
  expect(addDocumentPanel(panels, { ...document(1), id: 'document_0' })).toBeNull();
  expect(panels).toHaveLength(MAX_DOCUMENTS);
});

it('[TC-WBD-006-F] a broken grid recovers every valid document instead of dropping open references', () => {
  const panels = [...DEFAULT_PANELS, document(0), document(1)];
  const saved = envelope(createPresetLayout('implementation', panels));
  const broken = { ...saved, layout: { ...saved.layout, grid: { root: null } } };
  const restored = parseLayout(broken, target.hostId, target.projectId);
  expect(restored.recovered).toBe(true);
  expect(restored.panels).toEqual(panels);
  expect(restored.layout).not.toBeNull();
  if (!restored.layout) throw new Error('Expected recovered layout');
  expect(
    parseLayout(
      serializeLayout(restored.layout, target.hostId, target.projectId),
      target.hostId,
      target.projectId,
    ).panels,
  ).toEqual(panels);
});

it('[TC-WBD-006-N] unknown and unauthorized document panes become placeholders without retargeting', () => {
  const saved = envelope(
    createPresetLayout('implementation', [...DEFAULT_PANELS, document(0), document(1)]),
  );
  panel(saved.layout, 'document_0').params = {
    descriptor: { ...document(0).descriptor, target: { ...target, hostId: 'another-host' } },
  };
  panel(saved.layout, 'document_1').params = {
    descriptor: { kind: 'removed-plugin', body: 'PRIVATE-TEXT' },
  };
  const restored = parseLayout(saved, target.hostId, target.projectId);
  expect(restored.recovered).toBe(true);
  expect(
    restored.panels
      .filter((panel) => panel.id.startsWith('document_'))
      .map((panel) => panel.descriptor.kind),
  ).toEqual(['unknown', 'unknown']);
  expect(JSON.stringify(restored)).not.toContain('PRIVATE-TEXT');
  expect(parseLayout(saved, 'another-host', target.projectId).panels).toEqual([]);
  expect(layoutStorageKey(target.hostId, target.projectId)).not.toBe(
    layoutStorageKey('another-host', target.projectId),
  );
  expect(layoutStorageKey(undefined, target.projectId)).toBeNull();
});

it('[TC-WBD-006-N] layout persistence strips arbitrary runtime params, components and titles', () => {
  const layout = createPresetLayout('implementation', [...DEFAULT_PANELS, document(0)]);
  const entry = panel(layout, 'document_0');
  entry.params = {
    ...entry.params,
    text: 'PRIVATE-BUFFER',
    token: 'PRIVATE-KEY',
    terminalOutput: 'PRIVATE-OUTPUT',
  };
  entry.title = 'PRIVATE-TITLE';
  entry.contentComponent = 'PRIVATE-COMPONENT';
  const encoded = serializeLayout(layout, target.hostId, target.projectId);
  expect(encoded).not.toContain('PRIVATE-');
  const restored = parseLayout(encoded, target.hostId, target.projectId);
  expect(restored.panels.at(-1)).toEqual(document(0));
  expect(restored.layout?.panels.document_0?.contentComponent).toBe('workbench');
});

it('[TC-WBD-006-F] unsupported floating placement and a third document group fall back without closing documents', () => {
  const panels = [...DEFAULT_PANELS, document(0), document(1), document(2)];
  const layout = createPresetLayout('implementation', panels);
  const input = envelope(layout);
  for (const damage of [
    { ...layout, floatingGroups: [{ data: { id: 'floating', views: ['document_0'] } }] },
    {
      ...layout,
      grid: {
        ...layout.grid,
        root: {
          type: 'branch',
          size: 1200,
          data: [
            ...[0, 1, 2].map((index) => ({
              type: 'leaf',
              size: 200,
              data: { id: `group_${index}`, views: [`document_${index}`] },
            })),
            {
              type: 'leaf',
              size: 200,
              data: { id: 'aux', views: DEFAULT_PANELS.map((entry) => entry.id) },
            },
          ],
        },
      },
    },
  ]) {
    const restored = parseLayout({ ...input, layout: damage }, target.hostId, target.projectId);
    expect(restored.recovered).toBe(true);
    expect(restored.panels).toEqual(panels);
    expect(restored.layout?.floatingGroups).toBeUndefined();
  }
});

it('[TC-WBD-006-F] malformed storage and non-normalized paths are contained to the layout or affected pane', () => {
  expect(parseLayout('{broken', target.hostId, target.projectId)).toEqual({
    layout: null,
    panels: [],
    recovered: true,
  });
  const layout = createPresetLayout('implementation', [document(0)]);
  panel(layout, 'document_0').params = {
    descriptor: { ...document(0).descriptor, path: '../other/file.ts' },
  };
  const restored = parseLayout(envelope(layout), target.hostId, target.projectId);
  expect(restored.panels[0]?.descriptor.kind).toBe('unknown');
  expect(restored.panels[0]?.id).toBe('document_0');
});

it.each(['leaf-root', 'orientation-array', 'missing-size'])(
  '[TC-WBD-006-F] malformed %s falls back before Dockview consumes it',
  (failure) => {
    const layout = createPresetLayout('implementation', [document(0)]);
    const grid =
      failure === 'leaf-root'
        ? {
            ...layout.grid,
            root: { type: 'leaf', size: 800, data: { id: 'main1', views: ['document_0'] } },
          }
        : failure === 'missing-size'
          ? { ...layout.grid, root: { ...layout.grid.root, size: undefined } }
          : { ...layout.grid, orientation: ['VERTICAL'] };
    const restored = parseLayout(
      { ...envelope(layout), layout: { ...layout, grid } },
      target.hostId,
      target.projectId,
    );
    expect(restored.recovered).toBe(true);
    expect(restored.layout?.grid.root.type).toBe('branch');
    expect(restored.panels).toEqual([document(0)]);
  },
);

it('[TC-WBD-006-N] duplicate document view IDs and context roles cannot share one mounted owner', () => {
  const duplicateDocument = { id: 'duplicate_document', descriptor: document(0).descriptor };
  const duplicateTerminal: DockPanel = {
    id: 'duplicate_terminal',
    descriptor: { kind: 'context', view: 'terminal' },
  };
  const layout = createPresetLayout('implementation', [
    ...DEFAULT_PANELS,
    document(0),
    duplicateDocument,
    duplicateTerminal,
  ]);
  const restored = parseLayout(envelope(layout), target.hostId, target.projectId);
  expect(restored.recovered).toBe(true);
  expect(
    restored.panels
      .filter((entry) => entry.id.startsWith('duplicate_'))
      .map((entry) => entry.descriptor.kind),
  ).toEqual(['unknown', 'unknown']);
  expect(addDocumentPanel([document(0)], duplicateDocument)).toBeNull();
  const otherDocument = document(1);
  if (otherDocument.descriptor.kind !== 'document') throw new Error('Expected document fixture');
  otherDocument.descriptor.viewId = 'view_0';
  expect(addDocumentPanel([document(0)], otherDocument)).toEqual([document(0), otherDocument]);
  const differentCopy = parseLayout(
    envelope(createPresetLayout('implementation', [document(0), otherDocument])),
    target.hostId,
    target.projectId,
  );
  expect(differentCopy.panels).toEqual([document(0), otherDocument]);
});
