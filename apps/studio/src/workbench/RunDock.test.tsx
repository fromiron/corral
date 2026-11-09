// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunDock } from './RunDock.tsx';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function EventSelection() {
  const [selected, setSelected] = useState(false);
  return (
    <button type="button" aria-pressed={selected} onClick={() => setSelected(!selected)}>
      Recorded event
    </button>
  );
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (count: number) => {
    const views = [
      { id: 'flow', label: 'Work flow', render: () => <p>Observed relationships</p> },
      { id: 'events', label: `Events ${count}`, render: () => <EventSelection /> },
    ];
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RunDock idPrefix="dock" views={views} />
        </IntlProvider>,
      );
    });
  };
  await render(10);
  return { container, render };
}

it('keeps the selected event and tab focus when its displayed event count changes', async () => {
  const { container, render } = await mount();
  const tab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
  if (!tab) throw new Error('The Events tab must exist');
  await act(async () => tab.click());
  const event = container.querySelector<HTMLButtonElement>('[aria-pressed]');
  if (!event) throw new Error('An event must be selectable');
  await act(async () => event.click());
  await act(async () => tab.focus());
  await render(11);
  expect(container.querySelector('[aria-pressed]')).toBe(event);
  expect(event.getAttribute('aria-pressed')).toBe('true');
  expect(tab.isConnected).toBe(true);
  expect(tab.textContent).toContain('Events 11');
  expect(document.activeElement).toBe(tab);
  expect(tab.getAttribute('aria-selected')).toBe('true');
});

it('initializes views on first opening and keeps them mounted when folded', async () => {
  const { container } = await mount();
  expect(container.querySelector('[aria-pressed]')).toBeNull();
  const tab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
  if (!tab) throw new Error('The Events tab must exist');
  await act(async () => tab.click());
  const event = container.querySelector('[aria-pressed]');
  expect(event).not.toBeNull();
  await act(async () => tab.click());
  expect(container.querySelector('[aria-pressed]')).toBe(event);
  expect(container.querySelector<HTMLElement>('[data-run-dock-content]')?.hidden).toBe(true);
});
