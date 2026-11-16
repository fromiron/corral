import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  return (
    <SidePanelFrame
      sideLabel="패널"
      sideWidth={400}
      drawerWidth={400}
      main={<Counted name="main" />}
      side={<Counted name="side" />}
      {...props}
    />
  );
}

function mainRegion(container: HTMLElement) {
  const main = container.querySelector<HTMLElement>('[data-slot="side-panel-main"]');
  if (!main) throw new Error('Missing the main region');
  return main;
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
