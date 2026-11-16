// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TopbarActions, TopbarSlotContext } from '../TopbarSlot.tsx';
import {
  FILE_VIEWER_WIDTH,
  FileViewerRow,
  useFileViewerPlacement,
  WORK_AREA_MIN_WIDTH,
} from './FileViewerBeside.tsx';

// workbench.md: the viewer sits beside the work area only while 560px remain for it, gives way
// when the room is gone and comes back when it returns. jsdom has no layout, so the row's width
// is the stubbed `clientWidth` and a resize is the observer firing.

const ROOM = WORK_AREA_MIN_WIDTH + FILE_VIEWER_WIDTH;
const layout = {
  width: 0,
  callbacks: new Set<ResizeObserverCallback>(),
  observed: [] as Element[],
};
class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element) {
    layout.observed.push(element);
    layout.callbacks.add(this.callback);
  }
  unobserve() {}
  disconnect() {
    layout.callbacks.delete(this.callback);
  }
}
const resize = (width: number) =>
  act(() => {
    layout.width = width;
    for (const callback of [...layout.callbacks])
      callback([], new FakeResizeObserver(() => {}) as unknown as ResizeObserver);
  });

const disposals: (() => void)[] = [];
beforeEach(() => {
  layout.width = 0;
  layout.callbacks.clear();
  layout.observed = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => layout.width);
});
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Mounted {
  host: HTMLElement;
  remembered: [string, boolean][];
  /** Commits of the page: a render React throws away for an unchanged state is not one. */
  commits: () => number;
  setProject: (projectId: string) => void;
  unmount: () => void;
}

/** The page's wiring: the top bar's button, the work area with a draft, the viewer's panel. */
async function mount({
  wanted = {},
  width,
  folded = false,
}: {
  /** The remembered wish per project, as useRemembered reads it. */
  wanted?: Record<string, boolean>;
  width: number;
  /** The top bar folds its tools into the more menu. */
  folded?: boolean;
}): Promise<Mounted> {
  layout.width = width;
  const host = document.createElement('div');
  const actions = document.createElement('div');
  topbar = actions;
  document.body.append(actions, host);
  const remembered: [string, boolean][] = [];
  let commits = 0;
  let setProject: (projectId: string) => void = () => {};
  function Page() {
    useLayoutEffect(() => {
      commits += 1;
    });
    const [projectId, changeProject] = useState('project');
    setProject = changeProject;
    const [wishes, setWishes] = useState(wanted);
    const viewer = useFileViewerPlacement(projectId, wishes[projectId] ?? false, (open) => {
      remembered.push([projectId, open]);
      setWishes((current) => ({ ...current, [projectId]: open }));
    });
    return (
      <>
        <TopbarActions>
          {folded ? null : (
            <button
              type="button"
              aria-label={viewer.open ? 'Close file viewer' : 'Open file viewer'}
              aria-pressed={viewer.open}
              onClick={() => viewer.toggle(!viewer.open)}
            />
          )}
          <button type="button" aria-label="Actions for Session" aria-haspopup="menu" />
        </TopbarActions>
        <FileViewerRow viewer={viewer} panel={<input aria-label="Viewer filter" defaultValue="" />}>
          <textarea aria-label="Request" defaultValue="" />
        </FileViewerRow>
      </>
    );
  }
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <TopbarSlotContext.Provider value={{ actions, views: null, crumbs: null }}>
          <Page />
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    );
  });
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => root.unmount());
    host.remove();
    actions.remove();
  };
  disposals.push(unmount);
  return {
    unmount,
    host,
    remembered,
    commits: () => commits,
    setProject: (projectId) => act(() => setProject(projectId)),
  };
}

let topbar: HTMLElement | null = null;
const viewerButton = () =>
  topbar?.querySelector<HTMLButtonElement>(
    'button[aria-label="Open file viewer"], button[aria-label="Close file viewer"]',
  ) ?? null;
const aside = () => document.querySelector<HTMLElement>('aside[aria-label="File viewer"]');
const workArea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]')
    ?.parentElement as HTMLElement;
const draft = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]');
const closeInViewer = () =>
  aside()?.querySelector<HTMLButtonElement>('button[aria-label="Close file viewer"]');
const click = (element: HTMLElement | null | undefined) =>
  act(() => {
    element?.click();
  });

/** What the screen shows: the viewer beside, away, covering the work area, or closed. */
function shown() {
  const viewer = aside();
  const viewerVisible = Boolean(viewer && !viewer.hidden);
  const workVisible = !workArea().classList.contains('hidden');
  if (!viewerVisible) return workVisible ? 'conversation only' : 'nothing';
  return workVisible ? 'beside' : 'covering';
}

it('keeps the viewer beside the work area while 560px remain for the work area', async () => {
  await mount({ wanted: { project: true }, width: ROOM });
  expect(shown()).toBe('beside');
  expect(aside()?.style.width).toBe(`${FILE_VIEWER_WIDTH}px`);
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('true');
  // The row is measured, not the window or the work area that the viewer narrows.
  expect(layout.observed).toEqual([workArea().parentElement]);
});

it('gives way when the row narrows, keeps the draft and the wish, and shows the button closed', async () => {
  const page = await mount({ wanted: { project: true }, width: 1200 });
  const request = draft() as HTMLTextAreaElement;
  act(() => {
    request.value = 'half a request';
  });
  await resize(ROOM - 1);
  expect(shown()).toBe('conversation only');
  expect(draft()).toBe(request);
  expect(draft()?.value).toBe('half a request');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('false');
  expect(viewerButton()?.getAttribute('aria-label')).toBe('Open file viewer');
  expect(page.remembered).toEqual([]);
});

it('comes back beside when the room returns, without anyone pressing anything', async () => {
  const page = await mount({ wanted: { project: true }, width: 1200 });
  await resize(800);
  expect(shown()).toBe('conversation only');
  await resize(ROOM);
  expect(shown()).toBe('beside');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(page.remembered).toEqual([]);
});

it('without room the button covers the work area, and closing returns to the same work area', async () => {
  const page = await mount({ width: 800 });
  const request = draft() as HTMLTextAreaElement;
  act(() => {
    request.value = 'kept';
  });
  expect(shown()).toBe('conversation only');
  await click(viewerButton());
  expect(shown()).toBe('covering');
  expect(aside()?.style.width).toBe('100%');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(page.remembered).toEqual([['project', true]]);
  await click(closeInViewer());
  expect(shown()).toBe('conversation only');
  expect(draft()).toBe(request);
  expect(draft()?.value).toBe('kept');
  expect(page.remembered).toEqual([
    ['project', true],
    ['project', false],
  ]);
  // The wish is cleared: room appearing later does not bring it back.
  await resize(1200);
  expect(shown()).toBe('conversation only');
});

it('pressing the button while the viewer is away covers the work area, and closing clears the wish', async () => {
  const page = await mount({ wanted: { project: true }, width: 800 });
  expect(shown()).toBe('conversation only');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('false');
  await click(viewerButton());
  expect(shown()).toBe('covering');
  // The wish was already remembered: saying it again changes nothing else.
  expect(page.remembered).toEqual([['project', true]]);
  await click(closeInViewer());
  expect(shown()).toBe('conversation only');
  expect(page.remembered.at(-1)).toEqual(['project', false]);
  await resize(1200);
  expect(shown()).toBe('conversation only');
});

it('a resize arriving after the page is gone does nothing', async () => {
  const page = await mount({ wanted: { project: true }, width: 1200 });
  page.unmount();
  expect(layout.callbacks.size).toBe(0);
  await resize(800);
  expect(aside()).toBeNull();
});

it('the top bar button closes a covering viewer too', async () => {
  const page = await mount({ width: 800 });
  await click(viewerButton());
  await click(viewerButton());
  expect(shown()).toBe('conversation only');
  expect(page.remembered.at(-1)).toEqual(['project', false]);
});

it('a covering viewer moves beside when room appears, and gives way when the room goes again', async () => {
  await mount({ width: 800 });
  await click(viewerButton());
  expect(shown()).toBe('covering');
  await resize(1200);
  expect(shown()).toBe('beside');
  expect(aside()?.style.width).toBe(`${FILE_VIEWER_WIDTH}px`);
  await resize(800);
  expect(shown()).toBe('conversation only');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('false');
});

it('a remembered viewer without room first paints the conversation, never the viewer', async () => {
  const changes: MutationRecord[] = [];
  const watch = new MutationObserver((records) => changes.push(...records));
  watch.observe(document.body, { attributes: true, subtree: true });
  const page = await mount({ wanted: { project: true }, width: 800 });
  changes.push(...watch.takeRecords());
  watch.disconnect();
  expect(shown()).toBe('conversation only');
  // The first commit is already the measured state: neither the viewer nor the work area changed.
  expect(
    changes.filter(
      (change) =>
        change.target === aside() ||
        change.target === workArea() ||
        change.target === workArea().parentElement,
    ),
  ).toEqual([]);
  // Mounted but away, so it is ready when room comes.
  expect(aside()?.hidden).toBe(true);
  expect(page.remembered).toEqual([]);
});

it('a remembered viewer with room is beside once mounted', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  expect(shown()).toBe('beside');
});

it('the viewer keeps its state while it is away', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  const filter = aside()?.querySelector('input') as HTMLInputElement;
  act(() => {
    filter.value = 'src/';
  });
  await resize(800);
  expect(aside()?.querySelector('input')).toBe(filter);
  await resize(1200);
  expect(aside()?.querySelector('input')).toBe(filter);
  expect(filter.value).toBe('src/');
});

it('focus inside the viewer moves to the top bar button when the viewer gives way', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  act(() => aside()?.querySelector('input')?.focus());
  await resize(800);
  expect(document.activeElement).toBe(viewerButton());
});

it('with the tools folded into the more menu, focus moves to that menu', async () => {
  await mount({ wanted: { project: true }, width: 1200, folded: true });
  act(() => aside()?.querySelector('input')?.focus());
  await resize(800);
  expect(document.activeElement).toBe(
    document.querySelector('button[aria-label="Actions for Session"]'),
  );
  expect(document.activeElement).not.toBe(document.body);
});

it('focus outside the viewer stays where it is when the viewer gives way', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  act(() => draft()?.focus());
  await resize(800);
  expect(document.activeElement).toBe(draft());
});

/** Focuses and presses, as a person's click or Enter on a focusable button does. */
const press = (element: HTMLElement | null | undefined) =>
  act(() => {
    element?.focus();
    element?.click();
  });

it("closing with the viewer's own X from beside moves focus to the top bar button", async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  await press(closeInViewer());
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(viewerButton());
});

it("closing with the viewer's own X while it covers moves focus to the top bar button", async () => {
  await mount({ width: 800 });
  await click(viewerButton());
  expect(shown()).toBe('covering');
  await press(closeInViewer());
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(viewerButton());
});

it('closing by a key press from inside the viewer moves focus to the top bar button', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  act(() => aside()?.querySelector('input')?.focus());
  // The shortcut closes without moving focus first.
  await click(viewerButton());
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(viewerButton());
});

it("closing inside a folded bar's viewer moves focus to the more menu", async () => {
  await mount({ wanted: { project: true }, width: 1200, folded: true });
  await press(closeInViewer());
  expect(document.activeElement).toBe(
    document.querySelector('button[aria-label="Actions for Session"]'),
  );
});

it('closing with the top bar button leaves focus on it', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  await press(viewerButton());
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(viewerButton());
});

it('closing while focus is in the composer leaves focus there', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  act(() => draft()?.focus());
  // The shortcut closes from wherever focus is.
  await click(viewerButton());
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(draft());
});

it('one state per measured width: the same width again changes nothing', async () => {
  const page = await mount({ wanted: { project: true }, width: 1200 });
  const settled = page.commits();
  await resize(1200);
  await resize(1300);
  expect(page.commits()).toBe(settled);
  await resize(800);
  const away = page.commits();
  await resize(800);
  await resize(700);
  expect(page.commits()).toBe(away);
  expect(shown()).toBe('conversation only');
});

it('rapid resizing across the edge ends in the state of the last width', async () => {
  const page = await mount({ wanted: { project: true }, width: 1200 });
  const before = page.commits();
  for (const width of [ROOM - 1, ROOM, ROOM - 1, ROOM, ROOM - 1]) await resize(width);
  expect(shown()).toBe('conversation only');
  // One commit per crossing, no more: nothing feeds back into the measurement.
  expect(page.commits() - before).toBe(5);
  expect(layout.observed).toHaveLength(1);
});

it("a covering viewer does not carry over to another project's remembered viewer", async () => {
  const page = await mount({ wanted: { other: true }, width: 800 });
  await click(viewerButton());
  expect(shown()).toBe('covering');
  await page.setProject('other');
  expect(shown()).toBe('conversation only');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('false');
});
