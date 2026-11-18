import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunActions } from '../src/components/RunActions.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import {
  askCancelConfirmation,
  discardCancelConfirmation,
} from '../src/run/cancel-confirmation.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

beforeEach(() => sessionStorage.clear());

const mount = (
  runId: string,
  status: 'running' | 'cancelled' = 'running',
  /** The run tab head's bar: the confirmation opens in a popover beside the stop. */
  head = false,
) => {
  const sendCommand = vi.fn(async () => ({ status: 'applied' }) as never);
  const session = sessionStore({
    runId,
    projection: { ...projectionWith({}), runId, status },
    sendCommand,
  });
  return {
    ...render(
      <StrictMode>
        <IntlProvider locale="en" messages={messages}>
          <button type="button">Elsewhere</button>
          <RunActions session={session} compact={head} narrowIcons={head} />
        </IntlProvider>
      </StrictMode>,
    ),
    sendCommand,
  };
};

// The stop control and the confirmation's own button carry the same name; the confirmation is
// told by its line saying nothing has been sent yet (the popover's dialog holds that line too).
const notSent = /The stop has not been sent/;
const confirmation = (scope: HTMLElement = document.body) =>
  within(scope).queryByText(notSent)?.parentElement ?? null;
const confirmButton = (scope?: HTMLElement) => {
  const box = confirmation(scope);
  return box ? within(box).getByRole('button', { name: 'Stop the run' }) : null;
};
const stopControl = (scope: HTMLElement = document.body) => {
  const [control, ...more] = within(scope)
    .getAllByRole('button', { name: 'Stop the run' })
    .filter((button) => !confirmation(scope)?.contains(button));
  expect(more, 'one stop control').toEqual([]);
  return control as HTMLElement;
};
const keepRunning = (scope?: HTMLElement) => {
  const box = confirmation(scope);
  return box ? within(box).getByRole('button', { name: 'Keep running' }) : null;
};
/** Waits, a little at a time, until `check` holds: the popover places its focus a moment late. */
async function until(check: () => boolean) {
  for (let waited = 0; !check() && waited < 2000; waited += 10)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
const focusOnKeepRunning = () => document.activeElement === keepRunning();

it('restores a reload-persisted confirmation without sending it, including StrictMode remounts', async () => {
  sessionStorage.setItem('corral:cancel-confirmation:original', 'pending');
  const restored = mount('original');
  await act(async () => {});
  expect(screen.getByText(notSent)).toBeTruthy();
  expect(restored.sendCommand).not.toHaveBeenCalled();
  fireEvent.click(confirmButton() as HTMLElement);
  expect(restored.sendCommand).toHaveBeenCalledWith({
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
  });
});

it('leaving the controls abandons confirmation before a keyed Run view is mounted again', async () => {
  const first = mount('original');
  fireEvent.click(stopControl());
  first.unmount();
  await act(async () => {});
  const other = mount('other');
  expect(confirmation()).toBeNull();
  other.unmount();
  await act(async () => {});
  const returned = mount('original');
  expect(confirmation()).toBeNull();
  expect(first.sendCommand).not.toHaveBeenCalled();
  expect(returned.sendCommand).not.toHaveBeenCalled();
});

it('keep running and an ended run clear a pending confirmation', () => {
  let view = mount('finished');
  fireEvent.click(stopControl());
  fireEvent.click(keepRunning() as HTMLElement);
  view.unmount();
  view = mount('finished');
  expect(confirmation()).toBeNull();
  fireEvent.click(stopControl());
  view.unmount();
  view = mount('finished', 'cancelled');
  expect(confirmation()).toBeNull();
  view.unmount();
  mount('finished');
  expect(confirmation()).toBeNull();
});

it('confirmations in multiple surfaces clear together', () => {
  const first = mount('shared');
  const second = mount('shared');
  fireEvent.click(stopControl(first.container));
  expect(screen.getAllByRole('button', { name: 'Keep running' })).toHaveLength(2);
  fireEvent.click(keepRunning(second.container) as HTMLElement);
  expect(confirmation()).toBeNull();
  expect(first.sendCommand).not.toHaveBeenCalled();
  expect(second.sendCommand).not.toHaveBeenCalled();
});

it('asking and letting go from outside a holder show and clear its confirmation at once, sending nothing', async () => {
  const shown = mount('outside');
  await act(async () => {});
  expect(screen.queryByText(notSent)).toBeNull();
  act(() => askCancelConfirmation('outside'));
  expect(screen.getByText(notSent)).toBeTruthy();
  act(() => discardCancelConfirmation('outside'));
  expect(screen.queryByText(notSent)).toBeNull();
  expect(sessionStorage.getItem('corral:cancel-confirmation:outside')).toBeNull();
  expect(shown.sendCommand).not.toHaveBeenCalled();
});

// execution-monitor.md: wherever the confirmation asks, the first focus is on Keep running. The
// block is asked here by its own stop; the popover also by a stop command (`/stop`, the palette,
// the shortcut).
describe.each([
  ['the run screen’s block', false, ['stop']],
  ['the run tab head’s popover', true, ['stop', 'command']],
] as const)('%s', (_where, head, ways) => {
  /** Asks as the person does: the stop control, or a command given elsewhere (`/stop`, …). */
  const ask = async (runId: string, way: 'stop' | 'command') => {
    if (way === 'stop') await userEvent.setup().click(stopControl());
    else act(() => askCancelConfirmation(runId));
    await act(async () => {});
  };

  it.each(ways)(
    'puts the first focus on Keep running when asked by %s, before Stop the run',
    async (way) => {
      const view = mount('asked', 'running', head);
      screen.getByRole('button', { name: 'Elsewhere' }).focus();
      await ask('asked', way);
      await until(focusOnKeepRunning);
      expect(document.activeElement).toBe(keepRunning());
      const box = confirmation() as HTMLElement;
      expect(
        within(box)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Keep running', 'Stop the run']);
      expect(view.sendCommand).not.toHaveBeenCalled();
    },
  );

  it('keeps the run on Enter where the focus lands, and Stop the run is one Tab away', async () => {
    const view = mount('keys', 'running', head);
    const user = userEvent.setup();
    await ask('keys', 'stop');
    await until(focusOnKeepRunning);
    expect(document.activeElement).toBe(keepRunning());
    await user.keyboard('{Enter}');
    await until(() => confirmation() === null);
    expect(confirmation()).toBeNull();
    expect(view.sendCommand).not.toHaveBeenCalled();

    await ask('keys', 'stop');
    await until(focusOnKeepRunning);
    await user.tab();
    expect(document.activeElement).toBe(confirmButton());
    expect(view.sendCommand).not.toHaveBeenCalled();
  });
});

it('a confirmation that comes back after a reload leaves the focus in place on the run screen and puts it on Keep running in the run tab head', async () => {
  sessionStorage.setItem('corral:cancel-confirmation:block', 'pending');
  const block = mount('block');
  // Given the time the popover takes to place its focus, nothing moves it here.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(confirmation()).not.toBeNull();
  expect(document.activeElement).toBe(document.body);
  block.unmount();
  await act(async () => {});

  sessionStorage.setItem('corral:cancel-confirmation:head', 'pending');
  mount('head', 'running', true);
  await act(async () => {});
  expect(confirmation()).not.toBeNull();
  await until(focusOnKeepRunning);
  expect(document.activeElement).toBe(keepRunning());
});
