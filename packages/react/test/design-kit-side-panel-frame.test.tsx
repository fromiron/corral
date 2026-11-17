import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SidePanelFrame,
  type SidePanelFrameProps,
  type SidePanelPresentation,
} from '../src/design-kit/adapters/side-panel-frame.tsx';

// session-panel.md: the conversation and the panel in five presentations. Only a drawer or a
// maximized panel takes the conversation out of use; the frame reports its own width and leaves
// the presentation to the host.

const presentations: SidePanelPresentation[] = [
  'closed',
  'beside',
  'maximized',
  'drawer',
  'withdrawn',
];

// A browser runs the drawer's slides on the Web Animations API; jsdom has none, so motion takes its
// frame-loop fallback. This stand-in serves the cases that switch it on, and throws for the rest,
// which then take that same fallback. Motion checks for `animate` once, so it is in place first.
class StandInAnimation {
  playState: AnimationPlayState = 'running';
  startTime: number | null = null;
  currentTime: number | null = 0;
  playbackRate = 1;
  /** Never called: the page draws no frames for it, as a hidden window does not. */
  onfinish: (() => void) | null = null;
  readonly effect = { getComputedTiming: () => ({ duration: 0 }), updateTiming() {} };
  /** The play state when the slide was cancelled. */
  cancelledWhile: AnimationPlayState | null = null;
  readonly keyframes: Keyframe[] | PropertyIndexedKeyframes | null;
  constructor(keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    this.keyframes = keyframes;
  }
  cancel() {
    this.cancelledWhile ??= this.playState;
    this.playState = 'idle';
  }
  pause() {
    this.playState = 'paused';
  }
  play() {
    this.playState = 'running';
  }
  finish() {}
  commitStyles() {}
}
const waapi = { on: false, started: [] as StandInAnimation[] };
Object.defineProperty(Element.prototype, 'animate', {
  configurable: true,
  writable: true,
  value(keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    if (!waapi.on) throw new Error('jsdom has no Web Animations');
    const animation = new StandInAnimation(keyframes);
    waapi.started.push(animation);
    return animation;
  },
});
afterAll(() => {
  delete (Element.prototype as { animate?: unknown }).animate;
});
/** The slide motion started on the side, on the stand-in. */
function slide() {
  return waapi.started.find(
    (animation) =>
      !!animation.keyframes &&
      !Array.isArray(animation.keyframes) &&
      'transform' in animation.keyframes,
  );
}
/** Lets motion's frame loop run. */
async function frames(count: number) {
  await act(async () => {
    for (let i = 0; i < count; i += 1) {
      await new Promise((done) => requestAnimationFrame(() => done(null)));
    }
  });
}

let frameWidth = 1200;
const resizeCallbacks = new Set<() => void>();
const OriginalResizeObserver = globalThis.ResizeObserver;
/** Runs every observer, as a resize of the frame would. */
function resize(width: number) {
  frameWidth = width;
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
}
beforeEach(() => {
  frameWidth = 1200;
  globalThis.ResizeObserver = class {
    private readonly run: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.run = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {
      resizeCallbacks.add(this.run);
    }
    unobserve() {}
    disconnect() {
      resizeCallbacks.delete(this.run);
    }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.slot === 'side-panel-frame' ? frameWidth : 0;
    },
  });
});
afterEach(() => {
  waapi.on = false;
  waapi.started.length = 0;
  globalThis.ResizeObserver = OriginalResizeObserver;
  resizeCallbacks.clear();
  // Restores jsdom's own prototype getter.
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

const mounts = { main: 0, side: 0 };
function Counted({ name }: { name: 'main' | 'side' }) {
  useEffect(() => {
    mounts[name] += 1;
  }, [name]);
  return <button type="button">{name === 'main' ? '대화 단추' : '패널 단추'}</button>;
}

function frame(props: Partial<SidePanelFrameProps> & { presentation: SidePanelPresentation }) {
  const all = {
    sideLabel: '패널',
    sideWidth: 400,
    drawerWidth: 400,
    main: <Counted name="main" />,
    side: <Counted name="side" />,
    ...props,
  };
  // A bottom comes with its label and height; `dock()` gives them together.
  return <SidePanelFrame {...(all as SidePanelFrameProps)} />;
}

function mainRegion(container: HTMLElement) {
  const main = container.querySelector<HTMLElement>('[data-slot="side-panel-main"]');
  if (!main) throw new Error('Missing the main region');
  return main;
}

/** The side by its slot: off screen it is out of the accessibility tree. */
function sideRegion(container: HTMLElement) {
  const side = container.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
  if (!side) throw new Error('Missing the side region');
  return side;
}

it('takes the main region out of use only in drawer and maximized', () => {
  const view = render(frame({ presentation: 'closed' }));
  for (const presentation of presentations) {
    view.rerender(frame({ presentation }));
    const main = mainRegion(view.container);
    const out = presentation === 'drawer' || presentation === 'maximized';
    expect(main.hasAttribute('inert'), presentation).toBe(out);
    if (presentation === 'maximized') expect(main).not.toBeVisible();
    else expect(main, presentation).toBeVisible();
  }
});

it('shows the side as a named region where it is on screen', () => {
  const view = render(frame({ presentation: 'beside', keepSideMounted: true }));
  for (const presentation of [...presentations, 'drawer', 'closed'] as const) {
    view.rerender(frame({ presentation, keepSideMounted: true }));
    const onScreen =
      presentation === 'beside' || presentation === 'maximized' || presentation === 'drawer';
    // A drawer sliding away is already out of the accessibility tree.
    if (onScreen) expect(screen.getByRole('region', { name: '패널' }), presentation).toBeVisible();
    else expect(screen.queryByRole('region', { name: '패널' }), presentation).toBeNull();
  }
});

it('keeps both regions mounted across every presentation but closed', () => {
  mounts.main = 0;
  mounts.side = 0;
  const view = render(frame({ presentation: 'beside' }));
  for (const presentation of [
    'drawer',
    'maximized',
    'withdrawn',
    'beside',
    'drawer',
    'withdrawn',
    'maximized',
  ] as const) {
    view.rerender(frame({ presentation }));
  }
  expect(mounts).toEqual({ main: 1, side: 1 });
});

it('keeps the side mounted while closed unless the host lets it go', async () => {
  mounts.main = 0;
  mounts.side = 0;
  const view = render(frame({ presentation: 'beside' }));
  view.rerender(frame({ presentation: 'closed' }));
  expect(screen.getByText('패널 단추')).not.toBeVisible();
  view.rerender(frame({ presentation: 'drawer' }));
  view.rerender(frame({ presentation: 'closed' }));
  view.rerender(frame({ presentation: 'beside' }));
  await waitFor(() => expect(screen.getByText('패널 단추')).toBeVisible());
  expect(mounts).toEqual({ main: 1, side: 1 });

  mounts.main = 0;
  mounts.side = 0;
  view.unmount();
  const released = render(frame({ presentation: 'beside', keepSideMounted: false }));
  released.rerender(frame({ presentation: 'closed', keepSideMounted: false }));
  expect(screen.queryByText('패널 단추')).toBeNull();
  released.rerender(frame({ presentation: 'beside', keepSideMounted: false }));
  expect(mounts).toEqual({ main: 1, side: 2 });
});

it('paints nothing of a side that is not on screen, and keeps its width', () => {
  const view = render(frame({ presentation: 'beside' }));
  for (const presentation of presentations) {
    // From beside, so a closing drawer's slide does not stand in for the settled state.
    view.rerender(frame({ presentation: 'beside' }));
    view.rerender(frame({ presentation }));
    const side = sideRegion(view.container);
    if (presentation === 'closed' || presentation === 'withdrawn') {
      expect(side.style.visibility, presentation).toBe('hidden');
      expect(side.style.opacity, presentation).toBe('0');
      expect(side.style.width, presentation).toBe('400px');
      expect(side, presentation).toHaveAttribute('inert');
    } else {
      expect(side.style.opacity, presentation).toBe('');
    }
  }
});

it('leaves the opacity alone while a drawer slides away', async () => {
  const view = render(frame({ presentation: 'drawer' }));
  view.rerender(frame({ presentation: 'closed' }));
  const side = sideRegion(view.container);
  expect(side).toHaveAttribute('data-presentation', 'leaving');
  expect(side.style.opacity).toBe('');
  await waitFor(() => expect(side).toHaveAttribute('data-presentation', 'closed'));
  expect(side.style.opacity).toBe('0');
});

it('paints nothing of a closed side whose content declares itself visible', () => {
  const view = render(
    frame({
      presentation: 'closed',
      side: (
        <div className="visible" style={{ visibility: 'visible' }}>
          독 탭
        </div>
      ),
    }),
  );
  // jsdom computes no paint: the rule is held by the side's own opacity, which no descendant undoes.
  expect(screen.getByText('독 탭').style.visibility).toBe('visible');
  expect(sideRegion(view.container).style.opacity).toBe('0');
});

it('leaves no transform on the side after the fallback cuts a slide out short', async () => {
  waapi.on = true;
  const view = render(frame({ presentation: 'drawer' }));
  view.rerender(frame({ presentation: 'closed' }));
  const side = sideRegion(view.container);
  // No frame finishes the slide, so the fallback ends it.
  await waitFor(() => expect(side).toHaveAttribute('data-presentation', 'closed'));
  await frames(2);
  expect(slide()?.keyframes).toMatchObject({ transform: ['translateX(0%)', 'translateX(100%)'] });
  expect(slide()?.cancelledWhile).toBe('running');
  view.rerender(frame({ presentation: 'beside' }));
  await frames(2);
  expect(side.style.transform).toBe('');
});

it('leaves no transform on the side when a drawer turns beside while sliding in', async () => {
  waapi.on = true;
  const view = render(frame({ presentation: 'closed' }));
  view.rerender(frame({ presentation: 'drawer' }));
  const side = sideRegion(view.container);
  await frames(2);
  expect(slide()?.keyframes).toMatchObject({ transform: ['translateX(100%)', 'translateX(0%)'] });
  view.rerender(frame({ presentation: 'beside' }));
  await frames(2);
  expect(slide()?.cancelledWhile).toBe('running');
  expect(side.style.transform).toBe('');
});

it('dims only the main region in a drawer and reports a press on it', () => {
  const onScrimPress = vi.fn();
  const view = render(frame({ presentation: 'beside', onScrimPress }));
  expect(view.container.querySelector('[data-slot="side-panel-scrim"]')).toBeNull();
  view.rerender(frame({ presentation: 'drawer', onScrimPress }));
  const scrim = view.container.querySelector<HTMLElement>('[data-slot="side-panel-scrim"]');
  expect(scrim).not.toBeNull();
  expect(scrim).toHaveAttribute('aria-hidden', 'true');
  // The scrim covers the main region, not the frame or anything outside it.
  expect(scrim?.parentElement?.contains(mainRegion(view.container))).toBe(true);
  expect(scrim?.parentElement?.contains(screen.getByRole('region', { name: '패널' }))).toBe(false);
  fireEvent.click(scrim as HTMLElement);
  expect(onScrimPress).toHaveBeenCalledTimes(1);
});

it('reports Escape in a drawer unless it was handled or composing', () => {
  const onEscape = vi.fn();
  const view = render(frame({ presentation: 'drawer', onEscape }));
  const button = screen.getByText('패널 단추');
  button.focus();
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(onEscape).toHaveBeenCalledTimes(1);

  // An IME composition keeps its Escape.
  fireEvent.keyDown(button, { key: 'Escape', isComposing: true });
  fireEvent.keyDown(button, { key: 'Escape', keyCode: 229 });
  expect(onEscape).toHaveBeenCalledTimes(1);

  // A popup's own document listener, registered after the frame's, closes itself first.
  const popup = (event: KeyboardEvent) => {
    if (event.key === 'Escape') event.preventDefault();
  };
  document.addEventListener('keydown', popup);
  fireEvent.keyDown(button, { key: 'Escape' });
  document.removeEventListener('keydown', popup);
  expect(onEscape).toHaveBeenCalledTimes(1);

  // Other keys, and Escape in other presentations, are not the frame's.
  fireEvent.keyDown(button, { key: 'Enter' });
  for (const presentation of ['beside', 'maximized', 'withdrawn', 'closed'] as const) {
    view.rerender(frame({ presentation, onEscape }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
  }
  expect(onEscape).toHaveBeenCalledTimes(1);
});

it('reports its own width to the host', () => {
  const onFrameWidthChange = vi.fn();
  frameWidth = 900;
  render(frame({ presentation: 'closed', onFrameWidthChange }));
  expect(onFrameWidthChange).toHaveBeenLastCalledWith(900);
  resize(500);
  expect(onFrameWidthChange).toHaveBeenLastCalledWith(500);
  expect(onFrameWidthChange).toHaveBeenCalledTimes(2);
});

it('gives a drawer the width the host asks for, never wider than the frame', () => {
  const view = render(frame({ presentation: 'drawer', drawerWidth: 400 }));
  const side = () => screen.getByRole('region', { name: '패널' });
  expect(side().style.width).toBe('400px');
  expect(side().style.maxWidth).toBe('100%');
  // A drawer narrower than the frame draws its edge over main; one as wide does not.
  expect(side()).not.toHaveAttribute('data-full');
  resize(380);
  expect(side()).toHaveAttribute('data-full');
  view.rerender(frame({ presentation: 'drawer', drawerWidth: 380 }));
  expect(side()).toHaveAttribute('data-full');
  resize(1200);
  expect(side()).not.toHaveAttribute('data-full');
});

it('lets a press through the scrim while it fades away', () => {
  const onScrimPress = vi.fn();
  const view = render(frame({ presentation: 'drawer', onScrimPress }));
  view.rerender(frame({ presentation: 'closed', onScrimPress }));
  const scrim = view.container.querySelector<HTMLElement>('[data-slot="side-panel-scrim"]');
  expect(scrim).not.toBeNull();
  expect(scrim?.style.pointerEvents).toBe('none');
  fireEvent.click(scrim as HTMLElement);
  expect(onScrimPress).not.toHaveBeenCalled();
});

it('says on its root when the splitter is being dragged', () => {
  const onDragChange = vi.fn();
  const resizeProps = { min: 360, max: 640, onChange: () => {}, onDragChange, 'aria-label': '폭' };
  const view = render(frame({ presentation: 'beside', resize: resizeProps }));
  const root = view.container.querySelector('[data-slot="side-panel-frame"]');
  const splitter = screen.getByRole('separator');
  splitter.setPointerCapture = () => {};
  splitter.releasePointerCapture = () => {};
  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 480 });
  expect(root).toHaveAttribute('data-resizing');
  expect(onDragChange).toHaveBeenLastCalledWith(true);
  fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 480 });
  expect(root).not.toHaveAttribute('data-resizing');
  expect(onDragChange).toHaveBeenLastCalledWith(false);
});

it('renders the splitter only beside, with the side width as its value', () => {
  const onChange = vi.fn();
  const resize = { min: 360, max: 640, onChange, 'aria-label': '패널 폭' };
  const view = render(frame({ presentation: 'beside', resize }));
  const splitter = screen.getByRole('separator', { name: '패널 폭' });
  expect(splitter).toHaveAttribute('aria-valuenow', '400');
  for (const presentation of ['drawer', 'maximized', 'withdrawn', 'closed'] as const) {
    view.rerender(frame({ presentation, resize }));
    expect(screen.queryByRole('separator'), presentation).toBeNull();
  }
});

it('moves the focus into the side when the main region holding it is taken out of use', () => {
  const view = render(frame({ presentation: 'closed' }));
  const inMain = screen.getByText('대화 단추');
  inMain.focus();
  act(() => view.rerender(frame({ presentation: 'drawer' })));
  expect(screen.getByRole('region', { name: '패널' })).toHaveFocus();
});

it('leaves the focus where it is when it was outside the frame', () => {
  const view = render(
    <>
      <button type="button">사이드바 단추</button>
      {frame({ presentation: 'closed' })}
    </>,
  );
  const outside = screen.getByText('사이드바 단추');
  outside.focus();
  act(() =>
    view.rerender(
      <>
        <button type="button">사이드바 단추</button>
        {frame({ presentation: 'drawer' })}
      </>,
    ),
  );
  expect(outside).toHaveFocus();
});

// session-panel S4: a dock under both regions. A drawer and its scrim cover it and take it out of
// use; a maximized side covers main only. The shown height yields so main keeps its least height.

describe('a bottom region', () => {
  let frameHeight = 0;
  beforeEach(() => {
    frameHeight = 0;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.slot === 'side-panel-frame' ? frameHeight : 0;
      },
    });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });
  function resizeHeight(height: number) {
    frameHeight = height;
    act(() => {
      for (const callback of resizeCallbacks) callback();
    });
  }

  const dock = (props: Partial<SidePanelFrameProps> & { presentation: SidePanelPresentation }) =>
    frame({
      bottom: <button type="button">도크 단추</button>,
      bottomLabel: '도크',
      bottomHeight: 240,
      ...props,
    } as SidePanelFrameProps);
  const bottomRegion = (container: HTMLElement) => {
    const bottom = container.querySelector<HTMLElement>('[data-slot="side-panel-bottom"]');
    if (!bottom) throw new Error('Missing the bottom region');
    return bottom;
  };
  const bottomArea = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-slot="side-panel-bottom-area"]');

  it('lays a named region under main and the side, at the host’s height', () => {
    const view = render(dock({ presentation: 'beside' }));
    const bottom = screen.getByRole('region', { name: '도크' });
    expect(bottom).toBe(bottomRegion(view.container));
    expect(bottom.style.height).toBe('240px');
    expect(mainRegion(view.container).contains(bottom)).toBe(false);
    expect(sideRegion(view.container).contains(bottom)).toBe(false);
    // Under both: main and the side share a row the bottom is not in.
    const row = mainRegion(view.container).closest('[data-slot="side-panel-row"]');
    expect(row?.contains(sideRegion(view.container))).toBe(true);
    expect(row?.contains(bottom)).toBe(false);
  });

  it('is taken out of use in a drawer only, under the scrim', () => {
    const view = render(dock({ presentation: 'beside' }));
    for (const presentation of presentations) {
      view.rerender(dock({ presentation }));
      expect(bottomArea(view.container)?.hasAttribute('inert'), presentation).toBe(
        presentation === 'drawer',
      );
    }
    view.rerender(dock({ presentation: 'drawer' }));
    const scrim = view.container.querySelector<HTMLElement>('[data-slot="side-panel-scrim"]');
    const root = view.container.querySelector('[data-slot="side-panel-frame"]');
    // The scrim lies over main and the bottom, under the drawer.
    expect(scrim?.parentElement).toBe(root);
    // Positioned against the frame, so the drawer spans the bottom too.
    const row = view.container.querySelector<HTMLElement>('[data-slot="side-panel-row"]');
    expect(row?.classList.contains('relative')).toBe(false);
    view.rerender(dock({ presentation: 'maximized' }));
    // Maximized, the side covers main's row only.
    expect(row?.classList.contains('relative')).toBe(true);
    expect(mainRegion(view.container)).toHaveAttribute('inert');
    expect(bottomArea(view.container)).not.toHaveAttribute('inert');
  });

  it('adds and removes the bottom region without remounting main or the side', () => {
    mounts.main = 0;
    mounts.side = 0;
    const view = render(frame({ presentation: 'beside' }));
    view.rerender(dock({ presentation: 'beside' }));
    view.rerender(frame({ presentation: 'beside' }));
    expect(mounts).toEqual({ main: 1, side: 1 });
    expect(bottomArea(view.container)).toBeNull();
  });

  it('yields the shown height so main keeps its least height, leaving the host’s height alone', () => {
    const onShown = vi.fn();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    frameHeight = 600;
    render(
      dock({
        presentation: 'beside',
        bottomHeight: 500,
        mainMinHeight: 160,
        onShownBottomHeightChange: onShown,
        bottomResize: { min: 120, max: 560, onChange, onCommit, 'aria-label': '도크 높이' },
      }),
    );
    const bottom = screen.getByRole('region', { name: '도크' });
    expect(bottom.style.height).toBe('440px');
    expect(onShown).toHaveBeenLastCalledWith(440);
    const splitter = screen.getByRole('separator', { name: '도크 높이' });
    expect(splitter).toHaveAttribute('aria-orientation', 'horizontal');
    expect(splitter).toHaveAttribute('aria-valuenow', '440');
    expect(splitter).toHaveAttribute('aria-valuemax', '440');
    resizeHeight(900);
    expect(bottom.style.height).toBe('500px');
    expect(onShown).toHaveBeenLastCalledWith(500);
    expect(screen.getByRole('separator', { name: '도크 높이' })).toHaveAttribute(
      'aria-valuemax',
      '560',
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('hides a bottom yielded to nothing, splitter and all', () => {
    const onShown = vi.fn();
    frameHeight = 150;
    const view = render(
      dock({
        presentation: 'beside',
        mainMinHeight: 160,
        onShownBottomHeightChange: onShown,
        bottomResize: { min: 120, max: 560, onChange: () => {}, 'aria-label': '도크 높이' },
      }),
    );
    expect(onShown).toHaveBeenLastCalledWith(0);
    const bottom = bottomRegion(view.container);
    expect(bottom).toHaveAttribute('data-state', 'withdrawn');
    expect(bottom.style.visibility).toBe('hidden');
    expect(bottom).toHaveAttribute('inert');
    expect(screen.queryByRole('separator', { name: '도크 높이' })).toBeNull();
  });

  it('withdraws a bottom that would be shown under its least height, and brings it back when there is room', () => {
    const onShown = vi.fn();
    const onWithdrawn = vi.fn();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    frameHeight = 600;
    const props = {
      presentation: 'beside' as const,
      mainMinHeight: 160,
      bottomMinHeight: 120,
      onShownBottomHeightChange: onShown,
      onBottomWithdrawnChange: onWithdrawn,
      bottomResize: { min: 120, max: 560, onChange, onCommit, 'aria-label': '도크 높이' },
    };
    const view = render(dock(props));
    const bottom = bottomRegion(view.container);
    expect(bottom).toHaveAttribute('data-state', 'open');
    expect(bottom.style.height).toBe('240px');
    expect(onWithdrawn).toHaveBeenLastCalledWith(false);
    // Exactly its least height: still shown, at that height.
    resizeHeight(280);
    expect(bottom).toHaveAttribute('data-state', 'open');
    expect(bottom.style.height).toBe('120px');
    expect(onShown).toHaveBeenLastCalledWith(120);
    expect(screen.getByRole('separator', { name: '도크 높이' })).toHaveAttribute(
      'aria-valuenow',
      '120',
    );
    // One pixel less: withdrawn, not drawn, at the host's height out of the flow.
    resizeHeight(279);
    expect(bottom).toHaveAttribute('data-state', 'withdrawn');
    expect(bottom.style.visibility).toBe('hidden');
    expect(bottom.style.height).toBe('240px');
    expect(bottom.classList.contains('absolute')).toBe(true);
    expect(bottom).toHaveAttribute('inert');
    expect(screen.queryByRole('separator', { name: '도크 높이' })).toBeNull();
    expect(onShown).toHaveBeenLastCalledWith(0);
    expect(onWithdrawn).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('도크 단추')).toBeInTheDocument();
    // Room again: back at the host's height.
    resizeHeight(600);
    expect(bottom).toHaveAttribute('data-state', 'open');
    expect(bottom.style.height).toBe('240px');
    expect(bottom.style.visibility).toBe('');
    expect(onShown).toHaveBeenLastCalledWith(240);
    expect(onWithdrawn).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('separator', { name: '도크 높이' })).toBeInTheDocument();
    expect(onWithdrawn).toHaveBeenCalledTimes(3);
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('never calls a closed bottom withdrawn, however little room there is', () => {
    const onWithdrawn = vi.fn();
    frameHeight = 200;
    const view = render(
      dock({
        presentation: 'beside',
        bottomOpen: false,
        mainMinHeight: 160,
        bottomMinHeight: 120,
        onBottomWithdrawnChange: onWithdrawn,
      }),
    );
    expect(bottomRegion(view.container)).toHaveAttribute('data-state', 'closed');
    expect(onWithdrawn).not.toHaveBeenCalledWith(true);
  });

  it('keeps a closed bottom mounted, hidden and out of the flow at its height', () => {
    const view = render(dock({ presentation: 'beside', bottomOpen: false }));
    const bottom = bottomRegion(view.container);
    expect(bottom.style.visibility).toBe('hidden');
    expect(bottom.style.height).toBe('240px');
    expect(bottom).toHaveAttribute('inert');
    expect(bottom.classList.contains('absolute')).toBe(true);
    expect(screen.getByText('도크 단추')).toBeInTheDocument();
  });

  it('moves the focus into the side when the bottom holding it is taken out of use', () => {
    for (const from of ['beside', 'maximized'] as const) {
      const view = render(dock({ presentation: from }));
      screen.getByText('도크 단추').focus();
      act(() => view.rerender(dock({ presentation: 'drawer' })));
      expect(screen.getByRole('region', { name: '패널' }), from).toHaveFocus();
      view.unmount();
    }
  });

  it('leaves the focus to the host when a bottom holding it closes', () => {
    const view = render(dock({ presentation: 'beside' }));
    screen.getByText('도크 단추').focus();
    act(() => view.rerender(dock({ presentation: 'beside', bottomOpen: false })));
    expect(screen.getByRole('region', { name: '패널' })).not.toHaveFocus();
  });

  it('says on its root while the bottom splitter is dragged', () => {
    const view = render(
      dock({
        presentation: 'beside',
        bottomResize: { min: 120, max: 400, onChange: () => {}, 'aria-label': '도크 높이' },
      }),
    );
    const root = view.container.querySelector('[data-slot="side-panel-frame"]');
    const splitter = screen.getByRole('separator', { name: '도크 높이' });
    splitter.setPointerCapture = () => {};
    splitter.releasePointerCapture = () => {};
    fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, buttons: 1, clientY: 500 });
    fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientY: 480 });
    expect(root).toHaveAttribute('data-resizing');
    fireEvent.pointerUp(splitter, { pointerId: 1, clientY: 480 });
    expect(root).not.toHaveAttribute('data-resizing');
  });
});
