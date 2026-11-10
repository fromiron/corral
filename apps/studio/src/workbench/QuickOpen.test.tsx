// @vitest-environment jsdom
import type { WorkspaceTarget } from '@corral/contracts';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DockWorkbench, type DockWorkbenchHandle } from './docking/DockWorkbench.tsx';
import { documentKey } from './documents/store.ts';
import { openQuickOpen, QuickOpen, SEARCH_DELAY } from './QuickOpen.tsx';
import { TopbarSlotContext } from './TopbarSlot.tsx';

Element.prototype.getAnimations ??= () => [];
Element.prototype.scrollIntoView ??= () => {};

type Search = { items: { path: string; kind: 'file' | 'folder' }[]; truncated: boolean };
const fixture = vi.hoisted(() => ({
  copy: {
    sessionId: 'session',
    bindingId: 'binding',
    copyGeneration: 1,
    missing: false,
    removedAt: null,
  } as Record<string, unknown> | null,
  binding: { projectId: 'project' } as Record<string, unknown> | null,
  search: vi.fn(
    async (_scope: unknown, _query: string, _limit?: number, _signal?: AbortSignal) => ({
      items: [] as { path: string; kind: 'file' | 'folder' }[],
      truncated: false,
    }),
  ),
  owner: null as unknown,
}));
vi.mock('../services.tsx', () => {
  const services = {
    mode: 'server',
    workspaceId: 'host',
    workspaces: {
      worktree: async () => fixture.copy,
      binding: async () => fixture.binding,
      searchFiles: fixture.search,
    },
  };
  return { useServices: () => services };
});
vi.mock('./documents/store.ts', async (original) => ({
  ...(await original<typeof import('./documents/store.ts')>()),
  documentStore: () => fixture.owner,
}));

const target: WorkspaceTarget = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
function owner() {
  const store = createStore<{ documents: Record<string, unknown> }>(() => ({ documents: {} }));
  return Object.assign(store, {
    open: vi.fn(async (_session: string, path: string) => {
      const key = documentKey(target, path);
      store.setState((state) => ({
        documents: { ...state.documents, [key]: { key, target, path, dirty: false } },
      }));
      return key;
    }),
    retainView: vi.fn(() => () => {}),
    closeView: vi.fn(async () => 'closed'),
  });
}
const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
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
  fixture.copy = {
    sessionId: 'session',
    bindingId: 'binding',
    copyGeneration: 1,
    missing: false,
    removedAt: null,
  };
  fixture.binding = { projectId: 'project' };
  fixture.search.mockReset();
  fixture.search.mockImplementation(async (_scope, query) => ({
    items: [
      { path: 'src/file.ts', kind: 'file' as const },
      { path: 'src/other.ts', kind: 'file' as const },
    ].filter((item) => item.path.includes(query)),
    truncated: false,
  }));
  fixture.owner = owner();
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mount({ withDock = false } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const dock = createRef<DockWorkbenchHandle>();
  const openDocument = vi.fn((input: Parameters<DockWorkbenchHandle['openDocument']>[0]) =>
    withDock ? (dock.current?.openDocument(input) ?? false) : true,
  );
  const showInFiles = vi.fn();
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TopbarSlotContext.Provider value={{ actions: null, views: null, crumbs: null }}>
          <button type="button" data-testid="opener" onClick={() => openQuickOpen()}>
            open
          </button>
          <QuickOpen
            projectId="project"
            sessionId="session"
            openDocument={openDocument}
            showInFiles={showInFiles}
          />
          {withDock ? (
            <DockWorkbench
              ref={dock}
              hostId="host"
              projectId="project"
              sessionId="session"
              documentOwner={fixture.owner as never}
              renderContext={(view) => <span>{view}</span>}
              renderDocument={(descriptor) => <span data-testid="document">{descriptor.path}</span>}
            />
          ) : null}
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    );
  });
  return { container, openDocument, showInFiles };
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
// The kit dialog unmounts after its exit motion, or its fallback timer in jsdom.
const exited = () => act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const input = () => dialog()?.querySelector<HTMLInputElement>('input[role="combobox"]') ?? null;
const options = () =>
  [...(dialog()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].map(
    (option) => option.textContent ?? '',
  );
async function show() {
  const opener = document.querySelector<HTMLButtonElement>('[data-testid="opener"]');
  await act(async () => {
    opener?.focus();
    opener?.click();
  });
  await settle();
}
async function press(value: string) {
  await act(async () => {
    const field = input();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(field, value);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** Types `value` and waits out the pause after which the search goes. */
async function type(value: string) {
  await press(value);
  await act(async () => new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY)));
  await settle();
}
const key = (name: string) =>
  act(async () => {
    input()?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });

it('opens with Ctrl+P, names its target and announces the result count', async () => {
  await mount();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
  });
  await settle();
  expect(dialog()).not.toBeNull();
  expect(dialog()?.textContent).toContain(messages.Desktop.sessionCopy);
  await type('file');
  expect(fixture.search).toHaveBeenLastCalledWith(
    { kind: 'session', id: 'session' },
    'file',
    50,
    expect.any(AbortSignal),
  );
  expect(options()).toEqual(['src/file.ts']);
  const status = dialog()?.querySelector('[role="status"]');
  expect(status?.textContent).toBe('1 result');
});

it('opening an already-open file focuses its tab instead of opening another', async () => {
  const { openDocument } = await mount({ withDock: true });
  const active = () =>
    document.querySelector('.dv-active-group [role="tab"][aria-selected="true"]')?.textContent;
  for (const query of ['file', 'other', 'file']) {
    await show();
    await type(query);
    await key('Enter');
    await exited();
    expect(dialog()).toBeNull();
  }
  expect(openDocument).toHaveBeenCalledTimes(3);
  expect(
    [...document.querySelectorAll('[data-testid="document"]')].map((node) => node.textContent),
  ).toEqual(['src/file.ts', 'src/other.ts']);
  expect(active()).toContain('file.ts');
});

it('drops a late answer to an earlier query', async () => {
  const answers: ((value: Search) => void)[] = [];
  fixture.search.mockImplementation(
    () =>
      new Promise<Search>((resolve) => {
        answers.push(resolve);
      }),
  );
  await mount();
  await show();
  await type('a');
  await type('ab');
  await act(async () =>
    answers.at(-1)?.({ items: [{ path: 'ab.ts', kind: 'file' }], truncated: false }),
  );
  await act(async () =>
    answers.at(-2)?.({ items: [{ path: 'a-old.ts', kind: 'file' }], truncated: false }),
  );
  await settle();
  expect(options()).toEqual(['ab.ts']);
});

it('drops an answer for the previous target and opens only what the current target returned', async () => {
  const answers: ((value: Search) => void)[] = [];
  fixture.search.mockImplementation(
    () =>
      new Promise<Search>((resolve) => {
        answers.push(resolve);
      }),
  );
  const { openDocument, showInFiles } = await mount();
  await show();
  await type('notes');
  // The copy is removed elsewhere while the copy's answer is still on its way.
  fixture.copy = null;
  await act(async () => {
    window.dispatchEvent(new Event('corral:workspace-changed'));
  });
  await settle();
  expect(dialog()?.textContent).toContain(messages.Desktop.sourceFolder);
  await act(async () =>
    answers[0]?.({ items: [{ path: 'copy-only.md', kind: 'file' }], truncated: false }),
  );
  await settle();
  expect(options()).not.toContain('copy-only.md');
  expect(fixture.search).toHaveBeenLastCalledWith(
    { kind: 'project', id: 'project' },
    'notes',
    50,
    expect.any(AbortSignal),
  );
  await act(async () =>
    answers.at(-1)?.({ items: [{ path: 'docs/notes.md', kind: 'file' }], truncated: false }),
  );
  await settle();
  await key('Enter');
  await settle();
  expect(openDocument).not.toHaveBeenCalled();
  expect((fixture.owner as { open: ReturnType<typeof vi.fn> }).open).not.toHaveBeenCalled();
  expect(showInFiles).toHaveBeenCalledWith({
    sessionId: 'session',
    source: 'project',
    path: 'docs/notes.md',
    kind: 'file',
  });
});

it('while a newer query is pending, the earlier results are gone and Enter opens nothing', async () => {
  const answers: ((value: Search) => void)[] = [];
  fixture.search.mockImplementation(
    () =>
      new Promise<Search>((resolve) => {
        answers.push(resolve);
      }),
  );
  const { openDocument, showInFiles } = await mount();
  await show();
  await type('file');
  await act(async () =>
    answers.at(-1)?.({ items: [{ path: 'src/file.ts', kind: 'file' }], truncated: false }),
  );
  await settle();
  expect(options()).toEqual(['src/file.ts']);
  // The answer to "other" is slow: what "file" returned must not stay on screen or open.
  await type('other');
  expect(options()).toEqual([]);
  expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
    messages.QuickOpen.searching,
  );
  await key('Enter');
  await settle();
  expect(openDocument).not.toHaveBeenCalled();
  expect(showInFiles).not.toHaveBeenCalled();
  expect((fixture.owner as { open: ReturnType<typeof vi.fn> }).open).not.toHaveBeenCalled();
});

it('a file read that finishes after the target changed opens nothing, and the next one opens', async () => {
  let finish: (key: string) => void = () => {};
  const store = fixture.owner as ReturnType<typeof owner>;
  const opened = store.open.getMockImplementation();
  store.open.mockImplementationOnce(
    (session: string, path: string) =>
      new Promise<string>((resolve) => {
        finish = (value) => resolve(value);
        void opened?.(session, path);
      }),
  );
  const { openDocument, showInFiles } = await mount();
  await show();
  await type('file');
  await key('Enter');
  await settle();
  expect(store.open).toHaveBeenCalledWith('session', 'src/file.ts');
  // The copy goes away while its file is still being read.
  fixture.copy = null;
  await act(async () => {
    window.dispatchEvent(new Event('corral:workspace-changed'));
  });
  await settle();
  expect(dialog()?.textContent).toContain(messages.Desktop.sourceFolder);
  await act(async () => finish(documentKey(target, 'src/file.ts')));
  await settle();
  expect(openDocument).not.toHaveBeenCalled();
  // The open no longer holds the dialog: the new target's result can be chosen.
  await key('Enter');
  await settle();
  expect(showInFiles).toHaveBeenCalledWith({
    sessionId: 'session',
    source: 'project',
    path: 'src/file.ts',
    kind: 'file',
  });
});

it('a file read that finishes after quick open is gone opens nothing', async () => {
  let finish: (key: string) => void = () => {};
  const store = fixture.owner as ReturnType<typeof owner>;
  store.open.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const { openDocument } = await mount();
  await show();
  await type('file');
  await key('Enter');
  await settle();
  expect(store.open).toHaveBeenCalledTimes(1);
  // The session view, and quick open with it, goes away before the read finishes.
  await disposals.splice(0).at(0)?.();
  const opened = documentKey(target, 'src/file.ts');
  store.setState({
    documents: { [opened]: { key: opened, target, path: 'src/file.ts', dirty: false } },
  });
  await act(async () => finish(opened));
  await settle();
  expect(openDocument).not.toHaveBeenCalled();
});

it('Enter without a result opens nothing; the typed text is never a path', async () => {
  fixture.search.mockImplementation(async () => ({ items: [], truncated: false }));
  const { openDocument, showInFiles } = await mount();
  await show();
  await type('../outside.ts');
  await key('Enter');
  await settle();
  expect(openDocument).not.toHaveBeenCalled();
  expect(showInFiles).not.toHaveBeenCalled();
  expect((fixture.owner as { open: ReturnType<typeof vi.fn> }).open).not.toHaveBeenCalled();
});

describe('searching while typing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const queries = () => fixture.search.mock.calls.map(([, query]) => query);
  async function begin() {
    await mount();
    await act(async () => {
      const opener = document.querySelector<HTMLButtonElement>('[data-testid="opener"]');
      opener?.focus();
      opener?.click();
    });
    await wait(0);
  }
  const compose = (type: 'compositionstart' | 'compositionend') =>
    act(async () => {
      input()?.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    });

  it('searches at once on opening, then once for a burst of keys, for the text typed last', async () => {
    await begin();
    expect(queries()).toEqual(['']);
    for (const text of ['s', 'sr', 'src']) {
      await press(text);
      await wait(SEARCH_DELAY / 3);
    }
    expect(queries()).toEqual(['']);
    await wait(SEARCH_DELAY);
    expect(queries()).toEqual(['', 'src']);
    expect(options()).toEqual(['src/file.ts', 'src/other.ts']);
  });

  it('an emptied query searches at once', async () => {
    await begin();
    await press('src');
    await wait(SEARCH_DELAY);
    await press('');
    await wait(0);
    expect(queries()).toEqual(['', 'src', '']);
  });

  it('a newer query aborts the search on its way; closing drops the one still waiting', async () => {
    const signals: AbortSignal[] = [];
    fixture.search.mockImplementation((_scope, _query, _limit, signal) => {
      if (signal) signals.push(signal);
      return new Promise<Search>(() => {});
    });
    await begin();
    await press('fi');
    await wait(SEARCH_DELAY);
    const sent = signals.at(-1);
    expect(queries()).toEqual(['', 'fi']);
    expect(sent?.aborted).toBe(false);
    await press('fil');
    expect(sent?.aborted).toBe(true);
    await key('Escape');
    // Past the search pause and the dialog's exit.
    await wait(500);
    expect(dialog()).toBeNull();
    expect(queries()).toEqual(['', 'fi']);
  });

  it('closing aborts the search on its way', async () => {
    const signals: AbortSignal[] = [];
    fixture.search.mockImplementation((_scope, _query, _limit, signal) => {
      if (signal) signals.push(signal);
      return new Promise<Search>(() => {});
    });
    await begin();
    await press('fi');
    await wait(SEARCH_DELAY);
    expect(signals.at(-1)?.aborted).toBe(false);
    await key('Escape');
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it('a late answer for an older query never shows', async () => {
    const answers: { query: string; resolve: (value: Search) => void }[] = [];
    fixture.search.mockImplementation(
      (_scope, query) =>
        new Promise<Search>((resolve) => {
          answers.push({ query, resolve });
        }),
    );
    await begin();
    await press('a');
    await wait(SEARCH_DELAY);
    await press('ab');
    await wait(SEARCH_DELAY);
    expect(answers.map((answer) => answer.query)).toEqual(['', 'a', 'ab']);
    await act(async () =>
      answers[2]?.resolve({ items: [{ path: 'ab.ts', kind: 'file' }], truncated: false }),
    );
    await act(async () =>
      answers[1]?.resolve({ items: [{ path: 'a-old.ts', kind: 'file' }], truncated: false }),
    );
    await wait(0);
    expect(options()).toEqual(['ab.ts']);
  });

  it('text being composed is searched once it is committed', async () => {
    await begin();
    await compose('compositionstart');
    for (const text of ['ㅍ', '파', '파이', '파일']) {
      await press(text);
      await wait(SEARCH_DELAY);
    }
    expect(queries()).toEqual(['']);
    await compose('compositionend');
    await wait(SEARCH_DELAY);
    expect(queries()).toEqual(['', '파일']);
  });
});

it('Escape closes it and returns focus to the control that opened it', async () => {
  await mount();
  await show();
  expect(document.activeElement).toBe(input());
  await key('Escape');
  await exited();
  expect(dialog()).toBeNull();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('opener');
});
