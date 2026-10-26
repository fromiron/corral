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
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function fixture(
  props: Partial<
    Pick<
      DockWorkbenchProps,
      | 'selectedPanel'
      | 'renderContext'
      | 'renderDocument'
      | 'renderGraph'
      | 'graphTitle'
      | 'controls'
      | 'onActiveContext'
      | 'fileWorkAvailable'
    >
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
  const renderSession = async (sessionId: string) =>
    act(async () => {
      root.render(
        <DockWorkbench
          ref={ref}
          hostId="host"
          projectId="project"
          sessionId={sessionId}
          documentOwner={owner}
          renderContext={(view) => <span>{view}</span>}
          renderDocument={(descriptor) => <span data-testid="document">{descriptor.path}</span>}
          {...props}
        />,
      );
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
const sessionTab = (container: HTMLElement, label: string) =>
  [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="sessionViews"] [role="tab"]'),
  ].find((tab) => tab.textContent?.startsWith(label));

it('keeps conversation independent from the file workspace and reveals file work only when needed', async () => {
  const f = await fixture();
  expect(sessionTab(f.container, 'chat')?.getAttribute('aria-selected')).toBe('true');
  expect(sessionTab(f.container, 'history')?.getAttribute('aria-selected')).toBe('false');
  expect(sessionTab(f.container, 'files')).toBeUndefined();
  expect(sessionTab(f.container, 'changes')).toBeUndefined();
  expect(contextTabs(f.container)).not.toContain('chat');
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).toBeNull();
  await act(async () => f.ref.current?.openContext('files'));
  expect(sessionTab(f.container, 'files')?.getAttribute('aria-selected')).toBe('true');
  expect(sessionTab(f.container, 'changes')).toBeDefined();
  expect(localStorage.getItem(layoutStorageKey('host', 'project') ?? '')).not.toBeNull();
});

it.each(['files'] as const)(
  'opens an explicitly requested %s pane beside a new conversation',
  async (selectedPanel) => {
    const f = await fixture({ selectedPanel });
    expect(contextTabs(f.container)).toEqual([selectedPanel]);
    expect(sessionTab(f.container, 'files')?.getAttribute('aria-selected')).toBe('true');
    expect(activePane(f.container)).toBe(selectedPanel);
  },
);

it('uses changes and history for their existing panel aliases without creating dock panes', async () => {
  const f = await fixture({
    fileWorkAvailable: true,
    renderContext: (view, requestedView) => <span data-view={view}>{requestedView ?? view}</span>,
  });
  expect(sessionTab(f.container, 'files')).toBeDefined();
  expect(sessionTab(f.container, 'changes')).toBeDefined();
  for (const view of ['git', 'checks', 'problems', 'artifacts'] as const) {
    await act(async () => f.ref.current?.openContext(view));
    const primary = view === 'artifacts' ? 'history' : 'changes';
    expect(sessionTab(f.container, primary)?.getAttribute('aria-selected')).toBe('true');
    expect(
      f.container.querySelector(`[data-view="${primary === 'history' ? 'run' : 'changes'}"]`)
        ?.textContent,
    ).toBe(view);
    expect(contextTabs(f.container)).not.toContain(view);
  }
});

it('uses the single top conversation tab without remounting the draft or open documents', async () => {
  const onActiveContext = vi.fn();
  const f = await fixture({
    renderContext: (view) =>
      view === 'chat' ? (
        <textarea data-testid="draft" defaultValue="draft" />
      ) : (
        <span data-testid={view === 'run' ? 'history' : undefined}>{view}</span>
      ),
    controls: <button type="button">Run controls</button>,
    onActiveContext,
  });
  const draft = f.container.querySelector<HTMLTextAreaElement>('[data-testid="draft"]');
  if (!draft) throw new Error('Missing draft');
  draft.value = 'keep my draft';
  await act(async () => {
    f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' });
  });
  const documentView = f.container.querySelector('[data-testid="document"]');
  expect(sessionTab(f.container, 'files')?.getAttribute('aria-selected')).toBe('true');
  expect(onActiveContext).toHaveBeenLastCalledWith('files');
  await act(async () => sessionTab(f.container, 'chat')?.click());
  expect(sessionTab(f.container, 'chat')?.getAttribute('aria-selected')).toBe('true');
  expect(f.container.querySelector('[data-testid="document"]')).toBe(documentView);
  await act(async () => {
    f.ref.current?.openDocument({ documentKey: f.key, target, path: 'file.ts' });
  });
  const history = sessionTab(f.container, 'history');
  expect(history).toBeDefined();
  await act(async () => history?.click());
  expect(sessionTab(f.container, 'history')?.getAttribute('aria-selected')).toBe('true');
  expect(onActiveContext).toHaveBeenLastCalledWith('run');
  expect(f.container.querySelectorAll('[data-testid="history"]')).toHaveLength(1);
  expect(draft.value).toBe('keep my draft');
  expect(f.container.querySelector('[data-testid="document"]')).toBe(documentView);
  expect(
    f.container.querySelector('.corral-dock-controls')?.closest('[role="tabpanel"]'),
  ).toBeNull();
  await act(async () => sessionTab(f.container, 'chat')?.click());
  expect(sessionTab(f.container, 'chat')?.getAttribute('aria-selected')).toBe('true');
  expect(f.container.querySelector('[data-testid="draft"]')).toBe(draft);
  expect(f.closeView).not.toHaveBeenCalled();
  expect(f.owner.retainView).toHaveBeenCalledTimes(1);
  await act(async () => sessionTab(f.container, 'history')?.click());
  await f.renderSession('next_session');
  expect(sessionTab(f.container, 'chat')?.getAttribute('aria-selected')).toBe('true');
  expect(f.container.querySelector('[data-testid="document"]')).toBe(documentView);
});

it('opens an explicit run in history and removes only its legacy dock pane on restore', async () => {
  const original = await fixture({ selectedPanel: 'terminal' });
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
  expect(sessionTab(restored.container, 'history')?.getAttribute('aria-selected')).toBe('true');
  expect(contextTabs(restored.container)).not.toContain('run');
  expect(contextTabs(restored.container)).toContain('terminal');
  expect(restored.container.querySelector('[data-testid="document"]')).not.toBeNull();
  expect(activePane(restored.container)).toContain('file.ts');
  await act(async () => sessionTab(restored.container, 'chat')?.click());
  expect(sessionTab(restored.container, 'chat')?.getAttribute('aria-selected')).toBe('true');
  expect(activePane(restored.container)).toContain('file.ts');
  expect(restored.container.querySelector('[data-testid="document"]')).not.toBeNull();
  expect(restored.closeView).not.toHaveBeenCalled();
});

it.each(['terminal', 'tools'] as const)(
  'an explicit %s link reopens its closed pane even when the selected URL has not changed',
  async (selectedPanel) => {
    const f = await fixture({
      selectedPanel,
      renderContext: (view) =>
        view === 'chat' ? (
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

it('an explicit chat selection takes precedence over a restored active document', async () => {
  const original = await fixture();
  await act(async () => {
    original.ref.current?.openDocument({ documentKey: original.key, target, path: 'file.ts' });
  });
  await disposals.pop()?.();
  const restored = await fixture({ selectedPanel: null });
  expect(sessionTab(restored.container, 'chat')?.getAttribute('aria-selected')).toBe('true');
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
  await act(async () => f.ref.current?.openContext('chat'));
  await vi.waitFor(() =>
    expect(holder()?.closest<HTMLElement>('.corral-dock-session-panel')?.hidden).toBe(true),
  );
  await act(async () => {
    f.ref.current?.openGraph('corral_a');
  });
  expect(holder()?.hidden).toBe(false);
});
