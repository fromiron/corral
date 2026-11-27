// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useConfirmFocus } from './useConfirmFocus.ts';

function Row() {
  const [asking, setAsking] = useState(false);
  const focus = useConfirmFocus();
  return asking ? (
    <>
      <button type="button">Confirm delete</button>
      <button
        type="button"
        ref={focus.answer}
        onClick={() => {
          focus.cancelled();
          setAsking(false);
        }}
      >
        Cancel
      </button>
    </>
  ) : (
    <button type="button" ref={focus.opener} onClick={() => setAsking(true)}>
      Delete
    </button>
  );
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

it('gives the focus to the safe answer when the question replaces its button, and back on cancel', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<Row />));
  expect(document.activeElement).toBe(document.body);
  await act(async () => container.querySelector('button')?.click());
  expect(document.activeElement?.textContent).toBe('Cancel');
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(document.activeElement?.textContent).toBe('Delete');
});
