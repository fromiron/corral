// @vitest-environment jsdom
import { Activity, act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLineHold } from './settle.ts';

type Line = { approval: string | null; decide: boolean; waiting: boolean };

function Probe(line: Line) {
  const held = useLineHold(line);
  return <output>{held ? 'held' : 'free'}</output>;
}

// Frames run by hand: a frame is what paints, and each runs the callbacks waiting for it. A
// cancelled callback is taken out, as the browser does.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let strict = false;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  strict = false;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Under StrictMode, as the app runs in development: effects are cleaned up and run again on mount.
const show = (line: Line) =>
  act(() =>
    root.render(
      strict ? (
        <StrictMode>
          <Probe {...line} />
        </StrictMode>
      ) : (
        <Probe {...line} />
      ),
    ),
  );
const paint = () =>
  act(() => {
    const waiting = [...frames.values()];
    frames = new Map();
    for (const callback of waiting) callback(performance.now());
  });
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const held = () => container.textContent === 'held';

const view: Line = { approval: 'a', decide: false, waiting: true };
const buttons: Line = { approval: 'a', decide: true, waiting: true };
const away: Line = { approval: null, decide: false, waiting: false };

/** View alone painted, then the buttons: held from here. */
async function heldAfterView() {
  show(view);
  paint();
  show(buttons);
  expect(held()).toBe(true);
}

it('counts the wait from the frame that paints the buttons, however late it is', async () => {
  await heldAfterView();
  // No frame yet: the buttons are not on screen, and the clock has not started.
  wait(1000);
  expect(held()).toBe(true);
  paint();
  wait(599);
  expect(held()).toBe(true);
  wait(1);
  expect(held()).toBe(false);
});

it.each([
  ['their View', view],
  ['nothing', away],
])('counts again from each return of buttons that left for %s while held', async (_name, gone) => {
  await heldAfterView();
  paint();
  for (let round = 0; round < 2; round += 1) {
    wait(200);
    show(gone);
    paint();
    show(buttons);
    expect(held()).toBe(true);
    paint();
  }
  // 400 ms after the first came, 0 after the last return: the whole wait again.
  wait(599);
  expect(held()).toBe(true);
  wait(1);
  expect(held()).toBe(false);
});

it('waits for one frame at a time, however often it renders before the frame', async () => {
  show(view);
  for (let render = 0; render < 10; render += 1) show({ ...view, approval: 'a' });
  show(buttons);
  show(view);
  expect(frames.size).toBe(1);
});

it('takes buttons at once where the line was elsewhere for a painted frame since its View', async () => {
  show(view);
  paint();
  // The line leaves (its card in view) and a frame paints it gone: View is no longer what was
  // there before the buttons.
  show(away);
  paint();
  show(buttons);
  expect(held()).toBe(false);
});

it('takes the first buttons at once when no frame painted View alone before them', async () => {
  show(view);
  show(buttons);
  paint();
  expect(held()).toBe(false);
});

it('under StrictMode, lets another approval go a frame and the wait after it comes', async () => {
  strict = true;
  show(buttons);
  paint();
  show({ approval: 'b', decide: true, waiting: true });
  expect(held()).toBe(true);
  paint();
  wait(599);
  expect(held()).toBe(true);
  wait(1);
  expect(held()).toBe(false);
});

it('under StrictMode, holds buttons that come where View was painted', async () => {
  strict = true;
  show(view);
  paint();
  show(buttons);
  expect(held()).toBe(true);
});

it('counts a wait that was counting again from the frame that paints it shown again', async () => {
  const place = (line: Line, visible: boolean) =>
    act(() =>
      root.render(
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <Probe {...line} />
        </Activity>,
      ),
    );
  const next: Line = { approval: 'b', decide: true, waiting: true };
  place(buttons, true);
  paint();
  place(next, true);
  paint();
  wait(300);
  // Hidden while it counts: its effects are cleaned up, and nothing of it is on screen.
  place(next, false);
  paint();
  wait(1000);
  // Shown again: held, and the whole wait counts from the frame that paints it.
  place(next, true);
  expect(held()).toBe(true);
  wait(1000);
  expect(held()).toBe(true);
  paint();
  wait(599);
  expect(held()).toBe(true);
  wait(1);
  expect(held()).toBe(false);
});
