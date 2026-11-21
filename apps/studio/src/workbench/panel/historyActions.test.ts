import { expect, it, vi } from 'vitest';
import { navigateFromOutside, outsideEntryState } from './historyActions.ts';

it('an address from outside carries the flag alone, never the frame mark or other entry state', () => {
  expect(outsideEntryState()).toEqual({ corralEntry: 'outside' });
});

it('the OS notification goes to its address with that state and nothing else', async () => {
  const navigate = vi.fn(async () => {});
  await navigateFromOutside(navigate, '/sessions/s?panel=run&run=r&respond=true');
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    to: '/sessions/s?panel=run&run=r&respond=true',
    state: { corralEntry: 'outside' },
  });
});
