// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunViews } from './RunViews.tsx';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('waits for a hidden workspace to have size, then preserves the initialized view on return', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let width = 0;
  let height = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  const observers = new Set<() => void>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      update: () => void;
      constructor(update: () => void) {
        this.update = update;
      }
      observe() {
        observers.add(this.update);
      }
      unobserve() {
        observers.delete(this.update);
      }
      disconnect() {
        observers.delete(this.update);
      }
    },
  );
  let mounts = 0;
  function Graph() {
    const [zoom, setZoom] = useState(() => {
      mounts++;
      return 1;
    });
    return (
      <button type="button" onClick={() => setZoom(zoom + 1)}>
        Zoom {zoom}
      </button>
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (visible: boolean) => {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RunViews
            visible={visible}
            views={[{ id: 'graph', label: 'Graph', render: () => <Graph /> }]}
          />
        </IntlProvider>,
      ),
    );
  };
  await render(true);
  expect(mounts).toBe(0);
  width = 1200;
  height = 600;
  await act(async () => {
    for (const notify of observers) notify();
  });
  expect(mounts).toBe(1);
  const graph = [...container.querySelectorAll('button')].find((el) => el.textContent === 'Zoom 1');
  expect(graph).toBeDefined();
  await act(async () => graph?.click());
  width = 0;
  height = 0;
  await render(false);
  expect(graph?.isConnected).toBe(true);
  width = 1200;
  height = 600;
  await render(true);
  expect(mounts).toBe(1);
  expect(graph?.textContent).toBe('Zoom 2');
});
