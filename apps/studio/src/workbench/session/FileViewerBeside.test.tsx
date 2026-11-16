// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TopbarActions, TopbarSlotContext } from '../TopbarSlot.tsx';
import {
  DRAWER_FULL_WIDTH_BELOW,
  FILE_VIEWER_WIDTH,
  FileViewerRow,
  useFileViewerPlacement,
  WORK_AREA_MIN_WIDTH,
} from './FileViewerBeside.tsx';

// workbench.md: the viewer sits beside the work area only while 560px remain for it, gives way
// when the room is gone and comes back when it returns; pressed without room, it opens as a
// drawer over the work area's right edge. jsdom has no layout, so the row's width is the stubbed
// `clientWidth` and a resize is the observer firing.

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
  /** How many times the head's refresh asked the panel to read the folder again. */
  refreshed: () => number;
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
  let refreshed = 0;
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
        <FileViewerRow
          viewer={viewer}
          panel={(head) => (
            <>
              {head(() => {
                refreshed += 1;
              })}
              <input aria-label="Viewer filter" defaultValue="" />
            </>
          )}
        >
          <textarea aria-label="Request" defaultValue="" />
          <button type="button">Work area action</button>
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
    refreshed: () => refreshed,
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
const scrim = () => document.querySelector<HTMLElement>('[data-file-viewer-scrim]');
const click = (element: HTMLElement | null | undefined) =>
  act(() => {
    element?.click();
  });
/** A key press as the browser sends it: React's handlers first, then the document's. */
const pressEscape = (target: EventTarget | null | undefined) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    target?.dispatchEvent(event);
  });
  return event;
};

/**
 * What the screen shows: the viewer beside, away, as a drawer over the work area, or closed. The
 * work area is never hidden: in a drawer it stays in place, inert, behind the scrim.
 */
function shown() {
  const viewer = aside();
  const viewerVisible = Boolean(viewer && !viewer.hidden);
  const work = workArea();
  if (work.hidden || work.classList.contains('hidden')) return 'nothing';
  if (!viewerVisible) return work.hasAttribute('inert') ? 'inert' : 'conversation only';
  if (!work.hasAttribute('inert')) return scrim() ? 'scrim without drawer' : 'beside';
  return scrim() ? 'drawer' : 'inert without scrim';
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

it('without room the button opens a drawer over the work area, which stays in place, and closing carries on', async () => {
  const page = await mount({ width: 800 });
  const request = draft() as HTMLTextAreaElement;
  const work = workArea();
  act(() => {
    request.value = 'kept';
  });
  expect(shown()).toBe('conversation only');
  await click(viewerButton());
  expect(shown()).toBe('drawer');
  // The same work area, still drawn and holding its draft, only out of reach behind the scrim.
  expect(workArea()).toBe(work);
  expect(draft()).toBe(request);
  expect(draft()?.value).toBe('kept');
  expect(work.hasAttribute('inert')).toBe(true);
  expect(work.contains(scrim())).toBe(false);
  expect(aside()?.contains(scrim())).toBe(false);
  expect(aside()?.style.width).toBe(`${FILE_VIEWER_WIDTH}px`);
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(page.remembered).toEqual([['project', true]]);
  await click(closeInViewer());
  expect(shown()).toBe('conversation only');
  expect(scrim()).toBeNull();
  expect(workArea()).toBe(work);
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

it('pressing the button while the viewer is away opens it as a drawer, and closing clears the wish', async () => {
  const page = await mount({ wanted: { project: true }, width: 800 });
  expect(shown()).toBe('conversation only');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('false');
  await click(viewerButton());
  expect(shown()).toBe('drawer');
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

it('the top bar button closes a drawer too', async () => {
  const page = await mount({ width: 800 });
  await click(viewerButton());
  expect(shown()).toBe('drawer');
  await click(viewerButton());
  expect(shown()).toBe('conversation only');
  expect(page.remembered.at(-1)).toEqual(['project', false]);
});

it('a drawer moves beside when room appears, as the same viewer, and gives way when the room goes again', async () => {
  await mount({ width: 800 });
  await click(viewerButton());
  expect(shown()).toBe('drawer');
  const viewer = aside();
  const filter = viewer?.querySelector('input') as HTMLInputElement;
  act(() => {
    filter.value = 'src/';
  });
  await resize(1200);
  expect(shown()).toBe('beside');
  expect(aside()).toBe(viewer);
  expect(aside()?.querySelector('input')).toBe(filter);
  expect(filter.value).toBe('src/');
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

it("closing a drawer opened from the top bar with the viewer's own X moves focus to the top bar button", async () => {
  await mount({ width: 800 });
  await press(viewerButton());
  expect(shown()).toBe('drawer');
  // Opened from the bar: focus stays on the bar's button, so there is nothing to come back to.
  expect(document.activeElement).toBe(viewerButton());
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

it("a drawer does not carry over to another project's remembered viewer", async () => {
  const page = await mount({ wanted: { other: true }, width: 800 });
  await click(viewerButton());
  expect(shown()).toBe('drawer');
  await page.setProject('other');
  expect(shown()).toBe('conversation only');
  expect(viewerButton()?.getAttribute('aria-pressed')).toBe('false');
});

it('a press on the scrim closes the drawer, and the work area carries on', async () => {
  const page = await mount({ width: 800 });
  await click(viewerButton());
  expect(shown()).toBe('drawer');
  await click(scrim());
  expect(shown()).toBe('conversation only');
  expect(workArea().hasAttribute('inert')).toBe(false);
  expect(page.remembered.at(-1)).toEqual(['project', false]);
});

it('a press on the scrim does not take focus from where it is', async () => {
  await mount({ width: 800 });
  await click(viewerButton());
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  act(() => {
    scrim()?.dispatchEvent(down);
  });
  expect(down.defaultPrevented).toBe(true);
});

it('Escape closes the drawer from inside it and from the top bar button', async () => {
  const page = await mount({ width: 800 });
  await click(viewerButton());
  const pressed = pressEscape(aside()?.querySelector('input'));
  expect(pressed.defaultPrevented).toBe(true);
  expect(shown()).toBe('conversation only');
  expect(page.remembered.at(-1)).toEqual(['project', false]);
  await press(viewerButton());
  expect(shown()).toBe('drawer');
  pressEscape(viewerButton());
  expect(shown()).toBe('conversation only');
});

it('Escape that something inside already handled, or that belongs to a popup, leaves the drawer open', async () => {
  await mount({ width: 800 });
  await click(viewerButton());
  const input = aside()?.querySelector('input') as HTMLInputElement;
  const handled = (event: Event) => event.preventDefault();
  input.addEventListener('keydown', handled);
  pressEscape(input);
  input.removeEventListener('keydown', handled);
  expect(shown()).toBe('drawer');
  // A menu or dialog opened from the viewer sits outside it and closes itself first.
  const popup = document.createElement('div');
  popup.setAttribute('role', 'menu');
  popup.tabIndex = -1;
  document.body.append(popup);
  disposals.push(() => popup.remove());
  pressEscape(popup);
  expect(shown()).toBe('drawer');
});

it('Escape while the viewer is beside leaves it beside', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  pressEscape(aside()?.querySelector('input'));
  expect(shown()).toBe('beside');
});

it('a row narrower than 640px gives the drawer its whole width', async () => {
  await mount({ width: DRAWER_FULL_WIDTH_BELOW - 1 });
  await click(viewerButton());
  expect(shown()).toBe('drawer');
  expect(aside()?.style.width).toBe('100%');
  await resize(DRAWER_FULL_WIDTH_BELOW);
  expect(shown()).toBe('drawer');
  expect(aside()?.style.width).toBe(`${FILE_VIEWER_WIDTH}px`);
  // Still one observer on the row for both edges.
  expect(layout.observed).toHaveLength(1);
});

it('losing the room while beside gives way and never opens a drawer by itself', async () => {
  await mount({ wanted: { project: true }, width: 1200 });
  await resize(DRAWER_FULL_WIDTH_BELOW - 1);
  expect(shown()).toBe('conversation only');
  expect(scrim()).toBeNull();
});

it('opened while focus is in the work area, the drawer takes focus and gives it back on close', async () => {
  await mount({ width: 800 });
  act(() => draft()?.focus());
  // The shortcut opens without moving focus first.
  await click(viewerButton());
  expect(shown()).toBe('drawer');
  expect(aside()?.contains(document.activeElement)).toBe(true);
  await press(closeInViewer());
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(draft());
});

it.each([
  ['Escape', () => pressEscape(document.activeElement)],
  ['the scrim', () => click(scrim())],
])('closed by %s, the drawer gives focus back to the work area', async (_how, close) => {
  await mount({ width: 800 });
  const action = document.querySelector<HTMLButtonElement>('button:not([aria-label])');
  act(() => action?.focus());
  await click(viewerButton());
  expect(aside()?.contains(document.activeElement)).toBe(true);
  await close();
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(action);
});

it('closed from the top bar button, the drawer leaves focus on that button', async () => {
  await mount({ width: 800 });
  act(() => draft()?.focus());
  await click(viewerButton());
  expect(aside()?.contains(document.activeElement)).toBe(true);
  await press(viewerButton());
  expect(shown()).toBe('conversation only');
  expect(document.activeElement).toBe(viewerButton());
});

it('a drawer that moved beside no longer sends focus back to the work area', async () => {
  await mount({ width: 800 });
  act(() => draft()?.focus());
  await click(viewerButton());
  await resize(1200);
  expect(shown()).toBe('beside');
  await press(closeInViewer());
  expect(document.activeElement).toBe(viewerButton());
});

it('the head is one row: the name, that it reads the source, refresh and close, once each', async () => {
  const page = await mount({ wanted: { project: true }, width: 1200 });
  const viewer = aside() as HTMLElement;
  const heading = viewer.querySelector('h2');
  expect(heading?.textContent).toBe(messages.Docking.fileViewer);
  expect(viewer.textContent).toContain(messages.Docking.fileViewerSource);
  const refresh = viewer.querySelectorAll<HTMLButtonElement>(
    `button[aria-label="${messages.Desktop.refreshFiles}"]`,
  );
  const close = viewer.querySelectorAll<HTMLButtonElement>(
    `button[aria-label="${messages.Docking.closeFileViewer}"]`,
  );
  expect(refresh).toHaveLength(1);
  expect(close).toHaveLength(1);
  // The name, the caption and both controls share one row.
  const row = heading?.parentElement;
  expect(row?.textContent).toContain(messages.Docking.fileViewerSource);
  expect(row?.contains(refresh[0] ?? null)).toBe(true);
  expect(row?.contains(close[0] ?? null)).toBe(true);
  await click(refresh[0]);
  expect(page.refreshed()).toBe(1);
});
