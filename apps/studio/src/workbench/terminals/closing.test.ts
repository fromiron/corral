import type { TerminalForeground, TerminalView } from '@corral/contracts';
import { expect, it, vi } from 'vitest';
import { closingTerminal } from './closing.ts';

// What closing a terminal's tab does (features/session-panel.md 터미널 탭): it reads the
// foreground afresh only for a running terminal, and asks unless that read says idle.

type State = TerminalView['state'];

async function decide(state: State, read: () => Promise<TerminalForeground>) {
  const reader = vi.fn(read);
  const action = await closingTerminal(state, reader);
  return { action, reads: reader.mock.calls.length };
}

it('a starting terminal ends without asking and without reading its foreground', async () => {
  expect(await decide('starting', async () => 'busy')).toEqual({ action: 'end', reads: 0 });
});

it('a running terminal ends without asking only when the fresh read says idle', async () => {
  expect(await decide('running', async () => 'idle')).toEqual({ action: 'end', reads: 1 });
  expect(await decide('running', async () => 'busy')).toEqual({ action: 'ask', reads: 1 });
  expect(await decide('running', async () => 'unknown')).toEqual({ action: 'ask', reads: 1 });
});

it('a running terminal whose foreground cannot be read asks', async () => {
  expect(
    await decide('running', async () => {
      throw new Error('unreadable');
    }),
  ).toEqual({ action: 'ask', reads: 1 });
});

it('a terminal whose end needs confirming is checked again without asking', async () => {
  expect(await decide('uncertain', async () => 'busy')).toEqual({ action: 'recheck', reads: 0 });
});

it.each(['stopping', 'exited', 'failed'] as const)(
  'a %s terminal only loses its tab: nothing is sent',
  async (state) => {
    expect(await decide(state, async () => 'busy')).toEqual({ action: 'close', reads: 0 });
  },
);
