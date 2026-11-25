// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  keepUnsentAnswer,
  settleUnsentAnswer,
} from '../../../../../packages/react/src/run/unsentAnswers.ts';
import { readComposerDraft } from '../../workbench/sessionDraft.ts';
import {
  createShellWorld,
  mountShell,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// features/composer-flow.md 대기 요청과 넘겨받기: a question's unsent text joins the request box of
// its own conversation when that box is open, and that conversation's stored draft otherwise;
// another conversation's open box is left as it is.

vi.setConfig({ testTimeout: 20_000 });

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  cleanups.push(stubBrowser());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const box = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]');

async function type(text: string) {
  const input = box();
  expect(input, 'the request box is on screen').toBeTruthy();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    set?.call(input, text);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** A question card's text handed over as a closed question hands it. */
async function carry(sessionId: string, text: string) {
  const store = { getState: () => ({}) } as never;
  keepUnsentAnswer(store, 'ask_1', sessionId, { q: text });
  await act(async () => settleUnsentAnswer(store, 'ask_1', 'closed'));
  await settle();
}

it('joins the open box of its own conversation after a blank line, and leaves another conversation’s box alone', async () => {
  const world = await createShellWorld();
  const other = await world.createConversation('Other');
  const shell = await mountShell(world, [`/sessions/${world.sessionId}`], { width: WIDE });
  cleanups.push(() => shell.unmount());
  await settle();
  await type('Check the login');

  await carry(world.sessionId, 'Use staging');
  expect(box()?.value).toBe('Check the login\n\nUse staging');

  await carry(other, 'Port 5179');
  expect(box()?.value).toBe('Check the login\n\nUse staging');
  expect(readComposerDraft(other).text).toBe('Port 5179');
});
