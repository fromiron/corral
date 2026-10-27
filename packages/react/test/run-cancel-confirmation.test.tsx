import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import { RunActions } from '../src/components/RunActions.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

beforeEach(() => sessionStorage.clear());

const mount = (runId: string, status: 'running' | 'cancelled' = 'running') => {
  const sendCommand = vi.fn(async () => ({ status: 'applied' }) as never);
  const session = sessionStore({
    runId,
    projection: { ...projectionWith({}), runId, status },
    sendCommand,
  });
  return {
    ...render(
      <IntlProvider locale="en" messages={messages}>
        <RunActions session={session} />
      </IntlProvider>,
    ),
    sendCommand,
  };
};

it('retains an unconfirmed cancellation after remount without sending it or changing its run', () => {
  const first = mount('original');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel whole run' }));
  expect(first.sendCommand).not.toHaveBeenCalled();
  first.unmount();
  const other = mount('other');
  expect(screen.queryByRole('button', { name: 'Confirm whole run cancellation' })).toBeNull();
  other.unmount();
  const restored = mount('original');
  expect(screen.getByText(/Cancellation has not been sent/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm whole run cancellation' }));
  expect(restored.sendCommand).toHaveBeenCalledWith({
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
  });
});

it('keep running and an ended run clear a pending confirmation', () => {
  let view = mount('finished');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel whole run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
  view.unmount();
  view = mount('finished');
  expect(screen.queryByRole('button', { name: 'Confirm whole run cancellation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel whole run' }));
  view.unmount();
  view = mount('finished', 'cancelled');
  expect(screen.queryByRole('button', { name: 'Confirm whole run cancellation' })).toBeNull();
  view.unmount();
  mount('finished');
  expect(screen.queryByRole('button', { name: 'Confirm whole run cancellation' })).toBeNull();
});

it('confirmations in multiple surfaces clear together', () => {
  const first = mount('shared');
  const second = mount('shared');
  fireEvent.click(first.container.querySelectorAll('button')[1] as HTMLButtonElement);
  expect(screen.getAllByRole('button', { name: 'Keep running' })).toHaveLength(2);
  fireEvent.click(second.container.querySelectorAll('button')[3] as HTMLButtonElement);
  expect(screen.queryByRole('button', { name: 'Confirm whole run cancellation' })).toBeNull();
});
