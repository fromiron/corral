// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type DocumentStore, documentKey } from '../documents/store.ts';
import {
  DockWorkbench,
  type DockWorkbenchHandle,
  type DockWorkbenchProps,
} from './DockWorkbench.tsx';
import { layoutStorageKey } from './layout.ts';

Element.prototype.getAnimations ??= () => [];

vi.mock('use-intl', () => {
  const translate = (key: string) => key;
  return { useTranslations: () => translate };
});
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function fixture(
  props: Partial<
    Pick<DockWorkbenchProps, 'selectedPanel' | 'renderDocument' | 'renderGraph' | 'graphTitle'>
  > = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const key = documentKey(target, 'file.ts');
  const release = vi.fn();
  const closeView = vi.fn(async (_key: string, _view: string, choice?: string) =>
    choice === 'discard' ? 'closed' : 'confirm',
  );
  const owner = Object.assign(
    createStore(() => ({ documents: { [key]: { key, dirty: true } } })),
    { retainView: vi.fn(() => release), closeView },
  ) as unknown as DocumentStore;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const ref = createRef<DockWorkbenchHandle>();
  await act(async () => {
    root.render(
      <DockWorkbench
        ref={ref}
        hostId="host"
        projectId="project"
        sessionId="session"
        documentOwner={owner}
        renderContext={(view) => <span>{view}</span>}
        renderDocument={(descriptor) => <span data-testid="document">{descriptor.path}</span>}
        {...props}
      />,
    );
  });
  return { ref, container, owner, closeView, key };
}

/** Opens the pane actions menu of the group that shows `node`; its rows render in a portal. */
async function paneActions(node: Element | null | undefined) {
  // Rendered panes sit in an overlay; their group is the one holding their tab.
  const id = node?.closest<HTMLElement>('[data-dock-panel-id]')?.dataset.dockPanelId;
  const trigger = document
    .querySelector(`[data-tab-panel-id="${id}"]`)
    ?.closest('.dv-groupview')
    ?.querySelector<HTMLButtonElement>('button[aria-label="paneActions"]');
  expect(trigger).toBeDefined();
  await act(async () => trigger?.click());
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
}
const activePane = (container: HTMLElement) =>
  container.querySelector('.dv-active-group [role="tab"][aria-selected="true"]')?.textContent;

it('[TC-WBD-006-F] [TC-WBD-026-F] leaves a dirty document open until its close decision succeeds', async () => {
  const f = await fixture();
  await act(async () => {
    expect(f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' })).toBe(true);
  });
  const close = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.getAttribute('aria-label')?.startsWith('close: ● file.ts'),
  );
  expect(close).toBeDefined();
  expect(close?.closest('[role="tab"]')).toBeNull();
  await act(async () => close?.click());
  expect(f.closeView).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid="document"]')).not.toBeNull();
  const discard = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'discard',
  );
  expect(discard).toBeDefined();
  await act(async () => discard?.click());
  expect(document.querySelector('[data-testid="document"]')).toBeNull();
});

it.each(['Delete', 'Backspace', 'middle-click'])(
  '[TC-WBD-006-F] %s on a document tab keeps the unsaved-change guard',
  async (key) => {
    const f = await fixture();
    await act(async () => {
      f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' });
    });
    const tab = [...f.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) =>
      node.getAttribute('aria-label')?.includes('file.ts'),
    );
    expect(tab).toBeDefined();
    await act(async () => {
      tab?.focus();
      if (key === 'middle-click') {
        tab
          ?.querySelector('.dv-default-tab')
          ?.dispatchEvent(
            new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }),
          );
      } else {
        tab?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }
    });
    expect(f.closeView).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector('[data-testid="document"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  },
);

it('[TC-WBD-006-N] rejects another host and keeps one document identity on repeated opens', async () => {
  const f = await fixture();
  await act(async () => {
    expect(
      f.ref.current?.openDocument({
        documentKey: f.key,
        target: { ...target, hostId: 'elsewhere' },
        path: 'file.ts',
      }),
    ).toBe(false);
    expect(f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' })).toBe(true);
    expect(f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' })).toBe(true);
  });
  expect(document.querySelectorAll('[data-testid="document"]')).toHaveLength(1);
  expect(f.owner.retainView).toHaveBeenCalledTimes(1);
  expect(f.closeView).not.toHaveBeenCalled();
});

it('[TC-WBD-006-H] moving a document between presets reuses its rendered view and logical ownership', async () => {
  const f = await fixture();
  await act(async () => {
    f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' });
  });
  expect(f.container.querySelector('button[aria-label="openPane"]')).not.toBeNull();
  const documentView = document.querySelector('[data-testid="document"]');
  const rows = await paneActions(documentView);
  const layout = rows.find((row) => row.textContent?.startsWith('preset'));
  expect(layout?.textContent).toContain('conversation');
  await act(async () => layout?.click());
  const implementation = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent?.includes('implementation'),
  );
  expect(implementation).toBeDefined();
  await act(async () => implementation?.click());
  expect(document.querySelector('[data-testid="document"]')).toBe(documentView);
  expect(f.owner.retainView).toHaveBeenCalledTimes(1);
  expect(f.closeView).not.toHaveBeenCalled();
  const split = (await paneActions(documentView)).find((row) =>
    row.textContent?.startsWith('split'),
  );
  await act(async () => split?.click());
  expect(document.querySelectorAll('[data-testid="document"]')).toHaveLength(2);
  const after = await paneActions(documentView);
  expect(after.find((row) => row.textContent?.startsWith('preset'))?.textContent).toContain(
    'savedLayout',
  );
  const retained = vi.mocked(f.owner.retainView).mock.calls;
  expect(retained).toHaveLength(2);
  expect(retained[0]?.[0]).toBe(retained[1]?.[0]);
  expect(retained[0]?.[1]).not.toBe(retained[1]?.[1]);
});

it('[TC-WBD-006-N] recreates a document group after the last central context tab is closed', async () => {
  const f = await fixture();
  await act(async () => f.ref.current?.openContext('chat'));
  await act(async () =>
    f.container.querySelector<HTMLButtonElement>('button[aria-label="close: chat"]')?.click(),
  );
  await act(async () => {
    expect(f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' })).toBe(true);
  });
  const saved = JSON.parse(
    localStorage.getItem(layoutStorageKey('host', 'project') ?? '') ?? 'null',
  );
  const descriptor = [...f.container.querySelectorAll('[data-dock-panel-id]')].find((panel) =>
    panel.querySelector('[data-testid="document"]'),
  );
  const id = descriptor?.getAttribute('data-dock-panel-id');
  type Node = { type: string; data: Node[] | { id: string; views: string[] } };
  const group = (node: Node): string | undefined =>
    Array.isArray(node.data)
      ? node.data.map(group).find(Boolean)
      : node.data.views.includes(id ?? '')
        ? node.data.id
        : undefined;
  expect(group(saved.layout.grid.root)).toMatch(/^main[12]$/);
});

it('[TC-WBD-006-H] restores the active document and labels a saved layout without claiming a preset', async () => {
  const original = await fixture();
  await act(async () => {
    original.ref.current?.openDocument({ documentKey: original.key, target, path: 'file.ts' });
  });
  await disposals.pop()?.();
  const restored = await fixture();
  expect(activePane(restored.container)).toContain('file.ts');
  const rows = await paneActions(restored.container.querySelector('[data-testid="document"]'));
  expect(rows.find((row) => row.textContent?.startsWith('preset'))?.textContent).toContain(
    'savedLayout',
  );
  expect(restored.closeView).not.toHaveBeenCalled();
});

it('[TC-WBD-007-H] an explicit chat selection takes precedence over a restored active document', async () => {
  const original = await fixture();
  await act(async () => {
    original.ref.current?.openDocument({ documentKey: original.key, target, path: 'file.ts' });
  });
  await disposals.pop()?.();
  const restored = await fixture({ selectedPanel: null });
  expect(activePane(restored.container)).toContain('chat');
  expect(restored.container.querySelector('[data-testid="document"]')).not.toBeNull();
  expect(restored.closeView).not.toHaveBeenCalled();
});

it('[TC-WBD-007-H] source ranges reach only the opened document view and are not saved in the layout', async () => {
  const f = await fixture({
    renderDocument: (descriptor, panelId, selection) => (
      <span data-testid="document" data-view={panelId} data-selection={JSON.stringify(selection)}>
        {descriptor.path}
      </span>
    ),
  });
  const range = { startLine: 2, startColumn: 1, endLine: 3, endColumn: 5 };
  await act(async () => {
    expect(
      f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' }, range),
    ).toBe(true);
  });
  const first = f.container.querySelector('[data-testid="document"]');
  expect(first?.getAttribute('data-selection')).toBe(JSON.stringify(range));
  // A menu row repeats its label once more to reserve its bold width.
  const split = (await paneActions(first)).find((row) => row.textContent?.startsWith('split'));
  await act(async () => split?.click());
  const views = [...f.container.querySelectorAll('[data-testid="document"]')];
  expect(views).toHaveLength(2);
  expect(views.find((view) => view !== first)?.getAttribute('data-selection')).toBeNull();
  const nextRange = { ...range, startColumn: 2 };
  await act(async () => {
    f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' }, nextRange);
  });
  expect(first?.getAttribute('data-selection')).toBe(JSON.stringify(nextRange));
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).not.toContain(
    'startLine',
  );
  expect(f.closeView).not.toHaveBeenCalled();
});

it('[TC-WBD-014-H] [TC-WBD-014-N] opens a saved team once as a tab of its own and closes it without a document decision', async () => {
  const renderGraph = vi.fn((descriptor: { corralId: string }) => (
    <span data-testid="graph">{descriptor.corralId}</span>
  ));
  const f = await fixture({ renderGraph, graphTitle: (corralId) => `Team ${corralId}` });
  await act(async () => {
    expect(f.ref.current?.openGraph('corral_a')).toBe(true);
  });
  await act(async () => {
    expect(f.ref.current?.openGraph('corral_a')).toBe(true);
  });
  expect(document.querySelectorAll('[data-testid="graph"]')).toHaveLength(1);
  expect(f.container.textContent).toContain('Team corral_a');
  const saved = JSON.parse(localStorage.getItem(layoutStorageKey('host', 'project') ?? '') ?? '{}');
  expect(
    Object.values(saved.layout.panels).some(
      (panel) =>
        (panel as { params: { descriptor: { kind: string } } }).params.descriptor.kind === 'graph',
    ),
  ).toBe(true);
  const close = f.container.querySelector<HTMLButtonElement>(
    'button[aria-label="close: Team corral_a"]',
  );
  await act(async () => close?.click());
  expect(f.closeView).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="graph"]')).toBeNull();
});

it('[TC-WBD-014-N] a team tab behind another tab is not drawn: its canvas nodes override visibility', async () => {
  const f = await fixture({
    renderGraph: (descriptor) => <span data-testid="graph">{descriptor.corralId}</span>,
    graphTitle: () => 'Team',
  });
  await act(async () => {
    f.ref.current?.openGraph('corral_a');
  });
  const holder = () =>
    document.querySelector('[data-testid="graph"]')?.closest<HTMLElement>('[data-graph-view]');
  expect(holder()?.hidden).toBe(false);
  await act(async () => f.ref.current?.openContext('chat'));
  expect(holder()?.hidden).toBe(true);
  await act(async () => {
    f.ref.current?.openGraph('corral_a');
  });
  expect(holder()?.hidden).toBe(false);
});
