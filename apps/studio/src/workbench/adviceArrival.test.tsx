// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type AdviceArrivalValue, adviceOffset, useAdviceArrivalRequest } from './adviceArrival.ts';

// Arriving to read an advice (features/inbox.md `advice`): the address asks once, the conversation
// comes to the front and the address lets the request go, and the advice's words are brought
// where the person sees them, above a floating composer.

const cleanup: (() => void)[] = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

async function arrive() {
  const open = vi.fn();
  const consume = vi.fn();
  let value: AdviceArrivalValue | null = null;
  let requested: string | undefined;
  function Probe({ advice }: { advice: string | undefined }) {
    value = useAdviceArrivalRequest(advice, { open, consume });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  cleanup.push(() => root.unmount());
  const ask = (advice: string | undefined) => {
    requested = advice;
    return act(async () => root.render(<Probe advice={requested} />));
  };
  await ask(undefined);
  return { open, consume, ask, value: () => value as AdviceArrivalValue | null };
}

it('takes a request from the address once: the conversation opens and the address lets it go', async () => {
  const f = await arrive();
  expect(f.value()).toBeNull();
  await f.ask('run_a');
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.consume).toHaveBeenCalledTimes(1);
  expect(f.value()).toMatchObject({ runId: 'run_a', key: 1 });
  // The address no longer asks; the arrival stays until its row has taken it.
  await f.ask(undefined);
  expect(f.value()).toMatchObject({ runId: 'run_a', key: 1 });
  await act(async () => f.value()?.done());
  expect(f.value()).toBeNull();
});

it('arrives again at the same run when asked again, and an old arrival’s end leaves the new one', async () => {
  const f = await arrive();
  await f.ask('run_a');
  const first = f.value();
  await f.ask(undefined);
  await f.ask('run_a');
  expect(f.value()).toMatchObject({ runId: 'run_a', key: 2 });
  expect(f.open).toHaveBeenCalledTimes(2);
  await act(async () => first?.done());
  expect(f.value()).toMatchObject({ key: 2 });
});

const frame = { top: 60, bottom: 600, margin: 16 };

it('moves a row so its advice’s words end above the composer, however long the answer above', () => {
  // The answer is longer than the view: the words are far below it.
  expect(adviceOffset({ ...frame, rowTop: 60, wordsTop: 2594, wordsBottom: 2630 })).toBe(-2046);
});

it('leaves a row where it is when its words are already in view', () => {
  expect(adviceOffset({ ...frame, rowTop: 100, wordsTop: 300, wordsBottom: 360 })).toBeNull();
});

it('keeps the words’ first line in view when they are taller than the room', () => {
  // Shifting their end above the composer would take their start above the view.
  expect(adviceOffset({ ...frame, rowTop: 40, wordsTop: 100, wordsBottom: 1500 })).toBe(-44);
});

it('brings down words that are above the view', () => {
  expect(adviceOffset({ ...frame, rowTop: -500, wordsTop: -100, wordsBottom: -40 })).toBe(-384);
});
