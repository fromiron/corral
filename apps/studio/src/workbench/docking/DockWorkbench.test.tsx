// @vitest-environment jsdom
import { SizeScope } from '@corral/react/design-kit';
import { act, createRef, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type DocumentStore, documentKey } from '../documents/store.ts';
import { TopbarSlotContext } from '../TopbarSlot.tsx';
import {
  DockWorkbench,
  type DockWorkbenchHandle,
  type DockWorkbenchProps,
} from './DockWorkbench.tsx';
import { createPresetLayout, DEFAULT_PANELS, layoutStorageKey, serializeLayout } from './layout.ts';

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
  laidOutWidth = null;
  observed.length = 0;
  vi.unstubAllGlobals();
  localStorage.clear();
});
let laidOutWidth: number | null = null;
/** The handle of the dock a fixture mounts, reachable while it is being built. */
let lastRef: RefObject<DockWorkbenchHandle | null> | null = null;
/** Every observed element, so a test can tell the dock its size changed. */
const observed: { element: Element; observer: ResizeObserver; callback: ResizeObserverCallback }[] =
  [];
async function fixture(
  props: Partial<
    Pick<
      DockWorkbenchProps,
      | 'selectedPanel'
      | 'renderContext'
      | 'renderDocument'
      | 'renderGraph'
      | 'graphTitle'
      | 'terminalStatus'
      | 'onActiveContext'
      | 'onOpenElsewhere'
      | 'onReady'
    >
  > = {},
  density?: 'default' | 'compact',
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
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      // Only a test that gives the dock a width lays its grid out.
      observe(element: Element) {
        observed.push({
          element,
          observer: this as unknown as ResizeObserver,
          callback: this.callback,
        });
        if (laidOutWidth === null) return;
        const contentRect = { width: laidOutWidth, height: 800 } as DOMRectReadOnly;
        this.callback(
          [{ target: element, contentRect } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
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
  lastRef = ref;
  // As the session screen does: the selection key carries the whole address, so it changes
  // with every render the page makes, the frame's own address writes included.
  let renders = 0;
  const renderSession = async (sessionId: string) =>
    act(async () => {
      renders += 1;
      const dock = (
        <TopbarSlotContext.Provider value={{ actions: null, crumbs: null }}>
          <DockWorkbench
            ref={ref}
            hostId="host"
            projectId="project"
            sessionId={sessionId}
            selectionKey={`${sessionId}:${renders}`}
            documentOwner={owner}
            renderContext={(view) => <span>{view}</span>}
            renderDocument={(descriptor) => <span data-testid="document">{descriptor.path}</span>}
            {...props}
          />
        </TopbarSlotContext.Provider>
      );
      root.render(density ? <SizeScope size={density}>{dock}</SizeScope> : dock);
    });
  await renderSession('session');
  return { ref, container, owner, closeView, key, renderSession };
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

const contextTabs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.dv-tab[role="tab"]')].map((tab) =>
    tab.getAttribute('aria-label'),
  );
it('a new dock opens its file tree and carries no conversation pane; its layout is saved once the person arranges something (workbench.md)', async () => {
  const f = await fixture();
  expect(contextTabs(f.container)).toEqual(['files']);
  expect(contextTabs(f.container)).not.toContain('chat');
  // The automatic first layout is nothing the person did.
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).toBeNull();
  await act(async () => {
    f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' });
  });
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).not.toBeNull();
});

it('a dock first opened narrow saves nothing, so a later wide dock opens with the wide default arrangement (workbench.md)', async () => {
  dockWidth(1200);
  const wide = await fixture();
  const wideTabs = contextTabs(wide.container);
  const wideGroups = wide.container.querySelectorAll('.dv-groupview').length;
  await disposals.pop()?.();
  localStorage.clear();

  dockWidth(456);
  await fixture();
  await act(async () => {});
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).toBeNull();
  await disposals.pop()?.();

  dockWidth(1200);
  const later = await fixture();
  expect(contextTabs(later.container)).toEqual(wideTabs);
  expect(later.container.querySelectorAll('.dv-groupview').length).toBe(wideGroups);
});

it('a document the page asked for before the dock was built counts as the person arranging it (workbench.md)', async () => {
  // As the session screen does with a request queued for a dock not built yet: it is handed
  // over when the dock is ready.
  const f = await fixture({
    onReady: () =>
      lastRef?.current?.openDocument({
        documentKey: documentKey(target, 'file.ts'),
        target,
        path: 'file.ts',
      }),
  });
  expect(f.container.querySelector('[data-testid="document"]')).not.toBeNull();
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).not.toBeNull();
});

it('a dock first built for a pane the page asked for (one the page asked for) saves that layout (workbench.md)', async () => {
  await fixture({ selectedPanel: 'tools' });
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).not.toBeNull();
});

it('going to another conversation is not an arrangement: a dock nobody arranged still saves nothing (workbench.md)', async () => {
  const f = await fixture({ selectedPanel: 'files' });
  await f.renderSession('next_session');
  await act(async () => {});
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).toBeNull();
});

it('a request from outside the dock that opens a window counts as the person arranging it; a width change afterwards is not saved (workbench.md)', async () => {
  dockWidth(1200);
  const props: Parameters<typeof fixture>[0] = {};
  const f = await fixture(props);
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).toBeNull();
  // The page asks for the pane.
  props.selectedPanel = 'tools';
  await f.renderSession('session');
  await act(async () => {});
  const saved = localStorage.getItem(layoutStorageKey('host', 'project') ?? '');
  expect(saved).not.toBeNull();
  // The panel narrows: the dock shows one pane, and that is not saved.
  await resizeDock(456);
  await act(async () => {});
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).toBe(saved);
});

it.each(['files'] as const)(
  'opens an explicitly requested %s pane in a new dock',
  async (selectedPanel) => {
    const f = await fixture({ selectedPanel });
    expect(contextTabs(f.container)).toEqual([selectedPanel]);
    expect(activePane(f.container)).toBe(selectedPanel);
  },
);

it('hands a pane another panel tab carries to that tab without creating a dock pane', async () => {
  const onOpenElsewhere = vi.fn();
  const f = await fixture({ onOpenElsewhere });
  for (const view of [
    'chat',
    'changes',
    'git',
    'checks',
    'problems',
    'artifacts',
    'run',
  ] as const) {
    await act(async () => f.ref.current?.openContext(view, true));
    expect(onOpenElsewhere).toHaveBeenLastCalledWith(view);
    expect(contextTabs(f.container)).not.toContain(view);
  }
  // Asked for without revealing (the address's selected pane), it does nothing at all.
  onOpenElsewhere.mockClear();
  await act(async () => f.ref.current?.openContext('changes'));
  expect(onOpenElsewhere).not.toHaveBeenCalled();
});

it('handing a pane elsewhere and changing conversation keep the open document as it is', async () => {
  const onActiveContext = vi.fn();
  const onOpenElsewhere = vi.fn();
  const f = await fixture({ onActiveContext, onOpenElsewhere });
  await act(async () => {
    f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' });
  });
  const documentView = f.container.querySelector('[data-testid="document"]');
  expect(onActiveContext).toHaveBeenLastCalledWith('files');
  await act(async () => f.ref.current?.openContext('run', true));
  expect(onOpenElsewhere).toHaveBeenLastCalledWith('run');
  expect(f.container.querySelector('[data-testid="document"]')).toBe(documentView);
  expect(activePane(f.container)).toContain('file.ts');
  await f.renderSession('next_session');
  expect(f.container.querySelector('[data-testid="document"]')).toBe(documentView);
  expect(f.closeView).not.toHaveBeenCalled();
  expect(f.owner.retainView).toHaveBeenCalledTimes(1);
});

it('removes only a legacy run pane on restore, keeping the tools and the document in front', async () => {
  const original = await fixture({ selectedPanel: 'tools' });
  await act(async () => {
    original.ref.current?.openDocument({ documentKey: original.key, target, path: 'file.ts' });
  });
  const storageKey = layoutStorageKey('host', 'project') ?? '';
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
  const legacyRun = createPresetLayout('conversation', DEFAULT_PANELS).panels['context:run'];
  saved.layout.panels['context:run'] = legacyRun;
  type Node = { type: string; data: Node[] | { id: string; views: string[] } };
  const aux = (node: Node): Node | undefined =>
    Array.isArray(node.data)
      ? node.data.map(aux).find(Boolean)
      : node.data.id === 'bottom'
        ? node
        : undefined;
  const group = aux(saved.layout.grid.root);
  if (!group || Array.isArray(group.data)) throw new Error('Missing saved auxiliary group');
  group.data.views.push('context:run');
  await disposals.pop()?.();
  localStorage.setItem(storageKey, JSON.stringify(saved));
  const restored = await fixture({ selectedPanel: 'run' });
  expect(contextTabs(restored.container)).not.toContain('run');
  expect(contextTabs(restored.container)).toContain('tools');
  expect(restored.container.querySelector('[data-testid="document"]')).not.toBeNull();
  expect(activePane(restored.container)).toContain('file.ts');
  expect(restored.container.querySelector('[data-testid="document"]')).not.toBeNull();
  expect(restored.closeView).not.toHaveBeenCalled();
});

it.each([
  ['unmeasured', null],
  ['narrow', 456],
] as const)(
  'a dock built from a saved arrangement with a document in front reports nothing, then shows the pane the page asks for (%s)',
  async (_name, width) => {
    if (width !== null) dockWidth(width);
    const original = await fixture();
    await act(async () => {
      original.ref.current?.openDocument({ documentKey: original.key, target, path: 'file.ts' });
    });
    await act(async () => original.ref.current?.openContext('tools', true));
    await act(async () => {
      original.ref.current?.openDocument({ documentKey: original.key, target, path: 'file.ts' });
    });
    expect(activePane(original.container)).toContain('file.ts');
    await disposals.pop()?.();

    const onActiveContext = vi.fn();
    const props: Parameters<typeof fixture>[0] = { onActiveContext, selectedPanel: null };
    const restored = await fixture(props);
    // What the arrangement put in front is not something the person did here.
    expect(activePane(restored.container)).toContain('file.ts');
    expect(onActiveContext).not.toHaveBeenCalled();

    // The page's request, arriving after the dock was built, brings its pane forward.
    props.selectedPanel = 'tools';
    await restored.renderSession('session');
    expect(activePane(restored.container)).toBe('tools');
    expect(onActiveContext).not.toHaveBeenCalled();
    if (width !== null) {
      // One pane at a time: that pane alone, with the switcher.
      expect(restored.container.querySelector('[data-testid="dock-toolbar"]')).not.toBeNull();
      expect(shownGroups(restored.container)).toBe(1);
      vi.restoreAllMocks();
    }
  },
);

it.each(['tools'] as const)(
  'an explicit %s link reopens its closed pane even when the selected URL has not changed',
  async (selectedPanel) => {
    const f = await fixture({
      selectedPanel,
      // The links stand in the file tree, the pane that stays open.
      renderContext: (view) =>
        view === 'files' ? (
          <>
            <a
              href={`/sessions/session?panel=${selectedPanel}`}
              onClick={(event) => event.preventDefault()}
            >
              Open controls
            </a>
            <a
              data-keep-pane-closed
              href={`/sessions/another?panel=${selectedPanel}`}
              onClick={(event) => event.preventDefault()}
            >
              Other session
            </a>
            <a
              data-keep-pane-closed
              href={`/sessions/session?panel=${selectedPanel}&settings=models`}
              onClick={(event) => event.preventDefault()}
            >
              Settings
            </a>
            <a
              data-keep-pane-closed
              href={`/sessions/session?panel=${selectedPanel}`}
              target="_blank"
              onClick={(event) => event.preventDefault()}
              rel="noopener"
            >
              New tab
            </a>
            <a
              data-keep-pane-closed
              href={`https://example.invalid/sessions/session?panel=${selectedPanel}`}
              onClick={(event) => event.preventDefault()}
            >
              Other host
            </a>
          </>
        ) : (
          <span>{view}</span>
        ),
    });
    await act(async () =>
      f.container
        .querySelector<HTMLButtonElement>(`button[aria-label="close: ${selectedPanel}"]`)
        ?.click(),
    );
    expect(contextTabs(f.container)).not.toContain(selectedPanel);
    const link = f.container.querySelector<HTMLAnchorElement>(
      `a[href="/sessions/session?panel=${selectedPanel}"]`,
    );
    expect(link).not.toBeNull();
    await act(async () =>
      link?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      ),
    );
    await act(async () => {
      for (const otherLink of f.container.querySelectorAll<HTMLAnchorElement>(
        '[data-keep-pane-closed]',
      ))
        otherLink.click();
    });
    expect(contextTabs(f.container)).not.toContain(selectedPanel);
    await act(async () => link?.click());
    expect(contextTabs(f.container)).toContain(selectedPanel);
    expect(activePane(f.container)).toBe(selectedPanel);
    expect(f.closeView).not.toHaveBeenCalled();
  },
);

it('keeps the previously saved side panes instead of replacing them with the new default', async () => {
  const panes = DEFAULT_PANELS.filter(
    (panel) =>
      panel.descriptor.kind === 'context' &&
      ['chat', 'files', 'changes', 'artifacts', 'run'].includes(panel.descriptor.view),
  );
  const saved = createPresetLayout('conversation', panes);
  localStorage.setItem(
    layoutStorageKey('host', 'project') ?? '',
    serializeLayout(saved, 'host', 'project'),
  );
  const f = await fixture();
  expect(contextTabs(f.container)).toEqual(
    panes
      .filter((panel) => panel.id === 'context:files')
      .map((panel) => (panel.descriptor.kind === 'context' ? panel.descriptor.view : '')),
  );
});

it('leaves a dirty document open until its close decision succeeds', async () => {
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
  '%s on a document tab keeps the unsaved-change guard',
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

it('rejects another host and keeps one document identity on repeated opens', async () => {
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

it('moving a document between presets reuses its rendered view and logical ownership', async () => {
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

it('recreates a document group after the last file workspace pane is closed', async () => {
  const f = await fixture();
  await act(async () => f.ref.current?.openContext('files'));
  await act(async () =>
    f.container
      .querySelector('[data-tab-panel-id="context:files"]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
      ),
  );
  expect(contextTabs(f.container)).toEqual([]);
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

it('restores the active document and labels a saved layout without claiming a preset', async () => {
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

it('a restored dock asked for no pane keeps its document in front', async () => {
  const original = await fixture();
  await act(async () => {
    original.ref.current?.openDocument({ documentKey: original.key, target, path: 'file.ts' });
  });
  await disposals.pop()?.();
  const restored = await fixture({ selectedPanel: null });
  expect(activePane(restored.container)).toContain('file.ts');
  expect(restored.container.querySelector('[data-testid="document"]')).not.toBeNull();
  expect(restored.closeView).not.toHaveBeenCalled();
});

it('source ranges reach only the opened document view and are not saved in the layout', async () => {
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

it('opens a saved team once as a tab of its own and closes it without a document decision', async () => {
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

it('a team tab behind another tab is not drawn: its canvas nodes override visibility', async () => {
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
  // The file tree, in the same group, comes in front of it.
  await act(async () => f.ref.current?.openContext('files', true));
  await vi.waitFor(() => expect(holder()?.hidden).toBe(true));
  await act(async () => {
    f.ref.current?.openGraph('corral_a');
  });
  expect(holder()?.hidden).toBe(false);
});

it('the review preset hands Changes to its own tab while keeping the selected document', async () => {
  const onOpenElsewhere = vi.fn();
  const f = await fixture({ onOpenElsewhere });
  await act(async () =>
    f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' }),
  );
  const documentView = document.querySelector('[data-testid="document"]');
  const rows = await paneActions(documentView);
  await act(async () => rows.find((row) => row.textContent?.startsWith('preset'))?.click());
  const review = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent?.includes('review'),
  );
  expect(review).toBeDefined();
  await act(async () => review?.click());
  expect(onOpenElsewhere).toHaveBeenLastCalledWith('changes');
  expect(document.querySelector('[data-testid="document"]')).toBe(documentView);
  await disposals.pop()?.();
  const restored = await fixture({ selectedPanel: 'changes' });
  expect(contextTabs(restored.container)).not.toContain('changes');
  expect(activePane(restored.container)).toContain('file.ts');
});

type SavedNode = {
  type: 'leaf' | 'branch';
  size: number;
  data: { id: string; views: string[] } | SavedNode[];
};
const savedGroups = () => {
  const saved = JSON.parse(localStorage.getItem(layoutStorageKey('host', 'project') ?? '') ?? '{}');
  const walk = (node: SavedNode): { id: string; views: string[]; size: number }[] =>
    node.type === 'leaf'
      ? [{ ...(node.data as { id: string; views: string[] }), size: node.size }]
      : (node.data as SavedNode[]).flatMap(walk);
  return saved.layout ? walk(saved.layout.grid.root) : [];
};
/** A dock of this width; jsdom otherwise measures every element as zero. */
function dockWidth(width: number) {
  laidOutWidth = width;
  // Dockview lays out only an element that is displayed.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 800,
    top: 0,
    left: 0,
    right: width,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Lays the dock out at a new width, as a shown or hidden panel tab does, and says so. */
async function resizeDock(width: number) {
  dockWidth(width);
  await act(async () => {
    for (const { element, observer, callback } of observed)
      callback(
        [{ target: element, contentRect: { width, height: 800 } } as ResizeObserverEntry],
        observer,
      );
  });
}
/** Dock groups on screen: a narrow dock shows one, the others hidden behind it. */
const shownGroups = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.dv-groupview')].filter((group) => {
    for (
      let view = group.closest('.dv-view');
      view;
      view = view.parentElement?.closest('.dv-view') ?? null
    )
      if (!view.classList.contains('visible')) return false;
    return true;
  }).length;

it('a narrow dock hidden with its panel tab and shown again keeps one pane at a time with its switcher', async () => {
  const panels = [
    { id: 'context:files', descriptor: { kind: 'context' as const, view: 'files' as const } },
    { id: 'context:tools', descriptor: { kind: 'context' as const, view: 'tools' as const } },
  ];
  localStorage.setItem(
    layoutStorageKey('host', 'project') ?? '',
    serializeLayout(createPresetLayout('implementation', panels), 'host', 'project'),
  );
  dockWidth(456);
  try {
    const f = await fixture({ selectedPanel: 'tools' });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    const switcher = () => f.container.querySelector('[data-testid="dock-toolbar"]');
    expect(switcher()).not.toBeNull();
    expect(shownGroups(f.container)).toBe(1);
    expect(activePane(f.container)).toBe('tools');

    // Hidden, the dock measures nothing: what it lays out is what the tab shows when it is back.
    await resizeDock(0);
    expect(switcher()).not.toBeNull();
    expect(shownGroups(f.container)).toBe(1);

    await resizeDock(456);
    expect(switcher()).not.toBeNull();
    expect(shownGroups(f.container)).toBe(1);
    expect(activePane(f.container)).toBe('tools');
  } finally {
    vi.restoreAllMocks();
  }
});

it('a dock measured wide when shown again leaves the one-pane layout', async () => {
  dockWidth(456);
  try {
    const f = await fixture({ selectedPanel: 'tools' });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(f.container.querySelector('[data-testid="dock-toolbar"]')).not.toBeNull();
    await resizeDock(0);
    await resizeDock(1280);
    expect(f.container.querySelector('[data-testid="dock-toolbar"]')).toBeNull();
    expect(shownGroups(f.container)).toBeGreaterThan(1);
  } finally {
    vi.restoreAllMocks();
  }
});

// The tree's column fits its head (where it reads from with its tools, then the filter row) at the
// interface density: about 260px at compact, 300px at the default size.
it.each([
  ['compact', 240, 280],
  ['default', 280, 320],
] as const)(
  'from 960px a new dock opens documents in a group beside the file tree (%s)',
  async (density, min, max) => {
    dockWidth(1280);
    try {
      const f = await fixture({}, density);
      // Dockview lays the grid out on the frame after it is measured.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      await act(async () => f.ref.current?.openContext('files'));
      await act(async () => {
        expect(f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' })).toBe(
          true,
        );
      });
      const groups = savedGroups();
      expect(groups.map(({ id, views }) => ({ id, views }))).toEqual([
        { id: 'tree', views: ['context:files'] },
        { id: 'main1', views: [expect.stringMatching(/^document:/)] },
      ]);
      // The tree keeps its column; the document takes the rest.
      expect(groups[0]?.size).toBeGreaterThanOrEqual(min);
      expect(groups[0]?.size).toBeLessThanOrEqual(max);
      expect(groups[1]?.size).toBeGreaterThan(900);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it('a team design opened first in a wide new dock stays a full-width tab with the tree', async () => {
  dockWidth(1280);
  try {
    const f = await fixture({
      renderGraph: (descriptor) => <span>{descriptor.corralId}</span>,
      graphTitle: (corralId) => `Team ${corralId}`,
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    await act(async () => {
      expect(f.ref.current?.openGraph('corral_a')).toBe(true);
    });
    const groups = savedGroups();
    // Only documents open beside the tree; the canvas keeps the dock's width.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.views).toEqual(['context:files', expect.stringMatching(/^graph:/)]);
  } finally {
    vi.restoreAllMocks();
  }
});

it('a narrower new dock keeps the document a tab beside the file tree', async () => {
  dockWidth(900);
  try {
    const f = await fixture();
    await act(async () => f.ref.current?.openContext('files'));
    await act(async () => {
      f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' });
    });
    const groups = savedGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.views).toEqual(['context:files', expect.stringMatching(/^document:/)]);
  } finally {
    vi.restoreAllMocks();
  }
});

it('a saved arrangement is restored as it was, however wide the dock', async () => {
  const panels = [
    { id: 'context:files', descriptor: { kind: 'context' as const, view: 'files' as const } },
    {
      id: 'document:saved',
      descriptor: { kind: 'document' as const, target, path: 'file.ts', viewId: 'document:saved' },
    },
  ];
  localStorage.setItem(
    layoutStorageKey('host', 'project') ?? '',
    serializeLayout(createPresetLayout('implementation', panels), 'host', 'project'),
  );
  const before = savedGroups().map(({ id, views }) => ({ id, views }));
  dockWidth(1280);
  try {
    await fixture();
    expect(savedGroups().map(({ id, views }) => ({ id, views }))).toEqual(before);
    expect(before.map((group) => group.id)).not.toContain('tree');
  } finally {
    vi.restoreAllMocks();
  }
});

it('a pane shown alone by a narrow dock is never what the project arrangement keeps', async () => {
  // A narrow dock maximizes the pane in front; the saved arrangement (layout.ts parseLayout)
  // keeps only the grid's nodes and sizes, so a maximized group never reaches other docks.
  const panels = [
    { id: 'context:files', descriptor: { kind: 'context' as const, view: 'files' as const } },
    { id: 'context:tools', descriptor: { kind: 'context' as const, view: 'tools' as const } },
  ];
  const layout = createPresetLayout('implementation', panels);
  const maximized = { ...layout, grid: { ...layout.grid, maximizedNode: { location: [1] } } };
  localStorage.setItem(
    layoutStorageKey('host', 'project') ?? '',
    serializeLayout(maximized as typeof layout, 'host', 'project'),
  );
  dockWidth(1280);
  try {
    await fixture();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    const saved = JSON.parse(
      localStorage.getItem(layoutStorageKey('host', 'project') ?? '') ?? '{}',
    );
    expect(saved.layout.grid).not.toHaveProperty('maximizedNode');
    expect(savedGroups().flatMap((group) => group.views)).toEqual(
      expect.arrayContaining(['context:files', 'context:tools']),
    );
  } finally {
    vi.restoreAllMocks();
  }
});
